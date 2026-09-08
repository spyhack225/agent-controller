#pragma once

// Copy this file to controller_config.h for real hardware builds.
// Keep controller_config.h out of git because it contains device secrets.
//
// Target board: Waveshare ESP32-S3-Touch-AMOLED-1.75C
// https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.75C
//
// ---------------------------------------------------------------------------
// !! EVERY PIN BELOW IS UNVERIFIED !!
//
// The GPIO map is transcribed from the ESPHome community device profile for the
// non-cased ESP32-S3-Touch-AMOLED-1.75, because Waveshare's overview page for
// the 1.75C publishes no pin table. The "C" suffix denotes the aluminium-alloy
// cased variant and is expected to be the same PCB, but that has not been
// confirmed against a schematic or a board.
//
// Confirm each pin before flashing anything that drives a rail. Getting the
// panel power or PA enable wrong is the class of mistake that damages hardware.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wi-Fi credentials are NOT here.
//
// They live in NVS and are entered by the owner through the SoftAP setup portal
// (`agent-ctl-XXXX` -> http://192.168.4.1). A compile-time SSID could never work
// on a shipped unit, because the factory cannot know the customer's network.
// ---------------------------------------------------------------------------

// Bench seed only. DeviceStore copies these into NVS on a unit that has none, and
// never overwrites a factory-provisioned one. Leave the "replace_me" placeholders
// alone and the seed is skipped entirely.
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by POST /v1/factory/devices or POST /v1/devices.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

// amoled175 = 1.75 inch round AMOLED, esp32-s3r8 = ESP32-S3 with 8 MB octal PSRAM.
// This string is the firmware manifest matching key; changing it orphans devices
// from their release channel.
#define HARDWARE_MODEL "amoled175-esp32-s3r8"
#define FIRMWARE_VERSION "0.1.0"

// OTA apply is off until the partition table and rollback have been tested on real hardware.
#ifndef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 0
#endif

#ifndef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 0
#endif
#ifndef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY ""
#endif

// HTTPS fails closed unless the cloud gateway's issuing root is configured. Concatenate a current
// and next root during rotation. Set INSECURE_SKIP_TLS_VERIFY=1 only in a local bench config; it
// exposes the long-lived device credential to interception.
#define GATEWAY_TLS_ROOT_CA_PEM ""
#define GATEWAY_TLS_NEXT_ROOT_CA_PEM ""
#define INSECURE_SKIP_TLS_VERIFY 0

// ---------------------------------------------------------------------------
// Display: CO5300 AMOLED controller, 466x466, QSPI.
//
// Unlike the CrowPanel's e-ink panel there is no vendor driver in-tree yet.
// The candidates are Waveshare's own engineering sample sources
// (github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75) or an LVGL port.
// ---------------------------------------------------------------------------
#define AMOLED_QSPI_CLK 38
#define AMOLED_QSPI_D0  4
#define AMOLED_QSPI_D1  5
#define AMOLED_QSPI_D2  6
#define AMOLED_QSPI_D3  7
#define AMOLED_QSPI_CS  12
#define AMOLED_RST      39

#define AMOLED_WIDTH  466
#define AMOLED_HEIGHT 466

// A 466x466 16 bpp framebuffer is ~434 KB, so it must come from PSRAM, not SRAM.
// Double buffering costs ~868 KB of the 8 MB available.
#define AMOLED_COLOR_DEPTH 16

// The safe scaffold never touches these pins. Turn this on only after the 1.75C schematic and a
// physical display bring-up have proved the rail and bus mapping; enabling the macro alone does not
// add a driver or advertise a display capability.
#ifndef ENABLE_AMOLED
#define ENABLE_AMOLED 0
#endif

// ---------------------------------------------------------------------------
// Shared I2C bus: CST9217 touch, AXP2101 PMIC, QMI8658 IMU, RTC, and the
// ES7210 / ES8311 audio chips all hang off it.
// ---------------------------------------------------------------------------
#define I2C_SDA_PIN 15
#define I2C_SCL_PIN 14

// CST9217 capacitive touch.
#define TOUCH_INT_PIN 11
#define TOUCH_RST_PIN 40

// ---------------------------------------------------------------------------
// Audio. This is the reason the board is here.
//
// The dual-microphone array feeds an ES7210 ADC, which is configured over I2C
// and then read as standard I2S. This is NOT the PDM path the CrowPanel capture
// build uses, and it is NOT a bare I2S MEMS mic either: the ES7210 needs a
// register init sequence before it emits anything. That init is the one piece
// of genuinely new driver code this board requires.
//
// ES8311 drives the speaker pads on the same I2S bus for playback.
// ---------------------------------------------------------------------------
#ifndef ENABLE_AUDIO_CAPTURE
#define ENABLE_AUDIO_CAPTURE 0
#endif

