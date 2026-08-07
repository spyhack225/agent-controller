#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <cstring>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

// Writable device state and the provisioning state machine. Device id, secret, gateway URL, and
// Wi-Fi credentials now live in NVS: the values in controller_config.h are a bench seed used only
// when NVS is empty, never a source of truth. See firmware/shared/AgentControllerCore.
#include <DeviceStore.h>
#include <Provisioning.h>

// Pulls in ENABLE_AUDIO_CAPTURE / ENABLE_CAMERA_CAPTURE and their pin defaults.
// Both default to 0, so a board with neither microphone nor camera builds and
// behaves exactly as before.
#include "media_capture.h"

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "e213-esp32-s3r8"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

#ifndef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 0
#endif

#ifndef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 0
#endif

#ifndef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY ""
#endif

#ifndef DEFAULT_SHELL_COMMAND
#define DEFAULT_SHELL_COMMAND "npm test"
#endif

#if ENABLE_EINK
// This panel is a JD79661, not an SSD1680: it uses a different command set and
// the opposite BUSY polarity, so GxEPD2 cannot drive it (verified on hardware --
// GxEPD2 blocks forever in its busy wait). lib/ElecrowEPD is Elecrow's own
// driver for this exact board. See docs/hardware-protocol.md.
#include "EPD.h"
#include "EPD_Init.h"
#endif

