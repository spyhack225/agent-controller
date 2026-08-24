# Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen

Vendor materials live in [`docs/`](docs/) — schematic, specification, datasheets, and a 30-example
Arduino pack. This board's pin map and audio driver both come from there, not from guesswork.

**Status: compiles, never flashed.** No board has been in hand. Unlike the Waveshare AMOLED
scaffold, the audio path here is real code rather than a TODO, because the vendor shipped both a
verified pin table and a working codec driver.

## Why this board runs the full workflow

It has an on-board microphone **and** speaker, a capacitive touch screen, and 8 MB of PSRAM. That
is the same capability set as the Waveshare AMOLED board, with one structural simplification: a
single **ES8311 mono codec handles both directions** — ADC for the downward-facing MEMS microphone,
DAC for the speaker connector. The Waveshare board needs two chips for that (ES7210 to capture,
ES8311 to play), so this one is less driver work, not more.

Everything runs from on-board hardware. No Bluetooth headset, no external microphone, no cloud
audio service: press to talk, the ES8311 captures, the gateway transcribes.

| Capability | This board |
|---|---|
| Voice input | On-board MEMS microphone via ES8311 ADC, 16 kHz mono — exactly what the gateway's transcription pipeline expects, so no on-device resampling |
| Audio output | Speaker connector via ES8311 DAC, 1.5 W (8 Ω) or 2 W (4 Ω) |
| Typing / rich input | FT6336G capacitive touch, 240x320 — an on-screen keyboard fits a rectangular panel far better than the Waveshare's round one |
| Showing an agent reply | 2.8" IPS, 240x320, 262K colours |
| Clip memory | 8 MB OPI PSRAM; a 30 s 16 kHz mono clip is ~960 KB |
| Recording indicator | Single-wire RGB LED on GPIO42 |
| Portability | 3.7 V lithium connector with on-board charging; battery sense on GPIO9 |
| Storage | microSD over 4-bit SDIO |

### Against the Waveshare AMOLED board

Both are viable voice targets; they trade off differently.

- **Display.** 240x320 rectangular IPS here versus 466x466 round AMOLED there. Rectangular is far
  better for text and for an on-screen keyboard; AMOLED is better looking and has true blacks.
- **Framebuffer.** 150 KB at 16 bpp fits in SRAM here. The Waveshare's 434 KB must live in PSRAM.
- **Audio.** One codec here, two chips there. Simpler.
- **Echo cancellation.** The Waveshare has a dedicated ES7210 for it. This board does not, so
  simultaneous playback and capture will be worse — relevant only if we ever do barge-in.
- **Microphones.** One here, a two-mic array there. The array is better in a noisy room.
- **Enclosure.** The Waveshare ships in an aluminium case. This is a bare module.
- **Expansion.** This board exposes a 4-pin header (GPIO2, 3, 14, 21), a separate I2C header, a
  UART header, and microSD. The cased Waveshare may expose none of that.

Neither has a camera, so device-originated `camera_prompt` intents are impossible on both.

## Hardware

| | |
|---|---|
| MCU | ESP32-S3, Xtensa LX7 dual-core @ 240 MHz |
| Memory | 512 KB SRAM + 16 KB RTC SRAM + 84 KB ROM + **8 MB internal OPI PSRAM** |
| Flash | 16 MB external SPI |
| Display | 2.8" IPS 240x320, ILI9341V, 4-line SPI, white LED×4 backlight |
| Touch | FT6336G capacitive, I2C address 0x38 |
| Audio | ES8311 mono codec at I2C 0x18; on-board MEMS mic + speaker connector |
| Storage | microSD, 4-bit SDIO |
| Power | 5 V via USB-C; 3.7 V LiPo connector, ~290 mA charge current |
| Draw | 140 mA display only; 560 mA display + speaker + charging (2.8 W) |
| Buttons | BOOT (usable as a normal key), RESET (wired to chip reset) |
| USB | **Native USB CDC — no USB-to-UART bridge.** Windows 10+ only per the vendor note |
| SKU | ES3C28P is the touch variant; ES3N28P is the same board without touch |

