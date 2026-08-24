#include "GatewayClient.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

namespace {
// The reference firmware's cadences. A heartbeat is cheap and proves liveness; config changes
// rarely; and a claim code is deliberately slow to re-request because rotating one invalidates the
// code the owner is currently reading off the screen.
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kConfigIntervalMs = 60000;
constexpr uint32_t kSetupCodeIntervalMs = 10UL * 60UL * 1000UL;
constexpr uint16_t kTimeoutMs = 5000;
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
}

int GatewayClient::request(const char* method, const char* path, const String& body,
                           String& response) {
  if (!store_) return -1;
  String base = store_->gatewayUrl();
  if (base.length() == 0) return -1;

  const String url = base + path;
  HTTPClient http;
  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  bool began = false;
  WiFiClientSecure secure;
  WiFiClient plain;
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

  const int code = String(method) == "POST" ? http.POST(body) : http.GET();
  if (code > 0) response = http.getString();

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
    }
    link_ = GatewayLink::Claimed;
    detail_ = "";
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
  if (millis() < backoffUntil_) return;

  const uint32_t now = millis();
  if (justConnected) {
    if (link_ == GatewayLink::Idle) link_ = GatewayLink::Connecting;
    nextHeartbeatAt_ = now + kHeartbeatIntervalMs;
    nextConfigAt_ = now + kConfigIntervalMs;
    sendHeartbeat();
    fetchConfig();
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
  }
}

bool GatewayClient::consumeJustClaimed() {
  const bool value = justClaimed_;
  justClaimed_ = false;
  return value;
}
