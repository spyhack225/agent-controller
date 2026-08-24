#include "GatewayClient.h"


#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <WiFiClientSecure.h>

namespace {
// The reference firmware's cadences. A heartbeat is cheap and proves liveness; config changes
// rarely; and a claim code is deliberately slow to re-request because rotating one invalidates the
// code the owner is currently reading off the screen.
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kConfigIntervalMs = 60000;
constexpr uint32_t kSetupCodeIntervalMs = 10UL * 60UL * 1000UL;
// Bounds the worst-case render stall, because this call sits on the render loop until the client
// can publish under a lock instead of holding one across its request. A local gateway answers in
// tens of milliseconds; anything slower than this is a gateway that is not going to answer usefully
// inside a frame budget anyway, and waiting longer only freezes the animation for longer.
constexpr uint16_t kTimeoutMs = 1200;

// Operate cadences. The display poll dominates the request budget (12/min against a device-read
// limit of 120/min), which is what leaves room for the gesture-driven calls a person makes.
constexpr uint32_t kDisplayIntervalMs = 5000;
constexpr uint32_t kControlsIntervalMs = 30000;
// The reference firmware never polled approvals — its only signal was a dispatch answering
// `approval_required`, so a command parked by policy afterwards was invisible until someone opened
// the console. On a screen that can show a queue, that is worth two requests a minute.
constexpr uint32_t kApprovalsIntervalMs = 30000;
}  // namespace

const char* gatewayLinkName(GatewayLink link) {
  switch (link) {
    case GatewayLink::NoIdentity:  return "no-identity";
    case GatewayLink::Connecting:  return "connecting";
    case GatewayLink::Unclaimed:   return "unclaimed";
    case GatewayLink::Claimed:     return "claimed";
    case GatewayLink::Revoked:     return "revoked";
    case GatewayLink::Unreachable: return "unreachable";
    default: return "idle";
  }
}

void GatewayClient::begin(DeviceStore& store, const String& hardwareModel,
                          const String& firmwareVersion) {
  store_ = &store;
  hardwareModel_ = hardwareModel;
  firmwareVersion_ = firmwareVersion;
  // A code cached from a previous boot is shown immediately, so a unit that has been sitting
  // unclaimed does not blank its screen while it waits for the first request to come back.
  claimCode_ = store.claimCode();
  // Same reasoning for the execution context: a boot with no gateway still knows which thread it
  // was driving, so the first frame is the real screen rather than a placeholder.
  if (store.configCache().length() > 0) applyConfigJson(store.configCache());
}

void GatewayClient::setCapabilities(bool microphone, bool camera) {
  hasMicrophone_ = microphone;
  hasCamera_ = camera;
}

void GatewayClient::setLimits(const GatewayLimits& limits) {
  limits_ = limits;
  if (limits_.menuItems > kMaxDeviceControls) limits_.menuItems = kMaxDeviceControls;
  if (limits_.threadItems > kMaxThreadOptions) limits_.threadItems = kMaxThreadOptions;
}

int GatewayClient::request(const char* method, const char* path, const String& body,
                           String& response) {
  if (!store_) return -1;
  String base = store_->gatewayUrl();
  if (base.length() == 0) return -1;

  // One global gate, checked here rather than in runCycle() alone, because the operate surface is
  // driven by a person pressing things: without it a rate-limited gateway would still be hit once
  // per touch. Answering 429 locally costs no socket and keeps the caller's error path identical.
  if (backoffUntil_ != 0 && (int32_t)(millis() - backoffUntil_) < 0) {
    response = "rate limited locally";
    return 429;
  }

  const String url = base + path;

  // Declaration order is load-bearing, not style.
  //
  // C++ destroys locals in reverse declaration order, and HTTPClient keeps a reference to the
  // client it was handed. With HTTPClient declared first it is destroyed LAST — after the client it
  // points at — so ~HTTPClient() calls stop() on freed memory. That crashed as
  // InstrFetchProhibited at PC 0xfffffffd (a call through a dead vtable), and corrupted the lwIP
  // TCP heap on the way out, which surfaced later as pbuf_free/tcp_seg_free panics in the tcpip
  // thread. The device was rebooting roughly twice a minute.
  //
  // Clients first, HTTPClient last: it dies first, while what it points at is still alive.
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  bool began = false;
  if (url.startsWith("https://")) {
    secure.setInsecure();   // pin the gateway certificate before production
    began = http.begin(secure, url);
  } else {
    began = http.begin(plain, url);
  }
  if (!began) return -1;

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());
  // HTTPClient discards every response header it was not told to keep, so without this the
  // retry-after read below always parsed an empty string and every 429 backed off for the 1 s
  // floor instead of the interval the gateway asked for.
  const char* kCollected[] = {"retry-after"};
  http.collectHeaders(kCollected, 1);

  const int code = String(method) == "POST" ? http.POST(body) : http.GET();
  if (code > 0) {
    // A device-facing body larger than this is a bug or an attack, never a payload — the biggest
    // real one is a twelve-row thread list. Reading it into a String first and rejecting afterwards
    // would already have spent the heap this guard exists to protect.
    const int length = http.getSize();
    if (length > (int)kMaxResponseBodyBytes) {
      Serial.printf("[gateway] %s oversized response %d bytes\n", path, length);
      response = "response too large";
    } else {
      response = http.getString();
    }
  }

  // 401 means the credential itself was rejected — the owner revoked this device, or it was
  // transfer-reset. No amount of retrying fixes that, so it is recorded here, once, rather than
  // being re-derived at every call site.
  if (code == 401) revoked_ = true;
  else if (code >= 200 && code < 300) revoked_ = false;

  // A rate-limited gateway is telling us exactly how long to wait; ignoring it turns one 429 into
  // a storm.
  if (code == 429) {
    const int retryAfter = http.header("retry-after").toInt();
    backoffUntil_ = millis() + (uint32_t)max(1, retryAfter) * 1000UL;
  }

  http.end();
  return code;
}

