#include "DeviceStore.h"

namespace {
// NVS keys are capped at 15 characters, which is why these are abbreviated rather than spelled out.
constexpr const char* kNamespace = "agentctl";
constexpr const char* kKeyDeviceId = "dev_id";
constexpr const char* kKeyDeviceSecret = "dev_secret";
constexpr const char* kKeyGatewayUrl = "gw_url";
constexpr const char* kKeyWifiSsid = "wifi_ssid";
constexpr const char* kKeyWifiPass = "wifi_pass";
constexpr const char* kKeyClaimCode = "claim_code";
constexpr const char* kKeyClaimExpiry = "claim_exp";
constexpr const char* kKeyConfigCache = "cfg_cache";
}  // namespace

bool DeviceStore::begin() {
  if (opened_) return true;
  if (!prefs_.begin(kNamespace, /*readOnly=*/false)) {
    Serial.println("[store] NVS namespace unavailable; check the partition table");
    return false;
  }
  opened_ = true;

  deviceId_ = readString(kKeyDeviceId);
  deviceSecret_ = readString(kKeyDeviceSecret);
  gatewayUrl_ = readString(kKeyGatewayUrl);
  wifiSsid_ = readString(kKeyWifiSsid);
  wifiPassword_ = readString(kKeyWifiPass);
  claimCode_ = readString(kKeyClaimCode);
  claimCodeExpiresAt_ = readString(kKeyClaimExpiry);
  configCache_ = readString(kKeyConfigCache);

  // The secret is never logged, not even truncated: this line ends up in bench transcripts.
  Serial.printf(
    "[store] id=%s gateway=%s wifi=%s claimCode=%s\n",
    deviceId_.length() ? deviceId_.c_str() : "(none)",
    gatewayUrl_.length() ? gatewayUrl_.c_str() : "(none)",
    wifiSsid_.length() ? wifiSsid_.c_str() : "(none)",
    claimCode_.length() ? "cached" : "(none)"
  );
  return true;
}

// Preferences::getString() logs an ESP_LOGE for every absent key. A factory-fresh unit is missing
// five of them by definition, so a perfectly healthy first boot printed five red error lines and
// read as a fault. Checking first keeps the log honest about what is actually wrong.
String DeviceStore::readString(const char* key) {
  if (!prefs_.isKey(key)) return String();
  return prefs_.getString(key, "");
}

bool DeviceStore::putString(const char* key, const String& value) {
  if (!opened_) return false;
  if (value.length() == 0) return prefs_.remove(key) || true;
  return prefs_.putString(key, value) > 0;
}

bool DeviceStore::setIdentity(const String& id, const String& secret) {
  if (!putString(kKeyDeviceId, id)) return false;
  if (!putString(kKeyDeviceSecret, secret)) return false;
  deviceId_ = id;
  deviceSecret_ = secret;
  return true;
}

bool DeviceStore::seedIdentityIfEmpty(const char* id, const char* secret, const char* gatewayUrl) {
  bool wrote = false;
  // Placeholder values from controller_config.example.h are treated as absent; writing
  // "dev_replace_me" to NVS would look provisioned and fail authentication forever.
  const bool idUsable = id != nullptr && strlen(id) > 0 && strstr(id, "replace_me") == nullptr;
  const bool secretUsable =
    secret != nullptr && strlen(secret) > 0 && strstr(secret, "replace_me") == nullptr;

  if (!hasIdentity() && idUsable && secretUsable) {
    Serial.println("[store] seeding identity from build-time config (bench path)");
    wrote = setIdentity(String(id), String(secret)) || wrote;
  }
  if (gatewayUrl_.length() == 0 && gatewayUrl != nullptr && strlen(gatewayUrl) > 0) {
    wrote = setGatewayUrl(String(gatewayUrl)) || wrote;
  }
  return wrote;
}

bool DeviceStore::setGatewayUrl(const String& url) {
  String trimmed = url;
  trimmed.trim();
  while (trimmed.endsWith("/")) trimmed.remove(trimmed.length() - 1);
  if (!putString(kKeyGatewayUrl, trimmed)) return false;
  gatewayUrl_ = trimmed;
  return true;
}

bool DeviceStore::setWifiCredentials(const String& ssid, const String& password) {
  if (!putString(kKeyWifiSsid, ssid)) return false;
  if (!putString(kKeyWifiPass, password)) return false;
  wifiSsid_ = ssid;
  wifiPassword_ = password;
  return true;
}

bool DeviceStore::setClaimCode(const String& code, const String& expiresAt) {
  if (!putString(kKeyClaimCode, code)) return false;
  if (!putString(kKeyClaimExpiry, expiresAt)) return false;
  claimCode_ = code;
  claimCodeExpiresAt_ = expiresAt;
  return true;
}

bool DeviceStore::clearClaimCode() {
  return setClaimCode("", "");
}

bool DeviceStore::setConfigCache(const String& json) {
  if (!putString(kKeyConfigCache, json)) return false;
  configCache_ = json;
  return true;
}

bool DeviceStore::resetForProvisioning() {
  Serial.println("[store] reset: clearing Wi-Fi, config cache, and claim code; identity kept");
  const bool wifiCleared = setWifiCredentials("", "");
  const bool cacheCleared = setConfigCache("");
  const bool codeCleared = clearClaimCode();
  return wifiCleared && cacheCleared && codeCleared;
}

bool DeviceStore::wipeToFactoryState() {
  Serial.println("[store] full wipe: Wi-Fi, config cache, claim code, gateway URL; identity kept");
  const bool reset = resetForProvisioning();
  // Cleared rather than rewritten: seedIdentityIfEmpty() puts the build-time default back on the
  // next boot, so a unit whose owner pointed it at a private gateway returns to the factory one.
  const bool gatewayCleared = setGatewayUrl("");
  return reset && gatewayCleared;
}
