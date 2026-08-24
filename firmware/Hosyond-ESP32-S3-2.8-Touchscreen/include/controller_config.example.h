#pragma once

// Copy this file to controller_config.h for real hardware builds.
// Keep controller_config.h out of git because it contains device secrets.
//
// Target board: Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen module.
//
// ---------------------------------------------------------------------------
// Unlike the Waveshare AMOLED board, THIS PIN MAP IS VENDOR-VERIFIED.
//
// Every GPIO below comes from the manufacturer's specification, section 4.2
// "ESP32-S3 pin allocation" (docs/…/2-规格书_Specification/), and was
// cross-checked against the vendor Arduino examples that ship in docs/ —
// Example_17_echo for the audio bus, Example_01_Simple_test for the display,
// Example_29_touch_pen for the touch controller, Example_13 for the battery.
//
// It still has not run on a board. Verified on paper is not verified on metal.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wi-Fi credentials are NOT here.
//
// They live in NVS and are entered by the owner through the SoftAP setup portal
// (`agent-ctl-XXXX` -> http://192.168.4.1). A compile-time SSID could never work
// on a shipped unit, because the factory cannot know the customer's network.
// ---------------------------------------------------------------------------

// Bench seed only. DeviceStore copies these into NVS on a unit that has none, and
// never overwrites a factory-provisioned one.
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by POST /v1/factory/devices or POST /v1/devices.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

// ips28 = 2.8 inch IPS, esp32-s3r8 = ESP32-S3 with 8 MB PSRAM.
// This string is the firmware manifest matching key; changing it orphans devices
// from their release channel.
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#define FIRMWARE_VERSION "0.1.0"

// OTA apply stays off until the partition table and rollback are tested on hardware.
#ifndef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 0
#endif
#ifndef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 0
#endif
#ifndef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY ""
#endif

// Defaults used by the on-screen quick actions.
#define ENVIRONMENT_ID "env_replace_me"
#define THREAD_ID "thread_replace_me"
#define DEFAULT_AGENT_PROMPT "Continue the current task, inspect progress, and run relevant tests."
#define DEFAULT_SHELL_COMMAND "npm test"

// TLS certificate validation is disabled in this scaffold so self-hosted HTTPS gateways work
// during bring-up. Pin the gateway certificate before production.
#define INSECURE_SKIP_TLS_VERIFY 1

// ---------------------------------------------------------------------------
// Display: ILI9341V, 240x320, 4-line SPI.
//
// Note LCD_RST: the panel's reset is tied to the ESP32-S3's own CHIP_PU rail, so
// there is no GPIO for it and the vendor examples pass -1. Resetting the panel
// means resetting the chip.
// ---------------------------------------------------------------------------
#define LCD_CS   10
#define LCD_DC   46   // high = data, low = command
#define LCD_RST  -1   // shared with CHIP_PU; no separate GPIO
// GPIO45 is also an ESP32-S3 STRAPPING PIN (VDD_SPI voltage select: low = 3.3 V, high = 1.8 V).
// The vendor wires the backlight to it and their own demos drive it high, so the board evidently
// tolerates that — most likely an external pulldown wins during the strap sampling window, or the
// VDD_SPI_FORCE eFuse is burned. Treat it as a hazard anyway: if a unit ever fails to boot after
// the backlight has been driven high, suspect this before anything else, and recover with a full
// power cycle rather than a warm reset so the strap is re-sampled with the pin released.
#define LCD_BL   45   // high = backlight on; STRAPPING PIN, see above
#define LCD_SCLK 12
#define LCD_MOSI 11
#define LCD_MISO 13

#define LCD_WIDTH  240
#define LCD_HEIGHT 320

// A 240x320 16 bpp framebuffer is 150 KB — it fits in SRAM, unlike the Waveshare's 466x466.
#define LCD_COLOR_DEPTH 16

// OFF by default, deliberately. The ILI9341 adapter in src/display.cpp is written but UNPROVEN:
// the first hardware flash that enabled it left the board unable to boot or enter download mode,
// and it had to be recovered with a manual power cycle. Until that is bisected, the default build
// must not be able to brick a unit. Build -e hosyond-es3c28p-display to work on it.
#ifndef ENABLE_LCD
#define ENABLE_LCD 0
#endif

// ---------------------------------------------------------------------------
// Shared I2C bus: FT6336G touch, the ES8311 codec, and the 4-pin external I2C
// header all hang off it. The vendor notes that if touch and audio are unused
// the header pins revert to ordinary IO — we use both, so they do not.
// ---------------------------------------------------------------------------
#define I2C_SDA_PIN 16
#define I2C_SCL_PIN 15
#define I2C_SPEED_HZ 400000
#define I2C_PORT_NUM 0

// FT6336G capacitive touch.
#define TOUCH_INT_PIN 17   // low when a touch event occurs
#define TOUCH_RST_PIN 18   // active low
#define TOUCH_I2C_ADDR 0x38

// ---------------------------------------------------------------------------
// Audio. The whole reason this board is a first-class target.
//
// One ES8311 mono codec handles BOTH directions: ADC for the on-board
// downward-facing MEMS microphone, DAC for the 1.25 mm speaker connector. That
// is simpler than the Waveshare AMOLED board, which needs an ES7210 for capture
// and an ES8311 for playback.
//
// The codec sits on the shared I2C bus at 0x18 (CE pin low). Audio data moves
// over I2S in Philips standard mode, 16 kHz, 16-bit — which is exactly what the
// gateway's transcription pipeline wants, so no resampling is needed on device.
//
// Driver: lib/ES8311, vendored from this board's own example pack. No external
// dependency, no network fetch.
// ---------------------------------------------------------------------------
#ifndef ENABLE_AUDIO_CAPTURE
#define ENABLE_AUDIO_CAPTURE 0
#endif