namespace {
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kDisplayPollIntervalMs = 5000;
constexpr uint32_t kConfigPollIntervalMs = 60000;
constexpr uint32_t kFirmwarePollIntervalMs = 6UL * 60UL * 60UL * 1000UL;
constexpr uint32_t kSetupCodeRefreshIntervalMs = 10UL * 60UL * 1000UL;
constexpr uint32_t kButtonDebounceMs = 250;
constexpr size_t kOtaBufferSize = 4096;
// EXIT short-press shows the claim code; a 10 s hold wipes Wi-Fi and re-enters provisioning. Both
// live on the same key because the board has five, and this is the "I moved house / I am selling
// this / it says revoked" recovery that previously required a USB reflash.
constexpr uint32_t kResetHoldMs = 10000;
uint32_t lastHeartbeatAt = 0;
uint32_t lastDisplayPollAt = 0;
uint32_t lastConfigPollAt = 0;
uint32_t lastFirmwarePollAt = 0;
uint32_t lastSetupCodeAt = 0;
uint32_t nextGatewayRequestAt = 0;
int selectedMenuIndex = 0;

// Keys are latched in an ISR because the main loop spends most of its time
// blocked in HTTP calls and panel refreshes.
constexpr uint32_t kKeyUpBit = 1u << 0;
constexpr uint32_t kKeyDownBit = 1u << 1;
constexpr uint32_t kKeyOkBit = 1u << 2;
constexpr uint32_t kKeyMenuBit = 1u << 3;
constexpr uint32_t kKeyExitBit = 1u << 4;

volatile uint32_t pendingKeyMask = 0;
volatile uint32_t lastKeyIsrAt = 0;

void IRAM_ATTR onKeyIsr(void* arg) {
  const uint32_t now = millis();
  // One debounce window across all keys: these are mechanical switches on a
  // shared bezel and a bounce on one must not read as a press on another.
  if (now - lastKeyIsrAt < kButtonDebounceMs) return;
  lastKeyIsrAt = now;
  pendingKeyMask |= static_cast<uint32_t>(reinterpret_cast<uintptr_t>(arg));
}

// Six is the gateway's own menu length; the two extra slots exist so a board
// with capture hardware can offer "audio"/"camera" without dropping an entry
// the gateway sent.
constexpr size_t kMaxMenuItems = 8;

const char* kFallbackMenu[] = {
  "status",
  "prompt",
  "shell",
  "macro",
#if ENABLE_AUDIO_CAPTURE
  "audio",
#endif
#if ENABLE_CAMERA_CAPTURE
  "camera",
#endif
  "media",
  "stop",
};
String menuItems[kMaxMenuItems];
size_t menuCount = 0;

struct DisplayModel {
  String title = "Agent Controller";
  String state = "boot";
  String line1 = "Starting";
  String line2 = "Connecting WiFi";
};

DisplayModel displayModel;

struct RuntimeConfig {
  String environmentId = ENVIRONMENT_ID;
  String threadId = THREAD_ID;
  String defaultPrompt = DEFAULT_AGENT_PROMPT;
  String shellCommand = DEFAULT_SHELL_COMMAND;
};

RuntimeConfig runtimeConfig;

DeviceStore deviceStore;
Provisioning provisioning;
// Set when the gateway answers 401 on a credential the device believes is good. That means the
// owner revoked it, and the only way out is the long-press reset — so the screen has to say so
// instead of showing "HTTP 401" forever.
bool deviceRevoked = false;
// Latches the revoked screen so it renders on entry rather than on every 10ms pass. Cleared
// wherever deviceRevoked is, so a recovered or re-claimed device redraws normally.
bool revokedScreenShown = false;

void confirmFirmwareIfPendingVerify();
bool applyFirmwareUpdate(JsonObject manifest);
bool verifyManifestSignature(JsonObject manifest);

#if ENABLE_EINK
// The driver's framebuffer, defined in lib/ElecrowEPD/EPD.cpp. Drawing helpers
// compose into it; EPD_DisplayImage() then ships it to the panel.
extern "C" uint8_t ImageBW[ALLSCREEN_BYTES];
// Landscape: USE_HORIZONTIAL 2 gives a 250 x 128 logical canvas.
constexpr uint8_t kFontHeight = 16;
// What is currently on the glass, so unchanged state does not burn a refresh.
String lastRenderedSignature;
#endif

String urlFor(const char* path) {
  // NVS is the source of truth; the build-time value only seeded it on a blank unit.
  String base = deviceStore.gatewayUrl();
  if (base.length() == 0) base = GATEWAY_BASE_URL;
  if (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

bool isHttps(const String& url) {
  return url.startsWith("https://");
}

bool beginHttp(HTTPClient& http, WiFiClient& plainClient, WiFiClientSecure& secureClient, const String& url) {
  if (isHttps(url)) {
#if INSECURE_SKIP_TLS_VERIFY
    secureClient.setInsecure();
#endif
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

int requestJson(const char* method, const char* path, const String& body, String& response) {
  if (nextGatewayRequestAt > 0 && millis() < nextGatewayRequestAt) {
    response = "rate limited locally";
    return 429;
  }

  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  const String url = urlFor(path);

  if (!beginHttp(http, plainClient, secureClient, url)) {
    response = "http begin failed";
    return -1;
  }

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", deviceStore.deviceId());
  http.addHeader("x-device-secret", deviceStore.deviceSecret());
  const char* responseHeaders[] = {"retry-after"};
  http.collectHeaders(responseHeaders, 1);

  int code = 0;
  if (strcmp(method, "GET") == 0) {
    code = http.GET();
  } else if (strcmp(method, "POST") == 0) {
    code = http.POST(body);
  } else {
    response = "unsupported method";
    http.end();
    return -1;
  }

  response = http.getString();
  // 401 means the credential itself was rejected: the owner revoked this device, or it was
  // transfer-reset. No amount of retrying fixes that, so surface it as a state with an on-device
  // recovery instead of letting the screen sit on an HTTP code.
  if (code == 401) {
    deviceRevoked = true;
  } else if (code >= 200 && code < 300) {
    deviceRevoked = false;
    revokedScreenShown = false;
  }
  if (code == 429) {
    const int retryAfterSeconds = http.header("retry-after").toInt();
    const uint32_t delayMs = static_cast<uint32_t>(max(1, retryAfterSeconds)) * 1000UL;
    nextGatewayRequestAt = millis() + delayMs;
    Serial.printf("gateway rate limited, backing off for %u ms\n", static_cast<unsigned>(delayMs));
  }
  http.end();
  return code;
}

void drawDisplay() {
  Serial.printf(
    "[display] %s | %s | %s | %s\n",
    displayModel.title.c_str(),
    displayModel.state.c_str(),
    displayModel.line1.c_str(),
    displayModel.line2.c_str()
  );

#if ENABLE_EINK
  // A full refresh takes over a second and consumes one of the panel's finite
  // update cycles, and the display poll runs every 5s. Only redraw when the
  // rendered content actually differs from what is already on the glass.
  const String signature = displayModel.title + "\x1f" + displayModel.state + "\x1f"
    + displayModel.line1 + "\x1f" + displayModel.line2 + "\x1f"
    + (menuCount > 0 ? menuItems[selectedMenuIndex] : String());
  if (signature == lastRenderedSignature) return;
  lastRenderedSignature = signature;

  // 0xFF is white in this driver's RAM encoding (a set bit is a white pixel).
  memset(ImageBW, 0xFF, ALLSCREEN_BYTES);

  EPD_ShowString(6, 6, displayModel.title.c_str(), BLACK, 24);
  EPD_ShowString(6, 38, displayModel.line1.c_str(), BLACK, kFontHeight);
  EPD_ShowString(6, 58, displayModel.line2.c_str(), BLACK, kFontHeight);

  const String selection = String("> ") + (menuCount > 0 ? menuItems[selectedMenuIndex] : String("-"));
  EPD_ShowString(6, 86, selection.c_str(), BLACK, kFontHeight);
  EPD_ShowString(180, 86, displayModel.state.c_str(), BLACK, kFontHeight);

  EPD_DisplayImage(ImageBW);
  EPD_Update();
#endif
}

void setMenuDefaults() {
  menuCount = sizeof(kFallbackMenu) / sizeof(kFallbackMenu[0]);
  for (size_t i = 0; i < menuCount; i += 1) {
    menuItems[i] = kFallbackMenu[i];
  }
}

void parseDisplayPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    displayModel.state = "error";
    displayModel.line1 = "Bad display JSON";
    displayModel.line2 = err.c_str();
    return;
  }

  JsonObject displayJson = doc["display"];
  displayModel.title = displayJson["title"] | "Controller";
  displayModel.state = displayJson["state"] | "unknown";
  displayModel.line1 = displayJson["line1"] | "";
  displayModel.line2 = displayJson["line2"] | "";

  JsonArray menu = displayJson["menu"].as<JsonArray>();
  if (!menu.isNull() && menu.size() > 0) {
    menuCount = menu.size() < kMaxMenuItems ? menu.size() : kMaxMenuItems;
    for (size_t i = 0; i < menuCount; i += 1) {
      menuItems[i] = menu[i].as<const char*>();
    }
    if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
  }
}

void parseConfigPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("config parse failed: %s\n", err.c_str());
    return;
  }

  JsonObject config = doc["config"];
  const char* environmentId = config["environmentId"] | "";
  const char* threadId = config["threadId"] | "";
  const char* defaultPrompt = config["defaultPrompt"] | "";
  const char* shellCommand = config["shellCommand"] | "";

  if (strlen(environmentId) > 0) runtimeConfig.environmentId = environmentId;
  if (strlen(threadId) > 0) runtimeConfig.threadId = threadId;
  if (strlen(defaultPrompt) > 0) runtimeConfig.defaultPrompt = defaultPrompt;
  if (strlen(shellCommand) > 0) runtimeConfig.shellCommand = shellCommand;

  JsonArray menu = config["menu"].as<JsonArray>();
  if (!menu.isNull() && menu.size() > 0) {
    menuCount = menu.size() < kMaxMenuItems ? menu.size() : kMaxMenuItems;
    for (size_t i = 0; i < menuCount; i += 1) {
      menuItems[i] = menu[i].as<const char*>();
    }
    if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
  }
}

// A destructive action on a five-key bezel needs a deliberate second press, and the screen showing
// that prompt must survive the display poll — which overwrites displayModel every few seconds and
// would otherwise wipe the prompt out from under the owner mid-decision.
bool resetConfirmOpen = false;

void renderProvisioningState();

void openResetConfirm() {
  resetConfirmOpen = true;
  displayModel.title = "Factory reset";
  displayModel.state = "confirm";
  displayModel.line1 = "Erase WiFi + setup?";
  displayModel.line2 = "OK erase / EXIT cancel";
  drawDisplay();
}

void cancelResetConfirm() {
  resetConfirmOpen = false;
  displayModel.title = "Factory reset";
  displayModel.state = "cancelled";
  displayModel.line1 = "Cancelled";
  displayModel.line2 = "Nothing erased";
  drawDisplay();
  // Let the next display poll take the screen back.
  lastDisplayPollAt = 0;
}

void performFactoryReset() {
  resetConfirmOpen = false;
  Serial.println("[reset] confirmed: wiping owner state, keeping device identity");

  displayModel.title = "Factory reset";
  displayModel.state = "erasing";
  displayModel.line1 = "Erasing settings";
  displayModel.line2 = "Do not unplug";
  drawDisplay();

  const bool wiped = deviceStore.wipeToFactoryState();
  deviceRevoked = false;
  revokedScreenShown = false;
  lastSetupCodeAt = 0;
  runtimeConfig.threadId = "";

  if (!wiped) {
    // NVS refused the write. Saying "done" here would be a lie the owner acts on, so report it.
    displayModel.state = "error";
    displayModel.line1 = "Erase failed";
    displayModel.line2 = "Retry or reflash";
    drawDisplay();
    return;
  }

  provisioning.resetToProvisioning();
  renderProvisioningState();
}

// Renders whatever provisioning state the device is in. There is deliberately no blocking wait
// anywhere in this path: the previous `while (WiFi.status() != WL_CONNECTED)` loop meant a wrong
// password, a renamed network, or a house move left the unit spinning forever with "Connecting
// WiFi" on the glass and no way out but a USB reflash.
void renderProvisioningState() {
  const ProvisioningStatus& status = provisioning.status();
  switch (status.state) {
    case ProvisioningState::Provisioning:
      displayModel.title = "Setup";
      displayModel.state = "provisioning";
      displayModel.line1 = "Join " + status.apName;
      displayModel.line2 = status.portalUrl;
      break;
    case ProvisioningState::Connecting:
      displayModel.title = "Agent Controller";
      displayModel.state = "connecting";
      displayModel.line1 = "Joining WiFi";
      displayModel.line2 = status.detail;
      break;
    case ProvisioningState::Online:
      displayModel.title = "Agent Controller";
      displayModel.state = "online";
      displayModel.line1 = "Connected";
      displayModel.line2 = status.detail;
      break;
    default:
      displayModel.title = "Setup";
      displayModel.state = provisioningStateName(status.state);
      displayModel.line1 = "Starting";
      displayModel.line2 = status.detail;
      break;
  }
  drawDisplay();
}

void renderRevoked() {
  displayModel.title = "Revoked";
  displayModel.state = "revoked";
  displayModel.line1 = "Access removed";
  displayModel.line2 = "Hold EXIT 10s to reset";
  drawDisplay();
}

bool gatewayReachable() {
  return provisioning.status().state == ProvisioningState::Online;
}

// Every menu action except "reset" is a gateway round trip, and offline those failed with a bare
// "HTTP -1" — a transport error code shown to someone whose actual problem is that the controller
// is not on a network. Name the cause, and keep the remedy on screen: the provisioning detail is
// the SSID to join or the network being joined, which is what the owner needs next.
void renderNotConnected(const String& action) {
  const ProvisioningStatus& status = provisioning.status();
  displayModel.title = "Not connected";
  displayModel.state = "offline";
  displayModel.line1 = (action.length() ? action : String("Action")) + " needs network";
  displayModel.line2 = status.detail.length() ? status.detail : String("Join " + status.apName);
  drawDisplay();
}

void sendHeartbeat() {
  String response;
  JsonDocument doc;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["hardwareModel"] = HARDWARE_MODEL;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptimeMs"] = millis();
  String body;
  serializeJson(doc, body);
  const int code = requestJson("POST", "/v1/device/heartbeat", body, response);
  Serial.printf("heartbeat code=%d response=%s\n", code, response.c_str());

  // A reachable gateway is our health signal: only then is a freshly flashed image confirmed.
  if (code >= 200 && code < 300) confirmFirmwareIfPendingVerify();
}

// Roadmap Phase 12 requires an OTA pipeline with a rollback process, not just a download.
//
// With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE the bootloader marks a newly flashed image
// PENDING_VERIFY. If the firmware never confirms itself, the next reset rolls back to the previous
// image automatically. Confirming on a successful heartbeat means an image that boots but cannot
// reach the gateway is rolled back instead of bricking the controller.
void confirmFirmwareIfPendingVerify() {
  static bool confirmed = false;
  if (confirmed) return;

  const esp_partition_t* running = esp_ota_get_running_partition();
  if (running == nullptr) return;

  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
  if (state != ESP_OTA_IMG_PENDING_VERIFY) {
    confirmed = true;  // Nothing pending: either a normal boot or already confirmed.
    return;
  }

  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    confirmed = true;
    Serial.println("OTA image confirmed healthy; rollback cancelled");
  } else {
    Serial.println("failed to confirm OTA image; it will roll back on next reset");
  }
}

