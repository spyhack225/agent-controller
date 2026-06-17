#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Encoder.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <cstring>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

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
#include <GxEPD2_BW.h>
#include <epd/GxEPD2_213_BN.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#endif

namespace {
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kDisplayPollIntervalMs = 5000;
constexpr uint32_t kConfigPollIntervalMs = 60000;
constexpr uint32_t kFirmwarePollIntervalMs = 6UL * 60UL * 60UL * 1000UL;
constexpr uint32_t kSetupCodeRefreshIntervalMs = 10UL * 60UL * 1000UL;
constexpr uint32_t kButtonDebounceMs = 250;
constexpr size_t kOtaBufferSize = 4096;
ESP32Encoder encoder;
long lastEncoderPosition = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastDisplayPollAt = 0;
uint32_t lastConfigPollAt = 0;
uint32_t lastFirmwarePollAt = 0;
uint32_t lastSetupCodeAt = 0;
uint32_t lastButtonAt = 0;
uint32_t nextGatewayRequestAt = 0;
int selectedMenuIndex = 0;

const char* kFallbackMenu[] = {"status", "prompt", "shell", "macro", "media", "stop"};
String menuItems[6];
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

bool applyFirmwareUpdate(JsonObject manifest);
bool verifyManifestSignature(JsonObject manifest);

#if ENABLE_EINK
GxEPD2_BW<GxEPD2_213_BN, GxEPD2_213_BN::HEIGHT> display(
  GxEPD2_213_BN(EINK_CS, EINK_DC, EINK_RST, EINK_BUSY)
);
#endif

String urlFor(const char* path) {
  String base = GATEWAY_BASE_URL;
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
  http.addHeader("x-device-id", DEVICE_ID);
  http.addHeader("x-device-secret", DEVICE_SECRET);
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
  display.setRotation(1);
  display.setFont(&FreeMonoBold9pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setCursor(8, 24);
    display.print(displayModel.title);
    display.setCursor(8, 50);
    display.print(displayModel.line1);
    display.setCursor(8, 76);
    display.print(displayModel.line2);
    display.setCursor(8, 104);
    display.print(">");
    display.print(menuItems[selectedMenuIndex]);
  } while (display.nextPage());
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
    menuCount = menu.size() < 6 ? menu.size() : 6;
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
    menuCount = menu.size() < 6 ? menu.size() : 6;
    for (size_t i = 0; i < menuCount; i += 1) {
      menuItems[i] = menu[i].as<const char*>();
    }
    if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  displayModel.line1 = "Connecting WiFi";
  displayModel.line2 = WIFI_SSID;
  drawDisplay();

  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected: ");
  Serial.println(WiFi.localIP());
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
}

void fetchSetupCode(bool force = false) {
  if (!force && lastSetupCodeAt > 0 && millis() - lastSetupCodeAt < kSetupCodeRefreshIntervalMs) {
    return;
  }

  String response;
  const int code = requestJson("POST", "/v1/device/setup-code", "{}", response);
  lastSetupCodeAt = millis();
  if (code < 200 || code >= 300) {
    Serial.printf("setup code fetch code=%d response=%s\n", code, response.c_str());
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
  const char* claimCode = setup["claimCode"] | doc["claimCode"] | "";

  if (claimed) {
    displayModel.title = "Agent Controller";
    displayModel.state = "claimed";
    displayModel.line1 = "Device claimed";
    displayModel.line2 = "Loading config";
    drawDisplay();
    return;
  }

  if (strlen(claimCode) > 0) {
    displayModel.title = "Setup";
    displayModel.state = "unclaimed";
    displayModel.line1 = "Claim code";
    displayModel.line2 = claimCode;
  } else {
    displayModel.title = "Setup";
    displayModel.state = "unclaimed";
    displayModel.line1 = "Open dashboard";
    displayModel.line2 = "No code";
  }
  drawDisplay();
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
  } else if (menuItem == "approve") {
    handleFirstApproval("approve");
    return;
  } else if (menuItem == "reject") {
    handleFirstApproval("reject");
    return;
  } else if (menuItem == "media") {
    intent = "{\"type\":\"camera_prompt\",\"prompt\":\"Use the latest hardware media capture as context.\"}";
  } else {
    intent = "{\"type\":\"status\"}";
  }

  String body = String("{\"environmentId\":\"") + jsonEscape(runtimeConfig.environmentId.c_str()) + "\","
    "\"threadId\":\"" + jsonEscape(runtimeConfig.threadId.c_str()) + "\","
    "\"intent\":" + intent + "}";

  String response;
  const int code = requestJson("POST", "/v1/device/intents", body, response);
  Serial.printf("intent menu=%s code=%d response=%s\n", menuItem.c_str(), code, response.c_str());

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  const char* commandStatus = error ? nullptr : doc["command"]["status"] | nullptr;
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = menuItem;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = menuItem + " complete";
    displayModel.line2 = "Updated";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = menuItem + " sent";
    displayModel.line2 = "Dispatched";
  } else {
    displayModel.line1 = menuItem + " sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
}

void handleEncoder() {
  const long position = encoder.getCount() / 2;
  if (position != lastEncoderPosition && menuCount > 0) {
    const long delta = position - lastEncoderPosition;
    lastEncoderPosition = position;
    selectedMenuIndex += delta > 0 ? 1 : -1;
    if (selectedMenuIndex < 0) selectedMenuIndex = static_cast<int>(menuCount) - 1;
    if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
    drawDisplay();
  }

  if (digitalRead(ENCODER_BUTTON_PIN) == LOW && millis() - lastButtonAt > kButtonDebounceMs) {
    lastButtonAt = millis();
    submitIntent(menuItems[selectedMenuIndex]);
  }
}
}

void setup() {
  Serial.begin(115200);
  delay(200);

  setMenuDefaults();
  pinMode(ENCODER_BUTTON_PIN, INPUT_PULLUP);
  ESP32Encoder::useInternalWeakPullResistors = puType::up;
  encoder.attachHalfQuad(ENCODER_PIN_A, ENCODER_PIN_B);
  encoder.clearCount();

#if ENABLE_EINK
  display.init(115200, true, 2, false);
#endif

  connectWiFi();
  sendHeartbeat();
  fetchDeviceConfig();
  pollFirmwareManifest();
  pollDisplay();
}

void loop() {
  handleEncoder();

  const uint32_t now = millis();
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

  delay(10);
}