### A vendor spec error worth knowing

The specification's parameter table claims **"Bluetooth V5.0 BR/EDR and Bluetooth LE standard"**.
That is wrong — it looks copy-pasted from an original ESP32 datasheet. The ESP32-S3 has **no
Bluetooth Classic (BR/EDR) radio at all**, only BLE. Do not let that line revive the idea that a
Bluetooth headset can be a microphone source here; it cannot, on this board or any other ESP32-S3.
The on-board microphone is the answer, which is the whole point of this board.

## Pin map

From the manufacturer's specification section 4.2 "ESP32-S3 pin allocation", cross-checked against
the vendor examples in `docs/`. Full detail in
[`include/controller_config.example.h`](include/controller_config.example.h).

| Function | Pins |
|---|---|
| LCD (ILI9341V) | CS 10, DC 46, SCLK 12, MOSI 11, MISO 13, BL 45; reset tied to CHIP_PU (no GPIO) |
| Touch (FT6336G) | SDA 16, SCL 15, RST 18, INT 17 |
| Audio I2S | MCLK 4, BCLK 5, WS 7, DOUT 8 (speaker), DIN 6 (mic); PA enable 1 |
| ES8311 | I2C 0x18, on the shared SDA 16 / SCL 15 bus |
| RGB LED | 42 |
| microSD SDIO | CLK 38, CMD 40, D0 39, D1 41, D2 48, D3 47 |
| Battery sense | 9 (ADC1_CH8), ÷2 divider |
| Expansion header | 2, 3, 14, 21 |
| BOOT key | 0 |

The I2C bus is shared between touch, the codec, and the external header — worth remembering before
assigning a new device to it.

## Toolchain