void showCachedClaimCode() {
  displayModel.title = "Setup";
  displayModel.state = "unclaimed";
  if (deviceStore.hasClaimCode()) {
    displayModel.line1 = "Claim code";
    displayModel.line2 = deviceStore.claimCode();
  } else {
    // No cached code and the gateway will not reissue a live one, so the code printed at
    // manufacture is the only copy that exists. Saying "No code" sent owners looking for a fault
    // when the answer was sitting on the box in their hand.
    displayModel.line1 = "Use code on box";
    displayModel.line2 = "Lost it? See dashboard";
  }
  drawDisplay();
}

// `rotate` is the owner asking for a replacement code ("I lost the card"), driven by a menu action,
// never by a timer. Left false, this is safe to call on every 403: the gateway answers "the existing
// code is still valid" and hands back nothing, so the code printed on the box survives.
void fetchSetupCode(bool force = false, bool rotate = false) {
  // A cached code is the normal answer. Without this the device would ask the gateway on every
  // unclaimed poll, which is exactly the traffic the stable-code change was made to allow.
  if (!rotate && deviceStore.hasClaimCode()) {
    showCachedClaimCode();
    if (!force) return;
  }
  if (!force && !rotate && lastSetupCodeAt > 0
      && millis() - lastSetupCodeAt < kSetupCodeRefreshIntervalMs) {
    return;
  }

  String response;
  const String body = rotate ? "{\"rotate\":true}" : "{\"rotate\":false}";
  const int code = requestJson("POST", "/v1/device/setup-code", body, response);
  lastSetupCodeAt = millis();
  if (code < 200 || code >= 300) {
    Serial.printf("setup code fetch code=%d response=%s\n", code, response.c_str());
    // Falling back to the cached code keeps the setup screen usable through a gateway outage.
    if (deviceStore.hasClaimCode()) showCachedClaimCode();
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("setup code parse failed: %s\n", err.c_str());
    return;
  }

  JsonObject setup = doc["setup"];
  const bool claimed = setup["claimed"] | false;
  const bool rotated = setup["rotated"] | false;
  const char* claimCode = setup["claimCode"] | doc["claimCode"] | "";
  const char* expiresAt = setup["claimCodeExpiresAt"] | doc["claimCodeExpiresAt"] | "";

  if (claimed) {
    deviceStore.clearClaimCode();
    displayModel.title = "Agent Controller";
    displayModel.state = "claimed";
    displayModel.line1 = "Device claimed";
    displayModel.line2 = "Loading config";
    drawDisplay();
    return;
  }

  // The plaintext is returned exactly once, at issue, because the gateway stores only its hash.
  // Persisting it here is what lets the endpoint stop rotating on every call.
  if (rotated && strlen(claimCode) > 0) {
    deviceStore.setClaimCode(String(claimCode), String(expiresAt));
    Serial.printf("[setup] new claim code issued, expires %s\n", expiresAt);
  }
  showCachedClaimCode();
}

void fetchDeviceConfig() {
  String response;
  const int code = requestJson("GET", "/v1/device/config", "", response);
  if (code >= 200 && code < 300) {
    parseConfigPayload(response);
    Serial.printf(
      "config loaded env=%s thread=%s shell=%s menu=%u\n",
      runtimeConfig.environmentId.c_str(),
      runtimeConfig.threadId.c_str(),
      runtimeConfig.shellCommand.c_str(),
      static_cast<unsigned>(menuCount)
    );
  } else {
    Serial.printf("config fetch code=%d response=%s\n", code, response.c_str());
    if (code == 403) fetchSetupCode();
  }
}

void pollFirmwareManifest() {
  String response;
  String path = String("/v1/device/firmware?version=") + FIRMWARE_VERSION + "&hardware=" + HARDWARE_MODEL;
  const int code = requestJson("GET", path.c_str(), "", response);
  if (code < 200 || code >= 300) {
    Serial.printf("firmware poll code=%d response=%s\n", code, response.c_str());
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("firmware manifest parse failed: %s\n", err.c_str());
    return;
  }

  const bool updateAvailable = doc["updateAvailable"] | false;
  if (!updateAvailable) {
    Serial.println("firmware current");
    return;
  }

  JsonObject manifest = doc["manifest"];
  const char* version = manifest["version"] | "";
  const char* firmwareUrl = manifest["url"] | "";
  const char* signature = manifest["signature"] | "";
  Serial.printf("firmware update available version=%s url=%s signature=%s\n", version, firmwareUrl, signature);
  displayModel.line1 = String("Update ") + version;
  displayModel.line2 = ENABLE_OTA_APPLY ? "Applying OTA" : "OTA ready";
  drawDisplay();
  applyFirmwareUpdate(manifest);
}

