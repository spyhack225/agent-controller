// Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen module.
//
// This file is the board: power-on reporting, pins, radios, the one physical button, and the loop
// that drives everything else. The product lives next door — src/ui.cpp owns the five screens, the
// shared AgentControllerCore owns the gateway conversation, and src/audio.cpp owns the codec.
//
// The controller is usable from the glass: pick a thread, hold to record a voice note, run a saved
// action, read the reply, approve a held command. There is no keyboard and there will not be one;
// on a device like this a request is made by voice or by choosing something the owner saved
// earlier, and every on-device edit is a bounded choice.
//
// BOOT is overloaded and the overload is deliberate: a tap reopens the configuration portal (the
// escape hatch for a wrong gateway URL, which otherwise leaves a unit online and unable to reach
// anything), while a hold of PROVISIONING_RESET_HOLD_MS wipes Wi-Fi and re-enters provisioning —
// the recovery for a revoked device, a house move, or a resale.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>

#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#include "audio.h"
#include "display.h"
#include "gatewayProbe.h"
#include "touch.h"
#include "ui.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

namespace {

DeviceStore store;
Provisioning provisioning;
GatewayClient gateway;

ProvisioningState lastState = ProvisioningState::Unprovisioned;
uint32_t bootHeldSince = 0;
bool bootWasDown = false;

void reportMemory() {
  Serial.printf("Flash size:  %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("Heap free:   %u bytes\n", (unsigned)ESP.getFreeHeap());

  const size_t psram = ESP.getPsramSize();
  if (psram == 0) {
    Serial.println("PSRAM:       NOT DETECTED");
    Serial.println("  The vendor spec says 8 MB internal OPI PSRAM. Check that platformio.ini sets");
    Serial.println("  board_build.arduino.memory_type = qio_opi.");
    return;
  }
  Serial.printf("PSRAM:       %u bytes free of %u\n",
                (unsigned)ESP.getFreePsram(), (unsigned)psram);
}

void reportBattery() {
  // GPIO9 sits behind a divide-by-two, so the pin reads half the cell voltage. analogReadMilliVolts
  // applies the ESP32-S3's own ADC calibration, which is why this is not a raw-count conversion.
  const uint32_t mv = analogReadMilliVolts(BATTERY_ADC_PIN) * BATTERY_DIVIDER_RATIO;
  Serial.printf("Battery:     %u mV%s\n", (unsigned)mv,
                mv < 500 ? "  (no cell connected, or USB-only)" : "");
}

void reportIdentity() {
  if (store.hasIdentity()) {
    Serial.printf("Device id:   %s\n", store.deviceId().c_str());
    Serial.printf("Gateway:     %s\n", store.gatewayUrl().c_str());
    return;
  }
  Serial.println("Device id:   none in NVS");
  Serial.println("  Seed one by copying controller_config.example.h to controller_config.h and");
  Serial.println("  filling in DEVICE_ID / DEVICE_SECRET from POST /v1/devices, or flash a factory");
  Serial.println("  nvsSeed CSV from POST /v1/factory/batches.");
}

void reportState(ProvisioningState state) {
  const ProvisioningStatus& status = provisioning.status();
  Serial.printf("[provisioning] %s", provisioningStateName(state));
  if (status.detail.length()) Serial.printf(" — %s", status.detail.c_str());
  Serial.println();

  if (state == ProvisioningState::Provisioning) {
    Serial.printf("  Join \"%s\" and open %s to set Wi-Fi.\n",
                  status.apName.c_str(), status.portalUrl.c_str());
  }
  if (state == ProvisioningState::Online) {
    Serial.printf("  IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
}

// A tap and a hold on the same key, decided on release. The reset has to win, so it fires the
// moment the threshold passes rather than waiting for a lift that may never come.
void pollBootButton() {
  const bool down = digitalRead(BOOT_BUTTON_PIN) == LOW;

  if (down && !bootWasDown) {
    bootHeldSince = millis();
    bootWasDown = true;
    return;
  }

  if (down) {
    if (millis() - bootHeldSince >= PROVISIONING_RESET_HOLD_MS) {
      Serial.println("[provisioning] BOOT held — clearing Wi-Fi and re-entering provisioning.");
      provisioning.resetToProvisioning();
      bootWasDown = false;
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) delay(10);
    }
    return;
  }

  if (!bootWasDown) return;
  bootWasDown = false;

  // The escape hatch for a wrong gateway URL: the portal closes as soon as Wi-Fi joins, so without
  // this a typo left the device online, unable to reach any gateway, and recoverable only by the
  // long-press wipe — which also destroys Wi-Fi credentials that were perfectly good.
  Serial.println("[provisioning] BOOT tapped — opening the config portal.");
  provisioning.openConfigPortal();
}

}  // namespace

// Handed to the gateway probe task, which runs outside this translation unit's anonymous
// namespace and must not keep its own copy of the store.
DeviceStore& deviceStore() { return store; }

void setup() {
  Serial.begin(115200);

  // Never block on a serial write.
  //
  // This board's Serial is the ESP32-S3's native USB CDC, and by default a write waits for the host
  // to drain the TX buffer. With a monitor attached that is invisible; with nothing reading, the
  // buffer fills and every Serial.printf stalls the loop for the timeout — which presents as the
  // animation freezing at 0 fps for anyone watching the panel rather than the console. The bug is
  // therefore masked by the very tool used to look for it.
  //
  // 0 means "write what fits, drop the rest". Diagnostics are worth exactly nothing if printing
  // them is what stops the device working.
  Serial.setTxTimeoutMs(0);

  // Native USB CDC needs a moment before the host enumerates it; anything printed earlier is lost.
  delay(2000);

  Serial.println();
  Serial.println("=== Agent Controller — Hosyond ES3C28P 2.8\" IPS ESP32-S3 ===");
  Serial.printf("Model:       %s\n", HARDWARE_MODEL);
  Serial.printf("Firmware:    %s\n", FIRMWARE_VERSION);
  reportMemory();
  reportBattery();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  // One I2C bus, shared by the FT6336G touch controller, the ES8311 codec and the external header.
  // It is started here rather than inside audio init because touch needs it in builds that have no
  // audio at all — which is exactly how the display build failed to see the touch controller.
  if (!Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_SPEED_HZ)) {
    Serial.println("[i2c] Wire.begin failed; touch and codec will not respond.");
  }

  if (displayBegin()) {
    Serial.println("[display] ILI9341V up, 240x320, backlight on.");
    touchBegin();
    // 148 px across for the home orb, 44 px for the one that keeps the list screens alive.
    if (!displayBeginCanvases(148, 44)) {
      Serial.println("[display] Canvas allocation failed; running without the orb.");
    }
  } else {
    Serial.println("[display] Not initialised (ENABLE_LCD is 0, or init failed).");
  }

  if (!store.begin()) {
    // An NVS failure here means the partition table is wrong. Nothing after this would work.
    Serial.println("FATAL: NVS unavailable. Check board_build.partitions in platformio.ini.");
    return;
  }

  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  reportIdentity();

  if (audio::begin()) audio::bootSelfTest();

  // Declared before the first heartbeat, because the gateway decides what to assign this device and
  // how to wrap its text from these numbers. A board that does not claim a microphone is never
  // given a capture action, and one that claims the wrong label width gets clipped labels rather
  // than an error.
  gateway.setCapabilities(audio::available(), false);
  GatewayLimits limits;
  limits.menuItems = 8;
  limits.threadItems = 12;
  limits.labelCharacters = 24;
  limits.mediaUploadBytes = MEDIA_UPLOAD_MAX_BYTES;
  gateway.setLimits(limits);

  gateway.begin(store, HARDWARE_MODEL, FIRMWARE_VERSION);
  gateway.startNetworkTask();
  gatewayProbeBegin();
  provisioning.begin(store, store.deviceId());
  lastState = provisioning.status().state;
  reportState(lastState);

  uiBegin(gateway, provisioning, store);

  // -----------------------------------------------------------------------------------------
  // Not yet implemented, in dependency order:
  //
  //   OTA                  — partitions_ota.csv is in place and the manifest poll, download, and
  //                          rollback confirm still live in the CrowPanel's main.cpp.
  //   Gateway profiles     — the LAN/tailnet switch protocol, likewise unported.
  //   RGB LED indicator    — GPIO42, recording state.
  //   Camera               — no sensor on this board; capture_image controls report as much.
  // -----------------------------------------------------------------------------------------
}

void loop() {
  const ProvisioningState state = provisioning.poll();
  if (state != lastState) {
    lastState = state;
    reportState(state);
  }

  // Mirrors the reference loop: while the link is down the portal owns the screen, and polling the
  // gateway would only stack up failures.
  if (state == ProvisioningState::Online) {
    // The cycle runs on its own core now; the loop only forwards edges to it.
    //
    // This was tried once before and withdrawn, because a task mutating gateway state while the
    // renderer walked the same Strings faulted within seconds. What makes it safe now is not the
    // task but the lock discipline underneath it: the task holds the state lock across a fetch so
    // its parse is atomic, request() hands that lock back for the duration of the socket wait, and
    // every touch-driven entry point takes it too. The renderer takes it with a zero timeout and
    // reuses the previous frame's values when it cannot, so it never waits on the network at all.
    gateway.setNetworkPaused(audio::recording());
    if (provisioning.consumeJustConnected()) gateway.notifyJustConnected();
  } else {
    gateway.goOffline();
  }

  if (gateway.consumeJustClaimed()) {
    Serial.println("[gateway] claim confirmed; loading configuration");
    gatewayProbeNow();
  }

  const TouchEvent touch = touchPoll();
  if (touch.gesture != TouchGesture::None) uiHandleTouch(touch);

  uiTick();
  pollBootButton();
  uiSleepUntilNextFrame();
}
