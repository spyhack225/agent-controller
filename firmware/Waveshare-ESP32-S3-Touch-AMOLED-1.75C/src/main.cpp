// Waveshare ESP32-S3-Touch-AMOLED-1.75C — bring-up scaffold.
//
// This is deliberately NOT a port of the CrowPanel firmware. It boots, opens NVS, runs the shared
// provisioning state machine, and reports what it finds over USB serial. That is enough to confirm
// the board, the partition table, the PSRAM configuration, and the SoftAP portal on real hardware
// before anyone writes a display or audio driver against unverified pins.
//
// The gateway client (heartbeat, display state, intent submission, OTA, media upload) is not here
// because it does not exist as a reusable component yet — it lives inside the CrowPanel's
// 3.6k-line main.cpp. Extracting it into firmware/shared is the first task of the real port; see
// README.md.

#include <Arduino.h>
#include <WiFi.h>

#include <DeviceStore.h>
#include <Provisioning.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "amoled175-esp32-s3r8"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

namespace {

DeviceStore store;
Provisioning provisioning;

ProvisioningState lastState = ProvisioningState::Unprovisioned;
uint32_t bootHeldSince = 0;

// PSRAM is not optional on this board: the AMOLED framebuffer alone is ~434 KB at 16 bpp, and a
// 30 s audio clip is another ~960 KB. A build with the wrong memory_type silently falls back to
// no PSRAM and then fails much later, in a confusing place, so check it loudly at boot.
void reportMemory() {
  Serial.printf("Flash size:  %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("Heap free:   %u bytes\n", (unsigned)ESP.getFreeHeap());

  const size_t psram = ESP.getPsramSize();
  if (psram == 0) {
    Serial.println("PSRAM:       NOT DETECTED");
    Serial.println("  The framebuffer and audio buffers both need it. Check that platformio.ini");
    Serial.println("  sets board_build.arduino.memory_type = qio_opi for this ESP32-S3R8.");
    return;
  }
  Serial.printf("PSRAM:       %u bytes free of %u\n",
                (unsigned)ESP.getFreePsram(), (unsigned)psram);
}

void reportIdentity() {
  if (store.hasIdentity()) {
    Serial.printf("Device id:   %s\n", store.deviceId().c_str());
    Serial.printf("Gateway:     %s\n", store.gatewayUrl().c_str());
  } else {
    Serial.println("Device id:   none in NVS");
    Serial.println("  Seed one by copying controller_config.example.h to controller_config.h and");
    Serial.println("  filling in DEVICE_ID / DEVICE_SECRET from POST /v1/devices, or flash a");
    Serial.println("  factory nvsSeed CSV from POST /v1/factory/batches.");
  }
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

// Recovery path, matching the CrowPanel's EXIT long-press: hold BOOT to wipe Wi-Fi credentials and
// re-raise the portal. This is what a user does after a house move, a resale, or a revoked device.
void pollResetButton() {
  const bool held = digitalRead(BOOT_BUTTON_PIN) == LOW;
  if (!held) {
    bootHeldSince = 0;
    return;
  }
  if (bootHeldSince == 0) {
    bootHeldSince = millis();
    return;
  }
  if (millis() - bootHeldSince < PROVISIONING_RESET_HOLD_MS) return;

  bootHeldSince = 0;
  Serial.println("[provisioning] BOOT held — clearing Wi-Fi and re-entering provisioning.");
  provisioning.resetToProvisioning();
}

}  // namespace

void setup() {
  Serial.begin(115200);

  // Never block on a serial write.
  //
  // Serial here is the ESP32-S3's native USB CDC, and by default a write waits for the host to
  // drain the TX buffer. With a monitor attached that is invisible; with nothing reading, the
  // buffer fills and every Serial.printf stalls the loop for the timeout — so the bug is masked by
  // the very tool used to look for it. 0 means "write what fits, drop the rest", which is the right
  // trade: diagnostics are worth nothing if printing them is what stops the device working.
  Serial.setTxTimeoutMs(0);

  // Native USB CDC needs a moment before the host enumerates it, and anything printed before that
  // is lost. This board programs over native USB, unlike the CrowPanel.
  delay(2000);

  Serial.println();
  Serial.println("=== Agent Controller — Waveshare ESP32-S3-Touch-AMOLED-1.75C ===");
  Serial.printf("Model:       %s\n", HARDWARE_MODEL);
  Serial.printf("Firmware:    %s\n", FIRMWARE_VERSION);
  reportMemory();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  if (!store.begin()) {
    // On this hardware an NVS failure means the partition table is wrong. There is nothing useful
    // to do afterwards, and pretending otherwise hides the real fault.
    Serial.println("FATAL: NVS unavailable. Check board_build.partitions in platformio.ini.");
    return;
  }

  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  reportIdentity();

  provisioning.begin(store, store.deviceId());
  lastState = provisioning.status().state;
  reportState(lastState);

  // ---------------------------------------------------------------------------------------
  // Not yet implemented. Each of these needs its pins confirmed against the 1.75C schematic
  // before it is written, and each is tracked in README.md:
  //
  //   AXP2101 PMIC init over I2C — must come first; it gates the display and audio rails.
  //   CO5300 AMOLED over QSPI    — 466x466, framebuffer from PSRAM.
  //   CST9217 touch over I2C     — two-point, interrupt on TOUCH_INT_PIN.
  //   ES7210 mic array init      — the one genuinely new driver; standard I2S read after init.
  //   ES8311 codec + PA          — speaker playback, optional for v1.
  //   Gateway client             — extract from the CrowPanel main.cpp into firmware/shared.
  // ---------------------------------------------------------------------------------------
}

void loop() {
  const ProvisioningState state = provisioning.poll();
  if (state != lastState) {
    lastState = state;
    reportState(state);
  }

  if (provisioning.consumeJustConnected()) {
    Serial.println("[provisioning] joined — the gateway handshake would run here.");
  }

  pollResetButton();
  delay(20);
}