The whole firmware tree is pinned to **ESP-IDF 5.5 / Arduino core 3.3** via the
[pioarduino](https://github.com/pioarduino/platform-espressif32) platform fork.

Espressif stopped maintaining the official `platformio/platform-espressif32`, which is frozen at
Arduino 2.0.17 on ESP-IDF 4.4 — where `driver/i2s_std.h` does not exist and only the legacy I2S
driver is available. This board's vendored ES8311 driver and its capture path are both written
against the IDF 5.x I2S API, so the old platform could not build them.

All four boards and all nine environments were rebuilt and pass on the new platform, so the tree
runs one toolchain rather than two.

## Display configuration

Taken from the vendor's own init sequence, `docs/.../2-规格书_Specification/ILI9341V_Init.txt`,
which is the authority for this glass. Adafruit_ILI9341 handles almost all of it; one setting it
does not:

| Setting | Value | Why |
|---|---|---|
| **Display inversion** | **ON (`0x21`)** | **The one thing Adafruit's stock init omits.** Its sequence targets TN glass; this panel is IPS and the vendor sends INVON. Without it every colour is inverted — `fillScreen(BLACK)` renders white — which reads as a broken driver rather than a single wrong bit. Applied as `invertDisplay(true)`. |
| Pixel format `0x3A` | `0x55` | 16-bit RGB565. Matches the library default. |
| MADCTL `0x36` | BGR bit set | The vendor sets bit 3 (BGR) in every rotation. Adafruit also sets `MADCTL_BGR`, so rotations agree. |
| Reset | software only | The panel's reset is tied to CHIP_PU, so there is no GPIO for it. The constructor takes `-1` and the library issues a software reset instead. |
| SPI mode | 0 | Vendor `spi_dev.h`. |
| SPI clock | vendor uses 80 MHz | Adafruit defaults to 24 MHz. Safe, but this UI redraws an animated orb, so the bus is the budget — worth raising once the panel is confirmed working. |
| Interface control `0xF6` | `0x01, 0x30` | Panel-specific; the library's defaults have been fine on this controller elsewhere. |
| Gamma `0xE0`/`0xE1` | vendor curves | Panel-specific tuning. Only worth porting if the stock gamma looks wrong on real glass. |

## Audio driver

`lib/ES8311` is Espressif's Apache-2.0 ES8311 driver, vendored from this board's own example pack
(`Example_17_echo`) with exactly one line removed — an `#include` of the vendor's LVGL panel
config, which the driver never reads and which would drag their display setup into our build. See
[`lib/ES8311/README.md`](lib/ES8311/README.md).

Vendored rather than fetched, for the same reason the CrowPanel vendors `ElecrowEPD`: the audio
path must not depend on a network fetch or a third-party package that can move.

## What `src/main.cpp` does today

Boots, reports memory and battery, opens NVS, runs the shared provisioning state machine, and — in
the capture build — brings up I2C, I2S, and the ES8311, then implements push-to-talk:

- **Hold BOOT** to record from the on-board microphone into a PSRAM buffer.
- **Release** to stop. The clip is measured and reported: duration, sample count, peak, and RMS.
- Peak and RMS are what prove the microphone is alive without needing a speaker. A dead codec reads
  a flat zero, and the firmware says `SILENT` rather than leaving you to guess; a hot one pins at
  32767 and says `CLIPPING`.
- With `AUDIO_SELFTEST_PLAYBACK` (default on) the clip plays back through the speaker, verifying
  capture, the codec, and output in one press, entirely offline.
- **Hold BOOT for 10 s** to wipe Wi-Fi and re-enter provisioning, matching the CrowPanel's EXIT
  long-press recovery.

## What is missing

In dependency order:

1. **The gateway client.** This is the blocker, and it is not board-specific. Heartbeat, display
   state, intent submission, OTA, and media upload all still live inside the CrowPanel's 3652-line
   `src/main.cpp`; only `DeviceStore` and `Provisioning` are in `firmware/shared`. Extract it once
   into `AgentControllerCore` and both new boards can talk to the gateway. Until then the capture
   path stops at "clip recorded and measured".
2. **Upload wiring.** `POST /v1/device/media` then an `audio_prompt` intent — the sequence the
   CrowPanel capture build already exercises. Note the gateway does not currently auto-transcribe
   device audio; that gap is Category 2 of the
   [open-input roadmap](../../roadmap/open-input-media-voice-environments-roadmap.md).
3. **ILI9341V display** over SPI, then **FT6336G touch** over I2C.
4. **On-screen UI:** thread list, agent reply, approve/reject, and a push-to-talk target better
   than the BOOT key.
5. **RGB LED** as a recording indicator.
6. **On-screen keyboard**, once voice works. Voice first — the keyboard is for correcting a
   transcript.

## What is unverified

1. **Nothing has run on hardware.** Verified on paper is not verified on metal.
2. **`AUDIO_PA_ENABLE_ACTIVE_LOW`.** The vendor echo example drives GPIO1 LOW before streaming, so
   the config assumes LOW means enabled. That is an inference from one example, not a datasheet
   statement.
3. **Microphone gain.** `es8311_codec_init()` leaves `es8311_microphone_gain_set` commented out, as
   the vendor shipped it. Expect to need it once real levels are measured.
4. **The partition table.** 16 MB dual-slot OTA, arithmetic checked and contiguous, but never
   flashed.
5. **PSRAM and USB CDC settings.** The build applies `qio_opi` and native USB, per the vendor spec.
   `src/main.cpp` prints detected PSRAM and flash at boot so the first flash confirms both.

## Build

```
pio run -e hosyond-es3c28p              # bring-up, audio off
pio run -e hosyond-es3c28p-capture      # microphone + speaker enabled
```

Copy `include/controller_config.example.h` to `include/controller_config.h` first. Wi-Fi
credentials are deliberately not in it — the owner enters them through the SoftAP portal and they
live in NVS.