void pollDisplay() {
  // A confirmation prompt the owner is reading must not be overwritten by a routine poll. Without
  // this the "erase everything?" screen survives about five seconds.
  if (resetConfirmOpen) return;

  String response;
  const int code = requestJson("GET", "/v1/device/display", "", response);
  if (code >= 200 && code < 300) {
    parseDisplayPayload(response);
  } else if (code == 403) {
    fetchSetupCode();
    return;
  } else {
    displayModel.state = "error";
    displayModel.line1 = "Display poll failed";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
}

String jsonEscape(const char* text) {
  String out;
  while (*text) {
    if (*text == '"' || *text == '\\') out += '\\';
    out += *text;
    text += 1;
  }
  return out;
}

String hexDigest(const uint8_t* data, size_t length) {
  static const char* digits = "0123456789abcdef";
  String output;
  output.reserve(length * 2);
  for (size_t index = 0; index < length; index += 1) {
    output += digits[(data[index] >> 4) & 0x0F];
    output += digits[data[index] & 0x0F];
  }
  return output;
}

String jsonStringValue(const char* text) {
  String output = "\"";
  while (*text) {
    if (*text == '"' || *text == '\\') output += '\\';
    output += *text;
    text += 1;
  }
  output += "\"";
  return output;
}

String canonicalManifestJson(JsonObject manifest) {
  String output = "{";
  output += "\"createdAt\":" + jsonStringValue(manifest["createdAt"] | "");
  output += ",\"hardwareModel\":" + jsonStringValue(manifest["hardwareModel"] | "");
  output += ",\"mandatory\":";
  output += (manifest["mandatory"] | false) ? "true" : "false";
  output += ",\"releaseNotes\":" + jsonStringValue(manifest["releaseNotes"] | "");
  output += ",\"sha256\":" + jsonStringValue(manifest["sha256"] | "");
  output += ",\"sizeBytes\":";
  output += String(static_cast<unsigned long>(manifest["sizeBytes"] | 0));
  output += ",\"url\":" + jsonStringValue(manifest["url"] | "");
  output += ",\"version\":" + jsonStringValue(manifest["version"] | "");
  output += "}";
  return output;
}

bool verifyManifestSignature(JsonObject manifest) {
#if REQUIRE_OTA_SIGNATURE
  const char* signature = manifest["signature"] | "";
  if (strlen(signature) == 0 || strlen(OTA_MANIFEST_VERIFY_KEY) == 0) {
    Serial.println("manifest signature or verify key missing");
    return false;
  }

  const String canonical = canonicalManifestJson(manifest);
  uint8_t digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  const int result = mbedtls_md_hmac(
    info,
    reinterpret_cast<const unsigned char*>(OTA_MANIFEST_VERIFY_KEY),
    strlen(OTA_MANIFEST_VERIFY_KEY),
    reinterpret_cast<const unsigned char*>(canonical.c_str()),
    canonical.length(),
    digest
  );
  if (result != 0) {
    Serial.printf("manifest hmac failed: %d\n", result);
    return false;
  }
  const String expected = hexDigest(digest, sizeof(digest));
  if (!expected.equalsIgnoreCase(signature)) {
    Serial.printf("manifest signature mismatch expected=%s got=%s\n", expected.c_str(), signature);
    return false;
  }
#endif
  return true;
}

bool applyFirmwareUpdate(JsonObject manifest) {
#if !ENABLE_OTA_APPLY
  Serial.println("OTA apply disabled by ENABLE_OTA_APPLY");
  return false;
#else
  if (!verifyManifestSignature(manifest)) return false;

  const char* firmwareUrl = manifest["url"] | "";
  const char* expectedSha = manifest["sha256"] | "";
  const size_t expectedSize = static_cast<size_t>(manifest["sizeBytes"] | 0);
  if (strlen(firmwareUrl) == 0 || strlen(expectedSha) != 64 || expectedSize == 0) {
    Serial.println("firmware manifest is incomplete");
    return false;
  }

  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  if (!beginHttp(http, plainClient, secureClient, firmwareUrl)) {
    Serial.println("firmware http begin failed");
    return false;
  }

  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("firmware download failed code=%d\n", code);
    http.end();
    return false;
  }

  const int contentLength = http.getSize();
  if (contentLength > 0 && static_cast<size_t>(contentLength) != expectedSize) {
    Serial.printf("firmware size mismatch header=%d manifest=%u\n", contentLength, static_cast<unsigned>(expectedSize));
    http.end();
    return false;
  }

  if (!Update.begin(expectedSize)) {
    Serial.printf("Update.begin failed: %s\n", Update.errorString());
    http.end();
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buffer[kOtaBufferSize];
  size_t written = 0;
  uint32_t lastProgressAt = 0;

  while (http.connected() && written < expectedSize) {
    const size_t available = stream->available();
    if (available == 0) {
      delay(10);
      continue;
    }
    const size_t toRead = min(available, sizeof(buffer));
    const int read = stream->readBytes(buffer, toRead);
    if (read <= 0) continue;

    mbedtls_sha256_update(&sha, buffer, read);
    const size_t otaWritten = Update.write(buffer, read);
    if (otaWritten != static_cast<size_t>(read)) {
      Serial.printf("OTA write failed: %s\n", Update.errorString());
      mbedtls_sha256_free(&sha);
      Update.abort();
      http.end();
      return false;
    }
    written += otaWritten;

    if (millis() - lastProgressAt > 1000) {
      lastProgressAt = millis();
      displayModel.line1 = "Updating firmware";
      displayModel.line2 = String((written * 100) / expectedSize) + "%";
      drawDisplay();
    }
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();

  const String actualSha = hexDigest(digest, sizeof(digest));
  if (written != expectedSize) {
    Serial.printf("firmware download incomplete written=%u expected=%u\n", static_cast<unsigned>(written), static_cast<unsigned>(expectedSize));
    Update.abort();
    return false;
  }
  if (!actualSha.equalsIgnoreCase(expectedSha)) {
    Serial.printf("firmware sha mismatch expected=%s actual=%s\n", expectedSha, actualSha.c_str());
    Update.abort();
    return false;
  }

  if (!Update.end(true)) {
    Serial.printf("Update.end failed: %s\n", Update.errorString());
    return false;
  }

  displayModel.line1 = "Firmware updated";
  displayModel.line2 = "Restarting";
  drawDisplay();
  delay(1000);
  ESP.restart();
  return true;
#endif
}

#if ENABLE_AUDIO_CAPTURE || ENABLE_CAMERA_CAPTURE
// Uploads one capture to POST /v1/device/media and returns the created media id,
// or an empty String on failure. `httpCodeOut` always receives the transport
// result so the caller can put something specific on the display.
//
// The payload is presented as two contiguous segments (a container header plus
// the captured bytes) so a WAV header can be prepended without reallocating or
// memmoving the recording. Nothing is copied: the JSON envelope and the base64
// expansion are generated on the fly while HTTPClient drains the stream, so the
// capture buffer stays the only full copy in RAM.
String uploadMedia(
  const char* kind,
  const char* contentType,
  const char* originalName,
  const uint8_t* headerBytes,
  size_t headerLength,
  const uint8_t* bodyBytes,
  size_t bodyLength,
  int& httpCodeOut
) {
  httpCodeOut = -1;

  const size_t rawBytes = headerLength + bodyLength;
  if (rawBytes == 0) return String();
  // The gateway measures the *decoded* size against MAX_MEDIA_BYTES, so this is
  // the same number it will check. Refusing here turns a wasted upload of up to
  // 1.33x the clip into an instant local error.
  if (rawBytes > static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES)) {
    httpCodeOut = 413;
    return String();
  }

  if (nextGatewayRequestAt > 0 && millis() < nextGatewayRequestAt) {
    httpCodeOut = 429;
    return String();
  }

  String prefix = "{\"kind\":\"";
  prefix += kind;
  prefix += "\",\"contentType\":\"";
  prefix += contentType;
  prefix += "\",\"originalName\":\"";
  prefix += jsonEscape(originalName);
  prefix += "\",\"dataBase64\":\"";
  const String suffix = "\"}";

  capture::Base64JsonBodyStream bodyStream(
    prefix,
    suffix,
    headerBytes,
    headerLength,
    bodyBytes,
    bodyLength
  );
  const size_t contentLength = bodyStream.contentLength();

  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  const String url = urlFor("/v1/device/media");
  if (!beginHttp(http, plainClient, secureClient, url)) {
    Serial.println("[media] http begin failed");
    return String();
  }

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", deviceStore.deviceId());
  http.addHeader("x-device-secret", deviceStore.deviceSecret());
  const char* responseHeaders[] = {"retry-after"};
  http.collectHeaders(responseHeaders, 1);
  // A base64 upload over a slow uplink outlasts the 5 s default.
  http.setTimeout(30000);

  const int code = http.sendRequest("POST", &bodyStream, contentLength);
  httpCodeOut = code;
  const String response = http.getString();
  if (code == 429) {
    const int retryAfterSeconds = http.header("retry-after").toInt();
    const uint32_t delayMs = static_cast<uint32_t>(max(1, retryAfterSeconds)) * 1000UL;
    nextGatewayRequestAt = millis() + delayMs;
  }
  http.end();

  Serial.printf(
    "[media] upload kind=%s raw=%u encoded=%u code=%d response=%s\n",
    kind,
    static_cast<unsigned>(rawBytes),
    static_cast<unsigned>(contentLength),
    code,
    response.c_str()
  );

  if (code < 200 || code >= 300) return String();

  JsonDocument doc;
  if (deserializeJson(doc, response)) return String();
  const char* mediaId = doc["media"]["id"] | "";
  return String(mediaId);
}
#endif  // ENABLE_AUDIO_CAPTURE || ENABLE_CAMERA_CAPTURE

// Steps to the next thread in the environment the owner bound to this device.
// A five-key bezel cannot browse a list, so each press advances by one and shows
// where it landed. The gateway validates the id against the bound environment, so
// a stale list here is rejected rather than acted on.
bool cycleThread() {
  String response;
  int code = requestJson("GET", "/v1/device/threads", "", response);
  if (code < 200 || code >= 300) {
    displayModel.line1 = "Thread list failed";
    // 409 is the specific, actionable case: the owner has bound no environment.
    displayModel.line2 = code == 409 ? "No environment set" : String("HTTP ") + code;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    displayModel.line1 = "Bad thread JSON";
    displayModel.line2 = "";
    drawDisplay();
    return false;
  }

  JsonArray threads = doc["threads"].as<JsonArray>();
  if (threads.isNull() || threads.size() == 0) {
    displayModel.line1 = "No threads";
    displayModel.line2 = "Start one first";
    drawDisplay();
    return false;
  }

  const char* current = doc["threadId"] | "";
  size_t next = 0;
  for (size_t i = 0; i < threads.size(); i += 1) {
    const char* id = threads[i]["id"] | "";
    if (strlen(current) > 0 && strcmp(id, current) == 0) {
      next = (i + 1) % threads.size();
      break;
    }
  }

  const char* nextId = threads[next]["id"] | "";
  const char* nextTitle = threads[next]["title"] | "Thread";
  if (strlen(nextId) == 0) return false;

  String body = String("{\"threadId\":\"") + jsonEscape(nextId) + "\"}";
  response = "";
  code = requestJson("POST", "/v1/device/config/thread", body, response);
  Serial.printf("thread select id=%s code=%d\n", nextId, code);
  if (code >= 200 && code < 300) {
    runtimeConfig.threadId = nextId;
    displayModel.line1 = "Thread";
    displayModel.line2 = nextTitle;
  } else {
    displayModel.line1 = "Thread select failed";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

bool runFirstMacro() {
  String response;
  int code = requestJson("GET", "/v1/device/macros", "", response);
  Serial.printf("macro list code=%d response=%s\n", code, response.c_str());
  if (code < 200 || code >= 300) {
    displayModel.line1 = "Macro list failed";
    displayModel.line2 = String("HTTP ") + code;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    displayModel.line1 = "Bad macro JSON";
    displayModel.line2 = error.c_str();
    drawDisplay();
    return false;
  }

  JsonArray macros = doc["macros"].as<JsonArray>();
  if (macros.isNull() || macros.size() == 0) {
    displayModel.line1 = "No saved macros";
    displayModel.line2 = "Use dashboard";
    drawDisplay();
    return false;
  }

  JsonObject macro = macros[0];
  const char* macroId = macro["id"] | "";
  const char* macroLabel = macro["label"] | "Macro";
  if (strlen(macroId) == 0) {
    displayModel.line1 = "Macro missing id";
    displayModel.line2 = "";
    drawDisplay();
    return false;
  }

  String body = "{}";
  response = "";
  String path = String("/v1/device/macros/") + macroId + "/run";
  code = requestJson("POST", path.c_str(), body, response);
  Serial.printf("macro run id=%s code=%d response=%s\n", macroId, code, response.c_str());

  JsonDocument runDoc;
  const DeserializationError runError = deserializeJson(runDoc, response);
  const char* commandStatus = runError ? nullptr : runDoc["command"]["status"] | nullptr;
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = macroLabel;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = String(macroLabel);
    displayModel.line2 = "Complete";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = String(macroLabel);
    displayModel.line2 = "Dispatched";
  } else {
    displayModel.line1 = "Macro sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

bool handleFirstApproval(const char* action) {
  String response;
  int code = requestJson("GET", "/v1/device/approvals", "", response);
  Serial.printf("approval list action=%s code=%d response=%s\n", action, code, response.c_str());
  if (code < 200 || code >= 300) {
    displayModel.line1 = "Approval list failed";
    displayModel.line2 = String("HTTP ") + code;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    displayModel.line1 = "Bad approval JSON";
    displayModel.line2 = error.c_str();
    drawDisplay();
    return false;
  }

  JsonArray commands = doc["commands"].as<JsonArray>();
  if (commands.isNull() || commands.size() == 0) {
    displayModel.line1 = "No approvals";
    displayModel.line2 = "Queue empty";
    drawDisplay();
    return false;
  }

  JsonObject command = commands[0];
  const char* commandId = command["id"] | "";
  const char* intentType = command["intent"]["type"] | "command";
  if (strlen(commandId) == 0) {
    displayModel.line1 = "Approval missing id";
    displayModel.line2 = "";
    drawDisplay();
    return false;
  }

  String path = String("/v1/device/approvals/") + commandId + "/" + action;
  response = "";
  code = requestJson("POST", path.c_str(), "{}", response);
  Serial.printf("approval action=%s id=%s code=%d response=%s\n", action, commandId, code, response.c_str());

  JsonDocument actionDoc;
  const DeserializationError actionError = deserializeJson(actionDoc, response);
  const char* commandStatus = actionError ? nullptr : actionDoc["command"]["status"] | nullptr;
  if (commandStatus) {
    displayModel.line1 = String(action) + " " + commandStatus;
    displayModel.line2 = intentType;
  } else {
    displayModel.line1 = String(action) + " sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

// Wraps an intent object in the device envelope, posts it, and reflects the
// resulting command status on the display. Shared by the menu actions and the
// media capture flows so they all report status the same way.
bool postIntent(const String& intentJson, const String& label) {
  String body = String("{\"environmentId\":\"") + jsonEscape(runtimeConfig.environmentId.c_str()) + "\","
    "\"threadId\":\"" + jsonEscape(runtimeConfig.threadId.c_str()) + "\","
    "\"intent\":" + intentJson + "}";

  String response;
  const int code = requestJson("POST", "/v1/device/intents", body, response);
  Serial.printf("intent menu=%s code=%d response=%s\n", label.c_str(), code, response.c_str());

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  const char* commandStatus = error ? nullptr : doc["command"]["status"] | nullptr;
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = label;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = label + " complete";
    displayModel.line2 = "Updated";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = label + " sent";
    displayModel.line2 = "Dispatched";
  } else {
    displayModel.line1 = label + " sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

#if ENABLE_AUDIO_CAPTURE
// Push-to-talk: records for as long as the confirm key stays down, uploads the
// clip as a WAV, then references it from an audio_prompt intent.
//
// Nothing is drawn between the press and the end of the clip on purpose. A full
// e-ink refresh costs on the order of a second, and spending that inside a
// push-to-talk window would swallow the beginning of the utterance.
bool captureAndSendAudio() {
  // Three independent ceilings; the tightest wins. The duration ceiling is the
  // product decision, the byte ceiling protects the allocation if the sample
  // rate is raised, and the gateway ceiling keeps the upload acceptable.
  size_t budget = (capture::kAudioBytesPerSecond * static_cast<size_t>(AUDIO_CAPTURE_MAX_MS)) / 1000;
  if (budget > static_cast<size_t>(AUDIO_CAPTURE_MAX_BYTES)) {
    budget = static_cast<size_t>(AUDIO_CAPTURE_MAX_BYTES);
  }
  if (budget + capture::kWavHeaderBytes > static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES)) {
    budget = static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES) - capture::kWavHeaderBytes;
  }
  budget &= ~static_cast<size_t>(1);
  if (budget == 0) return false;

  // PSRAM is where a clip belongs; internal DRAM is shared with the WiFi stack
  // and the e-ink frame buffer, so only borrow it when there is real headroom.
  uint8_t* pcm = static_cast<uint8_t*>(ps_malloc(budget));
  if (pcm == nullptr && ESP.getFreeHeap() > budget + 65536) {
    pcm = static_cast<uint8_t*>(malloc(budget));
  }
  if (pcm == nullptr) {
    displayModel.state = "error";
    displayModel.line1 = "Audio: no memory";
    displayModel.line2 = String(static_cast<unsigned>(budget / 1024)) + " KB needed";
    drawDisplay();
    return false;
  }

  if (!capture::audioBegin()) {
    free(pcm);
    displayModel.state = "error";
    displayModel.line1 = "Mic init failed";
    displayModel.line2 = "Check I2S pins";
    drawDisplay();
    return false;
  }

  const uint32_t startedAt = millis();
  size_t recorded = 0;
  while (recorded < budget) {
    const uint32_t elapsed = millis() - startedAt;
    if (elapsed >= static_cast<uint32_t>(AUDIO_CAPTURE_MAX_MS)) break;
    // Releasing the key ends the utterance. This is the whole point of reading
    // in small chunks.
    if (digitalRead(KEY_OK_PIN) != LOW) break;
    recorded += capture::audioReadPcm(pcm + recorded, budget - recorded, 20);
  }
  const uint32_t durationMs = millis() - startedAt;
  capture::audioEnd();

  // Swallow the key release so it does not immediately re-trigger the menu.
  lastKeyIsrAt = millis();

  const size_t minimumBytes =
    (capture::kAudioBytesPerSecond * static_cast<size_t>(AUDIO_CAPTURE_MIN_MS)) / 1000;
  if (recorded < minimumBytes) {
    free(pcm);
    displayModel.state = "ready";
    displayModel.line1 = "Clip too short";
    displayModel.line2 = "Hold OK to talk";
    drawDisplay();
    return false;
  }

  displayModel.state = "uploading";
  displayModel.line1 = String("Recorded ") + String(durationMs / 1000.0f, 1) + "s";
  displayModel.line2 = String("Uploading ") + String(static_cast<unsigned>(recorded / 1024)) + " KB";
  drawDisplay();

  uint8_t wavHeader[capture::kWavHeaderBytes];
  capture::buildWavHeader(wavHeader, static_cast<uint32_t>(recorded));

  int httpCode = 0;
  const String mediaId = uploadMedia(
    "audio",
    "audio/wav",
    "controller-capture.wav",
    wavHeader,
    sizeof(wavHeader),
    pcm,
    recorded,
    httpCode
  );
  free(pcm);

  if (mediaId.length() == 0) {
    displayModel.state = "error";
    displayModel.line1 = "Audio upload failed";
    displayModel.line2 = String("HTTP ") + httpCode;
    drawDisplay();
    return false;
  }

  // No transcript is sent: the device does not transcribe. The gateway falls
  // back to the media upload's own transcript, or attaches the clip as context.
  const String intent = String("{\"type\":\"audio_prompt\",\"mediaUploadId\":\"")
    + jsonEscape(mediaId.c_str())
    + "\",\"prompt\":\"" + jsonEscape(AUDIO_PROMPT_TEXT) + "\"}";
  return postIntent(intent, "audio");
}
#endif  // ENABLE_AUDIO_CAPTURE

#if ENABLE_CAMERA_CAPTURE
// Grabs one JPEG still and references it from a camera_prompt intent. The frame
// buffer belongs to the driver and is streamed straight out of PSRAM, so the
// image is never copied and never base64-expanded in RAM.
bool captureAndSendImage() {
  lastKeyIsrAt = millis();

  if (!capture::cameraBegin()) {
    displayModel.state = "error";
    displayModel.line1 = "Camera init failed";
    displayModel.line2 = "Check pins/power";
    drawDisplay();
    return false;
  }

  const uint8_t* frame = nullptr;
  size_t frameLength = 0;
  if (!capture::cameraCaptureJpeg(&frame, &frameLength)) {
    displayModel.state = "error";
    displayModel.line1 = "Capture failed";
    displayModel.line2 = "No frame";
    drawDisplay();
    return false;
  }

  const size_t ceiling = static_cast<size_t>(CAMERA_CAPTURE_MAX_BYTES)
      < static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES)
    ? static_cast<size_t>(CAMERA_CAPTURE_MAX_BYTES)
    : static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES);
  if (frameLength > ceiling) {
    capture::cameraRelease();
    displayModel.state = "error";
    displayModel.line1 = "Image too large";
    displayModel.line2 = String(static_cast<unsigned>(frameLength / 1024)) + " KB";
    drawDisplay();
    return false;
  }

  displayModel.state = "uploading";
  displayModel.line1 = "Photo captured";
  displayModel.line2 = String("Uploading ") + String(static_cast<unsigned>(frameLength / 1024)) + " KB";
  drawDisplay();

  int httpCode = 0;
  const String mediaId = uploadMedia(
    "image",
    "image/jpeg",
    "controller-capture.jpg",
    nullptr,
    0,
    frame,
    frameLength,
    httpCode
  );
  // Hold the frame until the upload has drained it, then give it straight back:
  // with fb_count 1 the driver cannot produce another frame until it is
  // returned.
  capture::cameraRelease();

  if (mediaId.length() == 0) {
    displayModel.state = "error";
    displayModel.line1 = "Photo upload failed";
    displayModel.line2 = String("HTTP ") + httpCode;
    drawDisplay();
    return false;
  }

  const String intent = String("{\"type\":\"camera_prompt\",\"mediaUploadId\":\"")
    + jsonEscape(mediaId.c_str())
    + "\",\"prompt\":\"" + jsonEscape(CAMERA_PROMPT_TEXT) + "\"}";
  return postIntent(intent, "camera");
}
#endif  // ENABLE_CAMERA_CAPTURE

#if !ENABLE_AUDIO_CAPTURE || !ENABLE_CAMERA_CAPTURE
// A menu entry the gateway sent that this build has no hardware for. Say so
// rather than silently falling through to a status request.
void reportCaptureUnavailable(const char* what, const char* macro) {
  displayModel.state = "error";
  displayModel.line1 = String("No ") + what;
  displayModel.line2 = String("Build ") + macro;
  drawDisplay();
}
#endif

void submitIntent(const String& menuItem) {
  String intent;
  if (menuItem == "status") {
    intent = "{\"type\":\"status\"}";
  } else if (menuItem == "prompt") {
    intent = String("{\"type\":\"agent_prompt\",\"text\":\"") + jsonEscape(runtimeConfig.defaultPrompt.c_str()) + "\"}";
  } else if (menuItem == "shell") {
    if (runtimeConfig.shellCommand.length() == 0) {
      displayModel.line1 = "No shell command";
      displayModel.line2 = "Configure device";
      drawDisplay();
      return;
    }
    intent = String("{\"type\":\"shell_input\",\"command\":\"") + jsonEscape(runtimeConfig.shellCommand.c_str()) + "\"}";
  } else if (menuItem == "stop") {
    intent = "{\"type\":\"session_control\",\"action\":\"stop\"}";
  } else if (menuItem == "macro") {
    runFirstMacro();
    return;
  } else if (menuItem == "thread") {
    cycleThread();
    return;
  } else if (menuItem == "reset") {
    openResetConfirm();
    return;
  } else if (menuItem == "approve") {
    handleFirstApproval("approve");
    return;
  } else if (menuItem == "reject") {
    handleFirstApproval("reject");
    return;
  } else if (menuItem == "audio" || menuItem == "mic" || menuItem == "talk" || menuItem == "voice") {
#if ENABLE_AUDIO_CAPTURE
    captureAndSendAudio();
#else
    reportCaptureUnavailable("microphone", "ENABLE_AUDIO_CAPTURE");
#endif
    return;
  } else if (menuItem == "camera" || menuItem == "photo" || menuItem == "snapshot") {
#if ENABLE_CAMERA_CAPTURE
    captureAndSendImage();
#else
    reportCaptureUnavailable("camera", "ENABLE_CAMERA_CAPTURE");
#endif
    return;
  } else if (menuItem == "media") {
    // The gateway's stock menu carries a single generic "media" entry. On a
    // board that can actually capture, take a real capture; otherwise keep the
    // historical behaviour of pointing the agent at the most recent upload.
#if ENABLE_CAMERA_CAPTURE
    captureAndSendImage();
    return;
#elif ENABLE_AUDIO_CAPTURE
    captureAndSendAudio();
    return;
#else
    intent = "{\"type\":\"camera_prompt\",\"prompt\":\"Use the latest hardware media capture as context.\"}";
#endif
  } else {
    intent = "{\"type\":\"status\"}";
  }

  postIntent(intent, menuItem);
}

void moveSelection(int delta) {
  if (menuCount == 0) return;
  selectedMenuIndex += delta;
  if (selectedMenuIndex < 0) selectedMenuIndex = static_cast<int>(menuCount) - 1;
  if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
  drawDisplay();
}

// The CrowPanel dial is three discrete switches, not a quadrature encoder, so
// selection is edge-driven off five active-low keys sharing one debounce window.
// Drains whatever the ISRs latched since the last pass. Polling digitalRead here
// instead would miss almost every press: this runs between blocking work, and a
// display poll is an HTTP round trip plus a refresh well over a second long,
// which is far longer than anyone holds a key.
void handleButtons() {
  noInterrupts();
  const uint32_t pending = pendingKeyMask;
  pendingKeyMask = 0;
  interrupts();
  if (pending == 0) return;

  // While the erase prompt is up the bezel means only yes or no. Letting the dial keep browsing the
  // menu underneath a modal is how someone ends up confirming a wipe they thought they had left.
  if (resetConfirmOpen) {
    if (pending & kKeyOkBit) {
      Serial.println("[key] ok -> factory reset confirmed");
      performFactoryReset();
    } else if (pending & (kKeyExitBit | kKeyMenuBit | kKeyUpBit | kKeyDownBit)) {
      Serial.println("[key] cancel -> factory reset abandoned");
      cancelResetConfirm();
    }
    return;
  }

  if (pending & kKeyUpBit) {
    Serial.println("[key] up");
    moveSelection(-1);
  }
  if (pending & kKeyDownBit) {
    Serial.println("[key] down");
    moveSelection(1);
  }
  if (pending & kKeyOkBit) {
    Serial.println("[key] ok");
    if (menuCount > 0) {
      const String& item = menuItems[selectedMenuIndex];
      // "reset" is exempt: an unreachable gateway is precisely when the owner needs the wipe.
      if (item != "reset" && !gatewayReachable()) renderNotConnected(item);
      else submitIntent(item);
    }
  }
  if (pending & kKeyMenuBit) {
    Serial.println("[key] menu");
    if (!gatewayReachable()) {
      renderNotConnected("Refresh");
    } else {
      lastDisplayPollAt = millis();
      pollDisplay();
    }
  }
  if (pending & kKeyExitBit) {
    // The physical escape hatch when the printed claim card is lost: show the
    // code this device is currently advertising. Held for kResetHoldMs it becomes the factory
    // reset instead, handled in pollResetHold().
    Serial.println("[key] exit");
    if (!gatewayReachable()) renderNotConnected("Setup code");
    else fetchSetupCode(true);
  }
}

// EXIT held down wipes Wi-Fi and re-enters provisioning. Polled rather than driven from the ISR
// because a hold has no falling edge to latch, and it deliberately reads the pin directly so a
// device wedged anywhere else in the loop can still be recovered.
void pollResetHold() {
  static uint32_t heldSince = 0;
  static bool warned = false;

  // EXIT is also "cancel" on the erase prompt. Without this, holding it a moment too long while
  // backing out would trigger the very reset the owner just declined.
  if (resetConfirmOpen) {
    heldSince = 0;
    warned = false;
    return;
  }

  // The board's keys are active-low with external pull-ups.
  const bool down = digitalRead(KEY_EXIT_PIN) == LOW;
  if (!down) {
    heldSince = 0;
    warned = false;
    return;
  }

  const uint32_t now = millis();
  if (heldSince == 0) {
    heldSince = now;
    return;
  }

  const uint32_t held = now - heldSince;
  if (!warned && held > 3000) {
    warned = true;
    displayModel.title = "Reset";
    displayModel.state = "resetting";
    displayModel.line1 = "Keep holding EXIT";
    displayModel.line2 = "Release to cancel";
    drawDisplay();
  }

  if (held >= kResetHoldMs) {
    Serial.println("[key] EXIT held: resetting Wi-Fi and re-entering provisioning");
    heldSince = 0;
    warned = false;
    deviceRevoked = false;
    revokedScreenShown = false;
    lastSetupCodeAt = 0;
    provisioning.resetToProvisioning();
    renderProvisioningState();
  }
}

void attachKeys() {
  attachInterruptArg(digitalPinToInterrupt(KEY_UP_PIN), onKeyIsr, (void*)kKeyUpBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_DOWN_PIN), onKeyIsr, (void*)kKeyDownBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_OK_PIN), onKeyIsr, (void*)kKeyOkBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_MENU_PIN), onKeyIsr, (void*)kKeyMenuBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_EXIT_PIN), onKeyIsr, (void*)kKeyExitBit, FALLING);
}
}