// 0 = standard I2S (what the ES7210 emits). The CrowPanel default of 1 (PDM) is wrong here.
#ifndef AUDIO_MIC_PDM
#define AUDIO_MIC_PDM 0
#endif

#ifndef AUDIO_I2S_PORT
#define AUDIO_I2S_PORT 0
#endif

#define AUDIO_I2S_MCLK_PIN 42
#define AUDIO_I2S_BCLK_PIN 9
#define AUDIO_I2S_WS_PIN   45
#define AUDIO_I2S_DIN_PIN  10   // microphone in, from ES7210
#define AUDIO_I2S_DOUT_PIN 8    // speaker out, to ES8311
#define AUDIO_PA_ENABLE_PIN 46  // speaker amplifier enable

// Names the CrowPanel capture layer expects, mapped onto this board's bus.
#ifndef AUDIO_I2S_CLK_PIN
#define AUDIO_I2S_CLK_PIN AUDIO_I2S_BCLK_PIN
#endif
#ifndef AUDIO_I2S_DATA_PIN
#define AUDIO_I2S_DATA_PIN AUDIO_I2S_DIN_PIN
#endif

// Default I2C addresses. Verify against the schematic; the ES7210 address in
// particular is strap-selectable.
#define ES7210_I2C_ADDR 0x40
#define ES8311_I2C_ADDR 0x18
#define AXP2101_I2C_ADDR 0x34

// 16 kHz mono is the floor for speech recognition and matches what the gateway's
// transcription pipeline expects. The array is stereo at the ADC; downmix to mono
// before upload rather than sending two channels the ASR will discard.
#ifndef AUDIO_SAMPLE_RATE_HZ
#define AUDIO_SAMPLE_RATE_HZ 16000
#endif

#ifndef AUDIO_SLOT_BITS
#define AUDIO_SLOT_BITS 16
#endif

#ifndef AUDIO_GAIN_SHIFT
#define AUDIO_GAIN_SHIFT 0
#endif

// Push-to-talk bounds. This board has PSRAM to spare, so the clip ceiling is
// generous compared to the CrowPanel's 6 seconds — but keep it short anyway:
// upload time and ASR latency both scale with it, and the gateway caps the
// decoded size at MEDIA_UPLOAD_MAX_BYTES.
#ifndef AUDIO_CAPTURE_MAX_MS
#define AUDIO_CAPTURE_MAX_MS 30000
#endif

#ifndef AUDIO_CAPTURE_MIN_MS
#define AUDIO_CAPTURE_MIN_MS 400
#endif

// 960000 = 30 s of 16 kHz 16-bit mono. Allocated from PSRAM.
#ifndef AUDIO_CAPTURE_MAX_BYTES
#define AUDIO_CAPTURE_MAX_BYTES 960000UL
#endif

// Mirror of the gateway's MAX_MEDIA_BYTES. The gateway checks the decoded size.
#ifndef MEDIA_UPLOAD_MAX_BYTES
#define MEDIA_UPLOAD_MAX_BYTES (2UL * 1024UL * 1024UL)
#endif

#ifndef AUDIO_PROMPT_TEXT
#define AUDIO_PROMPT_TEXT "Voice note from the hardware controller. Use it as the instruction for the current task."
#endif

// ---------------------------------------------------------------------------
// There is no camera on this board, so camera capture stays off and no pin map
// is defined. A camera_prompt intent cannot originate here.
// ---------------------------------------------------------------------------
#ifndef ENABLE_CAMERA_CAPTURE
#define ENABLE_CAMERA_CAPTURE 0
#endif

// ---------------------------------------------------------------------------
// Buttons. This board has only PWR and BOOT — there is no five-key cluster like
// the CrowPanel's. Every other control is on the touch screen, which is the
// point: push-to-talk and menu navigation move on-screen.
//
// BOOT (GPIO0) is usable as a general input after boot. PWR is wired to the
// AXP2101 and is read over I2C, not as a GPIO.
// ---------------------------------------------------------------------------
#define BOOT_BUTTON_PIN 0

// Hold this many milliseconds on BOOT to wipe Wi-Fi and re-enter provisioning,
// matching the CrowPanel's EXIT long-press recovery.
#ifndef PROVISIONING_RESET_HOLD_MS
#define PROVISIONING_RESET_HOLD_MS 10000
#endif