// 0 = standard I2S. The ES8311 is a codec on an I2S bus, not a PDM mic.
#ifndef AUDIO_MIC_PDM
#define AUDIO_MIC_PDM 0
#endif

// The vendor examples use I2S port 1; port 0 is left free.
#ifndef AUDIO_I2S_PORT
#define AUDIO_I2S_PORT 1
#endif

#define AUDIO_I2S_MCLK_PIN 4
#define AUDIO_I2S_BCLK_PIN 5
#define AUDIO_I2S_WS_PIN   7
#define AUDIO_I2S_DIN_PIN  6   // microphone in, from the ES8311 ADC
#define AUDIO_I2S_DOUT_PIN 8   // speaker out, to the ES8311 DAC

// Speaker amplifier enable. The vendor echo example drives this LOW before
// streaming, so treat LOW as enabled until a board says otherwise.
#define AUDIO_PA_ENABLE_PIN 1
#define AUDIO_PA_ENABLE_ACTIVE_LOW 1

#define ES8311_I2C_ADDR 0x18   // CE pin low. 0x19 if strapped high.

// Names the CrowPanel capture layer expects, mapped onto this board's bus.
#ifndef AUDIO_I2S_CLK_PIN
#define AUDIO_I2S_CLK_PIN AUDIO_I2S_BCLK_PIN
#endif
#ifndef AUDIO_I2S_DATA_PIN
#define AUDIO_I2S_DATA_PIN AUDIO_I2S_DIN_PIN
#endif

// 16 kHz mono, matching the gateway's transcription expectations and the codec
// driver's own EXAMPLE_SAMPLE_RATE. MCLK runs at 384x the sample rate.
#ifndef AUDIO_SAMPLE_RATE_HZ
#define AUDIO_SAMPLE_RATE_HZ 16000
#endif

#ifndef AUDIO_SLOT_BITS
#define AUDIO_SLOT_BITS 16
#endif

// The I2S channel is configured for stereo slots because that is what the codec
// clocks out; the capture path keeps the left channel and discards the right.
#ifndef AUDIO_CAPTURE_STEREO_SLOTS
#define AUDIO_CAPTURE_STEREO_SLOTS 1
#endif

#ifndef AUDIO_GAIN_SHIFT
#define AUDIO_GAIN_SHIFT 0
#endif

// Analogue microphone gain in the ES8311 itself, which is the right place to get level: raising it
// here uses the ADC's range, where AUDIO_GAIN_SHIFT only scales samples that were already
// quantised. The vendor's es8311_codec_init leaves this unset, and a bench measurement of a quiet
// room at default gain read peak 264 / rms 91 out of 32767 — far too quiet for speech.
// One of ES8311_MIC_GAIN_0DB, _6DB, _12DB, _18DB, _24DB, _30DB, _36DB, _42DB.
#ifndef AUDIO_MIC_GAIN
#define AUDIO_MIC_GAIN ES8311_MIC_GAIN_30DB
#endif

// Playback volume, 0..100, passed to es8311_voice_volume_set.
#ifndef AUDIO_PLAYBACK_VOLUME
#define AUDIO_PLAYBACK_VOLUME 85
#endif

// Push-to-talk bounds. 8 MB of PSRAM means the clip ceiling is a product
// decision, not a memory one — but keep it short: upload time and ASR latency
// both scale with it, and the gateway caps the decoded size.
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
// No camera on this board, so camera capture stays off and no pin map exists.
// ---------------------------------------------------------------------------
#ifndef ENABLE_CAMERA_CAPTURE
#define ENABLE_CAMERA_CAPTURE 0
#endif

// ---------------------------------------------------------------------------
// Buttons, LED, storage, battery.
// ---------------------------------------------------------------------------

// BOOT doubles as a general-purpose key once the board is running, and is the
// only button available to firmware — RESET is wired to the chip's reset line.
#define BOOT_BUTTON_PIN 0

// Hold BOOT this long to wipe Wi-Fi and re-enter provisioning, matching the
// CrowPanel's EXIT long-press recovery.
#ifndef PROVISIONING_RESET_HOLD_MS
#define PROVISIONING_RESET_HOLD_MS 10000
#endif

// Single-wire RGB LED with a built-in controller (WS2812-style). Useful as a
// recording indicator, which an e-ink board cannot do.
#define RGB_LED_PIN 42

// microSD over 4-bit SDIO.
#define SD_CLK_PIN 38
#define SD_CMD_PIN 40
#define SD_D0_PIN  39
#define SD_D1_PIN  41
#define SD_D2_PIN  48
#define SD_D3_PIN  47

// Battery sense. GPIO9 is ADC1_CH8; the board divides the cell voltage by two,
// so the measured millivolts must be doubled (the vendor example does exactly
// this). Feeds the existing heartbeat battery field.
#define BATTERY_ADC_PIN 9
#define BATTERY_ADC_CHANNEL 8
#define BATTERY_DIVIDER_RATIO 2

// 4-pin 1.25 mm expansion header.
#define EXPANSION_IO_A 2
#define EXPANSION_IO_B 3
#define EXPANSION_IO_C 14
#define EXPANSION_IO_D 21