void setup() {
  Serial.begin(115200);
  delay(200);

  setMenuDefaults();

  pinMode(POWER_LED_PIN, OUTPUT);
  digitalWrite(POWER_LED_PIN, HIGH);

  // The board carries external pull-ups on all five keys; they read LOW when pressed.
  pinMode(KEY_UP_PIN, INPUT);
  pinMode(KEY_DOWN_PIN, INPUT);
  pinMode(KEY_OK_PIN, INPUT);
  pinMode(KEY_MENU_PIN, INPUT);
  pinMode(KEY_EXIT_PIN, INPUT);
  // Idle levels, so a miswired or wrong-polarity key shows up here rather than
  // as silence when someone presses it.
  Serial.printf(
    "[keys] idle up=%d down=%d ok=%d menu=%d exit=%d (all should read 1)\n",
    digitalRead(KEY_UP_PIN), digitalRead(KEY_DOWN_PIN), digitalRead(KEY_OK_PIN),
    digitalRead(KEY_MENU_PIN), digitalRead(KEY_EXIT_PIN)
  );
  attachKeys();

#if ENABLE_EINK
  // The panel rail must come up and settle before the controller answers.
  pinMode(EINK_POWER_PIN, OUTPUT);
  digitalWrite(EINK_POWER_PIN, HIGH);
  delay(300);
  // EPD_Init() calls EPD_GPIOInit(), which owns the bit-banged SPI pins, so no
  // SPI.begin() here. EPD_Clear() primes both RAM planes and loads the waveform
  // LUTs; without it the first refresh returns in milliseconds having done
  // nothing. EPD_ALL_Fill() is dead SSD1680 code in this library -- do not use it.
  EPD_Init();
  EPD_Clear();
  EPD_Update();
#endif

  if (!deviceStore.begin()) {
    displayModel.title = "Storage error";
    displayModel.state = "fault";
    displayModel.line1 = "NVS unavailable";
    displayModel.line2 = "Reflash required";
    drawDisplay();
    return;
  }
  // Bench convenience only: seeds an otherwise-blank unit from controller_config.h. A
  // factory-flashed device already has NVS identity and this writes nothing.
  deviceStore.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);

  if (!deviceStore.hasIdentity()) {
    // Nothing can be done over the network without a credential, and the owner cannot supply one:
    // identity is written at manufacture. Say so rather than looping on 401s.
    displayModel.title = "Not provisioned";
    displayModel.state = "unprovisioned";
    displayModel.line1 = "No device identity";
    displayModel.line2 = "Factory flash needed";
    drawDisplay();
    return;
  }

  provisioning.begin(deviceStore, deviceStore.deviceId());
  renderProvisioningState();
}