void GatewayClient::sendHeartbeat() {
  JsonDocument doc;
  doc["protocolVersion"] = 2;
  doc["hardwareModel"] = hardwareModel_;
  doc["firmwareVersion"] = firmwareVersion_;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptimeMs"] = millis();

  // Features gate which controls the gateway is willing to assign: it will not put a capture action
  // on a board that never claimed a microphone.
  JsonArray features = doc["features"].to<JsonArray>();
  features.add("display");
  features.add("thread_picker");
  if (hasMicrophone_) features.add("microphone");
  if (hasCamera_) features.add("camera");

  // Limits are how the gateway knows what to wrap and truncate to. They are declared, not
  // negotiated — send the wrong numbers and the text comes back clipped.
  JsonObject limits = doc["limits"].to<JsonObject>();
  limits["menuItems"] = limits_.menuItems;
  limits["threadItems"] = limits_.threadItems;
  limits["labelCharacters"] = limits_.labelCharacters;
  if (limits_.mediaUploadBytes > 0) limits["mediaUploadBytes"] = limits_.mediaUploadBytes;

  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/heartbeat", body, response);
  if (code > 0 && (code < 200 || code >= 300)) {
    Serial.printf("[gateway] heartbeat %d\n", code);
  }
  if (code <= 0) {
    link_ = GatewayLink::Unreachable;
    detail_ = "No response";
  }
}

// Claim state is discovered HERE, not from the heartbeat.
//
// The gateway answers 403 on the owned resources — config and display — while a device is
// authenticated but unowned. The heartbeat is a liveness signal and deliberately does not decide
// this, which matters because a revoked device must keep heartbeating so its owner can see it is
// still alive.
void GatewayClient::fetchConfig() {
  String response;
  const int code = request("GET", "/v1/device/config", "", response);

  if (code >= 200 && code < 300) {
    if (link_ != GatewayLink::Claimed) {
      justClaimed_ = true;
      Serial.println("[gateway] claimed — this controller now has an owner");
      // A device that has just been claimed has no controls, no display state, and no approval
      // queue. Making all three due now is what turns the claim screen into a working screen
      // within a few passes instead of within a controls interval.
      markOperateDue(millis());
    }
    link_ = GatewayLink::Claimed;
    detail_ = "";
    // Cached only once it has parsed. A body that failed the size guard still arrives with a 200,
    // and writing that to NVS would make the next boot render garbage before the first poll.
    if (applyConfigJson(response)) store_->setConfigCache(response);
    // The code is spent. Keeping it would show a stale claim screen after a transfer reset.
    if (claimCode_.length() > 0) {
      claimCode_ = "";
      store_->clearClaimCode();
    }
    return;
  }

  if (code == 403) {
    link_ = GatewayLink::Unclaimed;
    detail_ = "";
    fetchSetupCode(false);
    return;
  }

  if (code == 401) {
    link_ = GatewayLink::Revoked;
    detail_ = "Credential rejected";
    return;
  }

  link_ = GatewayLink::Unreachable;
  detail_ = code > 0 ? String("HTTP ") + code : String("No response");
}

void GatewayClient::fetchSetupCode(bool rotate) {
  // A cached code short-circuits: the gateway answers "the existing code is still valid" and
  // returns nothing, so re-asking would only cost a request.
  if (!rotate && claimCode_.length() > 0) return;
  if (millis() < nextSetupCodeAt_) return;
  nextSetupCodeAt_ = millis() + kSetupCodeIntervalMs;

  // No cached code and the device is unowned: ROTATE to obtain one.
  //
  // The stable-code rule exists to protect a code printed on a box before the owner ever reads it.
  // This product has no printed code — the device's own screen is the only place it is ever shown —
  // so a unit with nothing cached has no code in the world, and refusing to mint one strands it
  // saying "use the code on the box" about a box that does not exist.
  const bool mustRotate = rotate || claimCode_.length() == 0;

  String response;
  const String body = mustRotate ? "{\"rotate\":true}" : "{\"rotate\":false}";
  const int code = request("POST", "/v1/device/setup-code", body, response);
  if (code < 200 || code >= 300) {
    Serial.printf("[gateway] setup-code failed: %d\n", code);
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) return;

  JsonObject setup = doc["setup"];
  if (setup["claimed"] | false) {
    claimCode_ = "";
    store_->clearClaimCode();
    return;
  }

  const char* issued = setup["claimCode"] | doc["claimCode"] | "";
  const char* expires = setup["claimCodeExpiresAt"] | doc["claimCodeExpiresAt"] | "";
  // The plaintext comes back exactly once, at issue, because the gateway stores only its hash.
  // Persisting it here is what lets the endpoint stop rotating on every call — and what keeps the
  // code on the box agreeing with the code on the screen.
  if (strlen(issued) > 0) {
    claimCode_ = issued;
    store_->setClaimCode(claimCode_, String(expires));
    Serial.printf("[gateway] claim code %s (expires %s)\n", issued, expires);
  }
}

