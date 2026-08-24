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

// Speaker amplifier enable (an FM8002E — its datasheet is in docs/…/4-数据手册_DataSheet/).
//
// This used to be recorded here as an inference from one vendor example driving it LOW. It is not
// an inference any more: the manufacturer's IO allocation table
// (docs/…/5-原理图_Schematic/ESP32-S3芯片IO资源分配表.xlsx, row "6 | GPIO1") states
// 音频功放IC使能引脚，低电平使能 — "audio power amplifier IC enable pin, LOW enables". Three
// vendor examples agree (Example_16_music, Example_17_echo, Example_30_ai_chat all
// digitalWrite(AP_ENABLE, LOW) before streaming).
//
// Only src/audio.cpp writes this pin, through audio::bus::setPaEnabled() — see src/audio_bus.h.
// The microphone path can force it off at any moment and the speaker task has to accept that,
// because an idle class-D amplifier hisses and the microphone is centimetres away.
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
// Speaker output — the ES8311's DAC half, driving the 1.25 mm speaker
// connector through the FM8002E amplifier on GPIO1.
//
// The codec needs no separate bring-up for this: es8311_codec_init() in
// lib/ES8311 already configures the DAC and sets a volume, so enabling output
// is a matter of powering the amplifier and writing to the I2S TX channel that
// src/audio.cpp created alongside the RX one. That is why ENABLE_SPEAKER
// requires ENABLE_AUDIO_CAPTURE and refuses to build without it.
//
// CAPTURE AND PLAYBACK SHARE ONE CODEC AND ONE I2S PORT. They can physically
// run at once — the ES8311 is full duplex and the vendor's Example_17_echo
// does exactly that — but this firmware refuses to, because there is no echo
// canceller anywhere on this board and anything the speaker plays during a
// recording is transcribed as part of the user's instruction. Recording wins;
// a cue asked for during a capture is dropped rather than queued. The rule and
// its edge cases are written out in src/audio_bus.h.
// ---------------------------------------------------------------------------
#ifndef ENABLE_SPEAKER
#define ENABLE_SPEAKER 0
#endif

// Outstanding cue requests. Deliberately tiny: this smooths two taps landing
// in one frame, it is not a playlist. A deep queue turns a flurry of taps into
// ten seconds of beeping after the flurry is over.
#ifndef SPEAKER_QUEUE_DEPTH
#define SPEAKER_QUEUE_DEPTH 3
#endif

#ifndef SPEAKER_TASK_STACK
#define SPEAKER_TASK_STACK 4096
#endif

// Above the Arduino loop task (priority 1) so a cue is not starved by the UI;
// far below the Wi-Fi tasks (~22) so it can never delay the radio. The task is
// pinned to core 0 because core 1 runs the render loop and the blocking
// gateway calls, and a beep that stutters because an HTTP POST is waiting on a
// socket is worse than no beep.
#ifndef SPEAKER_TASK_PRIORITY
#define SPEAKER_TASK_PRIORITY 4
#endif

// Silence clocked out after the amplifier is enabled and before the first tone,
// and again after the last tone before it is cut. Both are pop suppression:
// switching a class-D amplifier while the DAC sits at a non-zero level is an
// audible click, and on a 45 ms cue the click is most of what you hear. These
// are biased towards "no pop" rather than measured — the FM8002E datasheet in
// docs/ is where to tighten them once a board has been listened to.
#ifndef SPEAKER_PA_SETTLE_MS
#define SPEAKER_PA_SETTLE_MS 12
#endif
#ifndef SPEAKER_PA_TAIL_MS
#define SPEAKER_PA_TAIL_MS 8
#endif

// Ceiling on one i2s_channel_write. Blocks the playback task only, never a
// caller. If the DMA ring has not drained in this long the clock is wrong, and
// giving up beats hanging with the amplifier powered.
#ifndef SPEAKER_WRITE_TIMEOUT_MS
#define SPEAKER_WRITE_TIMEOUT_MS 250
#endif

// The private copy speakerPlayPcm() takes of a caller's clip, in mono samples.
// 16000 = 1 s at 16 kHz = 32 KB from PSRAM. Cues are synthesised and need none
// of this; the staging buffer exists so a future gateway-supplied TTS reply has
// somewhere to land, and so the bench can play a recording back. Allocation
// failure is not fatal — cues still work.
#ifndef SPEAKER_PCM_STAGE_SAMPLES
#define SPEAKER_PCM_STAGE_SAMPLES 16000
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

// ---------------------------------------------------------------------------
// Notification LED — one WS2812B-class addressable RGB LED on GPIO42.
//
// THE PIN IS VENDOR-DOCUMENTED, NOT GUESSED. Four sources agree:
//   1. docs/…/5-原理图_Schematic/ESP32-S3芯片IO资源分配表.xlsx, the maker's own
//      IO allocation table, row "48 | IO42":
//      单线RGB三色LED灯控制引脚 — "single-wire RGB tri-colour LED control pin".
//   2. The schematic PDF names the part XL-5050RGBC-WS2812B, one instance,
//      net RGB_LED.
//   3. docs/…/4-数据手册_DataSheet/ ships the LED's own datasheet,
//      RGB+LED(IC)_WS2812B-V5-W.PDF.
//   4. Example_06_RGB_LED and Example_15_RGB_LED_TOUCH both #define LED_PIN 42.
//
// GPIO42 is MTMS (JTAG TMS) and is NOT a strapping pin, so unlike LCD_BL on
// GPIO45 there is no boot hazard here — the board uses the internal
// USB-Serial-JTAG, leaving the pin free.
//
// WHAT IS STILL UNVERIFIED: no LED on this board has been lit by this firmware.
// Both vendor examples say LED_COUNT 60 and one says NEO_GRBW, which is
// unedited Adafruit strip-demo boilerplate — the schematic shows a single RGB
// (not RGBW) part. We drive one LED in GRB. Hence the feature ships OFF by
// default, the same convention ENABLE_LCD follows for unproven hardware.
// ---------------------------------------------------------------------------
#define RGB_LED_PIN 42

#ifndef ENABLE_NOTIFICATION_LED
#define ENABLE_NOTIFICATION_LED 0
#endif

// 40 Hz. Fast enough that a 300 ms crossfade has a dozen steps and no visible
// staircase; slow enough that the RMT frame cost disappears into a 33 ms
// render budget. ledTick() returns after one millis() comparison when the next
// update is not yet due, so calling it every loop pass is free.
#ifndef LED_TICK_INTERVAL_MS
#define LED_TICK_INTERVAL_MS 25
#endif

// Crossfade between two states. Long enough to read as a fade rather than a
// cut, short enough that "the microphone just opened" is unambiguous by the
// time a finger has finished pressing.
#ifndef LED_TRANSITION_MS
#define LED_TRANSITION_MS 300
#endif

// A WS2812B at full white draws roughly 60 mA, which is real money on a 3.7 V
// cell for a light nobody asked to be a torch. Every effect is scaled by this.
#ifndef LED_DEFAULT_BRIGHTNESS_PCT
#define LED_DEFAULT_BRIGHTNESS_PCT 55
#endif

// WS2812B wire order is green, red, blue. Set to 0 if a real board shows red
// and green swapped — this is the one property of the part the vendor examples
// contradict each other on, so it is a switch rather than a constant.
#ifndef LED_COLOR_ORDER_GRB
#define LED_COLOR_ORDER_GRB 1
#endif

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
