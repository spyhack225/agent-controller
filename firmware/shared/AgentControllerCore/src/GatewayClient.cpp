#include "GatewayClient.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

namespace {
constexpr uint32_t kHeartbeatIntervalMs = 10000;
// A cached code is the normal answer, so this only bounds how often an UNCACHED device asks.
constexpr uint32_t kSetupCodeIntervalMs = 15000;
constexpr uint16_t kTimeoutMs = 5000;
}  // namespace

const char* gatewayLinkName(GatewayLink link) {
  switch (link) {
    case GatewayLink::Unclaimed:   return "unclaimed";
    case GatewayLink::Claimed:     return "claimed";
    case GatewayLink::AuthFailed:  return "auth-failed";
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
  http.end();
  return code;
}

void GatewayClient::sendHeartbeat() {
  JsonDocument doc;
  doc["hardwareModel"] = hardwareModel_;
  doc["firmwareVersion"] = firmwareVersion_;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/heartbeat", body, response);

  if (code >= 200 && code < 300) {
    if (link_ != GatewayLink::Claimed) {
      justClaimed_ = true;
      Serial.println("[gateway] claimed — this controller now has an owner");
    }
    link_ = GatewayLink::Claimed;
    detail_ = "";
    // The code is spent. Keeping it would show a stale claim screen after a factory reset.
    if (claimCode_.length() > 0) {
      claimCode_ = "";
      store_->clearClaimCode();
    }
    return;
  }

  if (code == 403) {
    // Not an error: 403 is how the gateway says "authenticated, but nobody owns you". This is the
    // normal state of a brand-new unit and the entry point to the whole claim flow.
    link_ = GatewayLink::Unclaimed;
    fetchSetupCode(false);
    return;
  }

  if (code == 401) {
    link_ = GatewayLink::AuthFailed;
    detail_ = "Credentials rejected";
    return;
  }

  link_ = GatewayLink::Unreachable;
  detail_ = code > 0 ? String("HTTP ") + code : String("No response");
}

void GatewayClient::fetchSetupCode(bool rotate) {
  // Safe to call on every 403 when not rotating: the gateway answers "the existing code is still
  // valid" and returns nothing, so the code already on screen — or printed on the box — survives.
  if (!rotate && claimCode_.length() > 0) return;
  if (!rotate && millis() < nextSetupCodeAt_) return;
  nextSetupCodeAt_ = millis() + kSetupCodeIntervalMs;

  String response;
  const String body = rotate ? "{\"rotate\":true}" : "{\"rotate\":false}";
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

void GatewayClient::poll() {
  if (!store_ || WiFi.status() != WL_CONNECTED) {
    link_ = GatewayLink::Idle;
    return;
  }
  if (!store_->hasIdentity()) {
    // No factory identity. Nothing here can recover that — it is flashed once at manufacture — so
    // say so rather than retrying an unauthenticated request forever.
    link_ = GatewayLink::AuthFailed;
    detail_ = "No device identity";
    return;
  }
  if (millis() < nextHeartbeatAt_) return;
  nextHeartbeatAt_ = millis() + kHeartbeatIntervalMs;
  sendHeartbeat();
}

bool GatewayClient::consumeJustClaimed() {
  const bool value = justClaimed_;
  justClaimed_ = false;
  return value;
}
