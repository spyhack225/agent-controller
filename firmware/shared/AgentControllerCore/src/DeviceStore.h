#pragma once

// Writable device state, in NVS.
//
// Everything here used to be a compile-time `#define`, which is what made a shipped unit
// unrecoverable: the factory cannot know the customer's Wi-Fi network, a rotated secret could never
// reach the device, and a wrong password meant a USB reflash. Values that genuinely are fixed at
// build time — the pin map, hardware model, firmware version, OTA verify key — stay as macros.
//
// NVS namespace `agentctl`. On production units this partition should be covered by flash
// encryption: without it `esptool read_flash` recovers both the Wi-Fi password and the device
// secret. See docs/production-security.md.

#include <Arduino.h>
#include <Preferences.h>

class DeviceStore {
 public:
  // Opens the namespace and caches every value in RAM. Returns false if NVS is unavailable, which
  // on this hardware means the partition table is wrong — callers should treat it as fatal.
  bool begin();

  // --- Identity. Written once by the factory flashing station, never by the owner. ---
  const String& deviceId() const { return deviceId_; }
  const String& deviceSecret() const { return deviceSecret_; }
  bool hasIdentity() const { return deviceId_.length() > 0 && deviceSecret_.length() > 0; }
  bool setIdentity(const String& id, const String& secret);

  // Seeds identity and gateway URL from compile-time values only when NVS holds none. This is the
  // bench path — it lets a developer flash controller_config.h values without an NVS partition —
  // and deliberately never overwrites a provisioned unit.
  bool seedIdentityIfEmpty(const char* id, const char* secret, const char* gatewayUrl);

  // --- Gateway. Factory default, changeable at runtime by the owner via the portal. ---
  const String& gatewayUrl() const { return gatewayUrl_; }
  bool setGatewayUrl(const String& url);

  // --- Wi-Fi. Written by the owner during provisioning. ---
  const String& wifiSsid() const { return wifiSsid_; }
  const String& wifiPassword() const { return wifiPassword_; }
  bool hasWifiCredentials() const { return wifiSsid_.length() > 0; }
  bool setWifiCredentials(const String& ssid, const String& password);

  // --- Claim code cache. ---
  //
  // The gateway stores claim codes hashed, so it can hand back the plaintext exactly once, at
  // issue. The device caching it here is what lets `POST /v1/device/setup-code` stop rotating on
  // every call — and therefore what makes the code printed on the box agree with the code on screen.
  const String& claimCode() const { return claimCode_; }
  const String& claimCodeExpiresAt() const { return claimCodeExpiresAt_; }
  bool hasClaimCode() const { return claimCode_.length() > 0; }
  bool setClaimCode(const String& code, const String& expiresAt);
  bool clearClaimCode();

  // --- Runtime config cache, so a boot with no gateway still renders something useful. ---
  const String& configCache() const { return configCache_; }
  bool setConfigCache(const String& json);

  // Wipes Wi-Fi credentials, the config cache, and the cached claim code, and keeps the device
  // identity. This is the long-press reset: the recovery path for a revoked device, a moved
  // household, or a resale. Identity survives because the unit is still the same unit; the gateway
  // side of a transfer is `resetDeviceForTransfer`.
  bool resetForProvisioning();

  // Everything resetForProvisioning() clears, plus any owner-set gateway URL, returning the unit to
  // the state it left the factory in. seedIdentityIfEmpty() restores the build-time gateway default
  // on the next boot, so clearing it here is recoverable rather than a dead end.
  //
  // Identity is deliberately NOT cleared. The device id and secret are written once at manufacture;
  // erasing them leaves a unit that cannot authenticate and cannot be recovered without a flashing
  // station, which is a brick in the owner's hands. Detaching a device from an account is the
  // owner's action (`resetDeviceForTransfer`), not the hardware's — otherwise anyone holding a
  // stolen controller could unbind it from its owner.
  bool wipeToFactoryState();

 private:
  String readString(const char* key);
  bool putString(const char* key, const String& value);

  Preferences prefs_;
  bool opened_ = false;
  String deviceId_;
  String deviceSecret_;
  String gatewayUrl_;
  String wifiSsid_;
  String wifiPassword_;
  String claimCode_;
  String claimCodeExpiresAt_;
  String configCache_;
};