// Everything that talks to the gateway, run once the link is up. Kept together so the loop has a
// single "we are online" branch rather than a reachability check per call site.
void runGatewayCycle(bool justConnected) {
  const uint32_t now = millis();
  if (justConnected) {
    lastHeartbeatAt = now;
    sendHeartbeat();
    fetchDeviceConfig();
    pollFirmwareManifest();
    pollDisplay();
    return;
  }
  if (now - lastHeartbeatAt > kHeartbeatIntervalMs) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  if (now - lastConfigPollAt > kConfigPollIntervalMs) {
    lastConfigPollAt = now;
    fetchDeviceConfig();
  }
  if (now - lastFirmwarePollAt > kFirmwarePollIntervalMs) {
    lastFirmwarePollAt = now;
    pollFirmwareManifest();
  }
  if (now - lastDisplayPollAt > kDisplayPollIntervalMs) {
    lastDisplayPollAt = now;
    pollDisplay();
  }
}

void loop() {
  handleButtons();
  pollResetHold();

  if (!deviceStore.hasIdentity()) {
    delay(50);
    return;
  }

  const ProvisioningState state = provisioning.poll();
  static ProvisioningState lastRenderedState = ProvisioningState::Unprovisioned;
  if (state != lastRenderedState) {
    lastRenderedState = state;
    renderProvisioningState();
  }

  if (state != ProvisioningState::Online) {
    // Offline states are the portal's to drive. Polling the gateway here would just stack up
    // failures, and the portal's web server needs the cycles.
    delay(10);
    return;
  }

  if (deviceRevoked) {
    // A revoked device keeps heartbeating — that is how the owner sees it is still alive after a
    // transfer reset — but the screen tells the truth and offers the way out.
    //
    // Rendered once on entry, not every pass: this branch runs every 10ms, and re-rendering there
    // rebuilt the display strings and logged a line ~37 times a second forever. The e-ink itself was
    // spared only because drawDisplay() skips unchanged content.
    if (!revokedScreenShown) {
      revokedScreenShown = true;
      renderRevoked();
    }
    if (millis() - lastHeartbeatAt > kHeartbeatIntervalMs) {
      lastHeartbeatAt = millis();
      sendHeartbeat();
    }
    delay(10);
    return;
  }

  runGatewayCycle(provisioning.consumeJustConnected());
  delay(10);
}
