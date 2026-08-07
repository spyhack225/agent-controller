#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <WiFi.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "vision-master-t190"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

namespace {
Adafruit_ST7789 tft = Adafruit_ST7789(DISPLAY_CS, DISPLAY_DC, DISPLAY_RST);
String currentLine1 = "Booting";
String currentLine2 = "Connecting WiFi";

void drawStatusScreen() {
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 16);
  tft.println("Vision Master T190");
  tft.setTextSize(1);
  tft.setCursor(8, 60);
  tft.println(currentLine1);
  tft.setCursor(8, 84);
  tft.println(currentLine2);
  tft.setCursor(8, 110);
  tft.println("HW: vision-master-t190");
}

void showStatus(const String& line1, const String& line2) {
  currentLine1 = line1;
  currentLine2 = line2;
  Serial.printf("Status: %s | %s\n", line1.c_str(), line2.c_str());
  drawStatusScreen();
}

void testBacklightPin() {
  Serial.println("Testing backlight pin...");
  pinMode(DISPLAY_BL, OUTPUT);
  for (int i = 0; i < 4; ++i) {
    digitalWrite(DISPLAY_BL, HIGH);
    Serial.printf("Backlight HIGH (%d)\n", i + 1);
    delay(300);
    digitalWrite(DISPLAY_BL, LOW);
    Serial.printf("Backlight LOW (%d)\n", i + 1);
    delay(300);
  }
  digitalWrite(DISPLAY_BL, HIGH);
  Serial.println("Backlight test complete; BL left enabled.");
}

bool publishHeartbeat() {
  if (String(GATEWAY_BASE_URL).startsWith("http://127.0.0.1") || String(GATEWAY_BASE_URL).startsWith("http://localhost")) {
    return false;
  }

  HTTPClient http;
  const String url = String(GATEWAY_BASE_URL) + "/health";
  if (!http.begin(url)) {
    return false;
  }

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", DEVICE_ID);
  http.addHeader("x-device-secret", DEVICE_SECRET);

  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["hardwareModel"] = HARDWARE_MODEL;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  String payload;
  serializeJson(doc, payload);

  const int code = http.POST(payload);
  http.end();
  return code >= 200 && code < 300;
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=== Vision Master T190 boot ===");

  // ----------------------------------------------------
  // POWER ON TFT
  // GPIO7 is ACTIVE LOW on Vision Master T190
  // ----------------------------------------------------
  pinMode(DISPLAY_POWER, OUTPUT);
  digitalWrite(DISPLAY_POWER, LOW);

  delay(100);

  // ----------------------------------------------------
  // BACKLIGHT
  // ----------------------------------------------------
  pinMode(DISPLAY_BL, OUTPUT);
  digitalWrite(DISPLAY_BL, HIGH);

  // ----------------------------------------------------
  // TFT SPI
  // MISO isn't connected/required
  // ----------------------------------------------------
  SPI.begin(
      DISPLAY_SCL,   // SCLK = GPIO38
      -1,            // MISO unused
      DISPLAY_SDA,   // MOSI = GPIO48
      DISPLAY_CS     // CS   = GPIO39
  );

  delay(100);

  // ----------------------------------------------------
  // DISPLAY
  // ----------------------------------------------------
  tft.init(170, 320);
  tft.setRotation(1);

  tft.fillScreen(ST77XX_RED);
  delay(1000);

  tft.fillScreen(ST77XX_GREEN);
  delay(1000);

  tft.fillScreen(ST77XX_BLUE);
  delay(1000);

  tft.fillScreen(ST77XX_BLACK);

  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(10, 20);
  tft.println("T190 WORKING");

  Serial.println("Initializing display...");
  tft.init(170, 320);
  tft.setRotation(1);
  tft.setTextWrap(false);
  drawStatusScreen();

  testBacklightPin();
  showStatus("Initializing", "Waiting for WiFi");
  Serial.println("Starting WiFi connection...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    if (millis() - started > 10000) {
      Serial.println("\nWiFi connection timed out");
      showStatus("WiFi failed", "Check credentials");
      break;
    }
  }

  Serial.println();
  if (WiFi.isConnected()) {
    Serial.print("WiFi connected: ");
    Serial.println(WiFi.localIP().toString());
    showStatus("Connected", WiFi.localIP().toString());
    publishHeartbeat();
  }
}

void loop() {
  static unsigned long lastBlink = 0;
  if (millis() - lastBlink > 1000) {
    lastBlink = millis();
    if (WiFi.isConnected()) {
      showStatus("Connected", WiFi.localIP().toString());
    } else {
      showStatus("Waiting", "for WiFi");
    }
  }

  delay(100);
}