void GatewayClient::requestNewClaimCode() {
  if (!store_ || WiFi.status() != WL_CONNECTED) return;
  claimCode_ = "";
  store_->clearClaimCode();
  nextSetupCodeAt_ = 0;
  fetchSetupCode(true);
}

void GatewayClient::goOffline() {
  // The portal owns the screen while offline, and polling here would only stack up failures.
  if (link_ != GatewayLink::NoIdentity) link_ = GatewayLink::Idle;
}

bool GatewayClient::tryLockState(uint32_t waitMs) {
  if (!stateMutex_) return true;   // task not started yet: single-threaded, nothing to guard
  return xSemaphoreTakeRecursive((SemaphoreHandle_t)stateMutex_, pdMS_TO_TICKS(waitMs)) == pdTRUE;
}

void GatewayClient::unlockState() {
  if (stateMutex_) xSemaphoreGiveRecursive((SemaphoreHandle_t)stateMutex_);
}

namespace {
}  // namespace


void GatewayClient::runCycle(bool justConnected) {
  if (!store_) return;
  if (!store_->hasIdentity()) {
    // Terminal. Identity is written at manufacture and the owner cannot supply one, so say so
    // instead of looping on 401s.
    link_ = GatewayLink::NoIdentity;
    detail_ = "Factory flash needed";
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    goOffline();
    return;
  }
  const uint32_t now = millis();
  if (backoffUntil_ != 0 && (int32_t)(now - backoffUntil_) < 0) return;

  if (justConnected) {
    if (link_ == GatewayLink::Idle) link_ = GatewayLink::Connecting;
    nextHeartbeatAt_ = now + kHeartbeatIntervalMs;
    nextConfigAt_ = now + kConfigIntervalMs;
    sendHeartbeat();
    fetchConfig();
    // Deliberately not fetched here. The reference firmware ran the whole sequence in one burst on
    // the just-connected edge; marking them due instead spreads the same work across the next few
    // passes and keeps the one-request-per-call rule true on every path, including this one.
    markOperateDue(now);
    return;
  }

  // One request per call, heartbeat first: it is the cheaper of the two and the one that proves the
  // device is alive even when it is revoked and nothing else will answer.
  if ((int32_t)(now - nextHeartbeatAt_) >= 0) {
    nextHeartbeatAt_ = now + kHeartbeatIntervalMs;
    sendHeartbeat();
    if (revoked_) {
      link_ = GatewayLink::Revoked;
      detail_ = "Credential rejected";
    }
    return;
  }

  // A revoked device keeps heartbeating — that is how its owner sees it is still there after a
  // transfer reset — but there is nothing else worth asking for.
  if (revoked_) return;

  if ((int32_t)(now - nextConfigAt_) >= 0) {
    nextConfigAt_ = now + kConfigIntervalMs;
    fetchConfig();
    return;
  }

  // Nothing below is answerable while the device is unowned — the gateway returns 403 on every
  // owned resource — so an unclaimed unit sits on heartbeat plus config and nothing else.
  if (link_ != GatewayLink::Claimed) return;

  if ((int32_t)(now - nextControlsAt_) >= 0) {
    nextControlsAt_ = now + kControlsIntervalMs;
    fetchControls();
    return;
  }

  if ((int32_t)(now - nextApprovalsAt_) >= 0) {
    nextApprovalsAt_ = now + kApprovalsIntervalMs;
    refreshApprovals();
    return;
  }

  if ((int32_t)(now - nextDisplayAt_) >= 0) {
    nextDisplayAt_ = now + kDisplayIntervalMs;
    // An open, unfinished response takes the display slot rather than adding a request to it. This
    // is the whole turn-completion poll: `waiting` or `streaming` means the assistant has not
    // finished, and any other state stops it.
    if (responseOpen_ && responseInFlight()) {
      fetchResponsePage(response_.page);
    } else {
      fetchDisplay();
    }
  }
}

void GatewayClient::markOperateDue(uint32_t now) {
  nextDisplayAt_ = now;
  nextControlsAt_ = now;
  nextApprovalsAt_ = now;
}

bool GatewayClient::consumeJustClaimed() {
  const bool value = justClaimed_;
  justClaimed_ = false;
  return value;
}
