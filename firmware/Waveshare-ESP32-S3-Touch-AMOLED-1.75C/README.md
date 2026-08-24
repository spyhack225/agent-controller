# Waveshare ESP32-S3-Touch-AMOLED-1.75C

Vendor documentation: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.75C>

**Status: scaffold. Compiles, never flashed.** Both environments build clean against
`espressif32` + Arduino (bring-up image: 761 KB flash, 46 KB RAM), which confirms the toolchain,
the 16 MB partition table, and the shared-core wiring. No board has been in hand, so nothing here
has run on silicon, and the pin map is transcribed from community sources for the non-cased
variant. See [What is unverified](#what-is-unverified).

## Verdict: suitable, and the best voice target we have

This board solves the problem that the
[open-input roadmap](../../roadmap/open-input-media-voice-environments-roadmap.md) Category 4 was
stuck on, and it solves it with an off-the-shelf part instead of a custom PCB.

That roadmap concluded that arbitrary voice input from the controller needed either a phone
companion or "a carrier-board BOM with a supported two-wire PDM microphone… validate pin conflicts,
enclosure acoustics, PSRAM, and power." That work is now avoidable for prototyping: this board ships
a dual-microphone array, an ES7210 echo-cancellation ADC, an ES8311 codec, speaker pads, 8 MB of
PSRAM, a PMIC, and a battery connector, already integrated and already in an enclosure.

What it unlocks:

| Roadmap problem | How this board answers it |
|---|---|
| "The device is too small to support typing input" | 466x466 capacitive touch. An on-screen keyboard becomes possible, and voice becomes comfortable rather than a workaround |
| Category 4 needs a microphone and the CrowPanel has none | Dual-mic array with hardware echo cancellation, on board |
| Audio buffers need memory the CrowPanel does not have | 8 MB octal PSRAM; a 30 s 16 kHz mono clip is ~960 KB |
| Push-to-talk needs a comfortable control | Touch screen, plus a 6-axis IMU that makes raise-to-talk viable |
| The controller cannot show an agent's reply | A colour 466x466 panel can render real text; the 122x250 e-ink cannot |
| Nothing reads results back | ES8311 plus speaker pads — text-to-speech playback is available if we want it |

## What it does not solve

**Bluetooth earbuds still do not work, and this board does not change that.** The original request
was to pair wireless earphones with the controller. The ESP32-S3R8 provides Bluetooth 5 (LE) only —
no Bluetooth Classic, so no HFP headset profile, and no LE Audio stack. That is a property of the
chip, not the board, so this hardware has exactly the same limitation as the CrowPanel. The
difference is that it no longer matters much: with a good on-board microphone array the earbuds were
only ever a means to get a microphone.

Other gaps, in rough order of how much they cost us:

- **No camera.** A `camera_prompt` intent cannot originate from this device. The CrowPanel could at
  least host one on a carrier board; here there is no MIPI or DVP interface at all.
- **Power.** An always-on AMOLED is in a different class from e-ink. The CrowPanel can hold a status
  screen for days on a battery; this board cannot, and Waveshare publishes no consumption figures.
  Expect a screen-off-by-default design with wake on touch or IMU, and measure before promising
  anything. This is the main reason it complements the e-ink controller rather than replacing it.
- **Two buttons.** PWR and BOOT only, versus the CrowPanel's five keys. Every other control has to
  be on the touch screen, and PWR is read over I2C through the AXP2101 rather than as a GPIO.
- **Round display.** 466x466 is round, so a rectangular keyboard layout wastes the corners and text
  needs a safe inset. Design for it rather than porting a rectangular layout.
- **Little expansion.** The non-cased 1.75 exposes an 8-pin header with 3 GPIOs and 1 UART, plus a
  microSD slot. Whether the aluminium case leaves either reachable on the 1.75C is unconfirmed.
- **It is a development board in a case, not a product SKU.** Fine for the prototype and for
  internal beta units. Shipping it means either reselling Waveshare hardware or treating this as the
  reference design for our own board.

## Recommendation

Buy one and make it the voice prototype. Keep the CrowPanel e-ink board as the low-power always-on
status controller; they are complements, not competitors, and the shared core already exists to
support both.

Do not block the software voice work on this hardware arriving. The roadmap's Milestone 3 (the
Parakeet pipeline) and Milestone 4 PWA companion path are both independent of it, and the phone
companion remains the fastest route to voice for real users.

## Hardware

| | |
|---|---|
| MCU | ESP32-S3R8, dual-core Xtensa LX7 @ 240 MHz, 512 KB SRAM + 384 KB ROM |
| PSRAM | 8 MB octal (hence `memory_type = qio_opi`) |
| Flash | 16 MB |
| Display | 1.75" round AMOLED, 466x466, CO5300 controller, QSPI |
| Touch | CST9217 capacitive, two-point, I2C |
| Audio in | Dual-microphone array into an ES7210 ADC (I2S/TDM) |
| Audio out | ES8311 codec, speaker pads, PA enable on GPIO46 |
| Power | AXP2101 PMIC, 3.7 V MX1.25 battery header, USB-C |
| Motion | QMI8658 6-axis IMU |
| Other | On-board RTC |
| Radio | Wi-Fi 2.4 GHz, Bluetooth 5 (LE only — no Classic, no LE Audio) |
| Buttons | PWR (via AXP2101), BOOT |

## What is unverified

Nothing here has been checked against hardware or against a 1.75C schematic. Specifically:

1. **Every GPIO in `include/controller_config.example.h`.** They come from the ESPHome community
   device profile for the **non-cased** ESP32-S3-Touch-AMOLED-1.75. The "C" is understood to denote
   the aluminium-alloy cased variant of the same PCB, but Waveshare's 1.75C page publishes no pin
   table and that assumption has not been confirmed. Confirm before driving any rail — a wrong panel
   power or PA enable pin is the kind of mistake that damages hardware.
2. **The ES7210 I2C address**, which is strap-selectable.
3. **Whether the microSD slot and the 8-pin expansion header survive the case.**
4. **The partition table on hardware.** `partitions_ota.csv` is a 16 MB layout scaled from the
   CrowPanel's 8 MB table. The arithmetic is contiguous and exactly fills 16 MB, and the build
   applies it (the linker reports a 5 MB app slot), but it has never been flashed. The CrowPanel's
   was confirmed byte-for-byte against real silicon; this one has not been.
5. **That the build matches the board.** Both environments compile, but a clean compile only proves
   the toolchain and the code are consistent — it says nothing about whether `qio_opi`, the flash
   size, or the native-USB CDC setting are right for this hardware. `src/main.cpp` prints the
   detected PSRAM and flash size at boot precisely so the first flash answers that.
6. **Power consumption**, for which Waveshare publishes nothing.

## Port plan

The order matters: the PMIC gates the rails everything else needs.

1. **Bring-up.** Flash `src/main.cpp` as-is. It boots, opens NVS, runs the shared provisioning state
   machine, and prints memory and identity over USB serial. This confirms the board, the partition
   table, the PSRAM configuration, and the SoftAP portal without touching an unverified pin.
2. **Confirm the pin map** against the 1.75C schematic and correct
   `include/controller_config.example.h`. Everything below depends on this.
3. **AXP2101 over I2C.** Rails first. Battery telemetry feeds the existing heartbeat fields.
4. **Extract the gateway client into `firmware/shared`.** This is the real work, and it is not
   board-specific. Today the heartbeat, display-state fetch, intent submission, OTA, and media
   upload all live inside the CrowPanel's 3652-line `src/main.cpp`; `DeviceStore`, `Provisioning`,
   and `ThinkingOrb` are shared. A third board makes that duplication untenable — port the client once,
   into `AgentControllerCore`, and let each board supply a display adapter.
5. **CO5300 panel over QSPI**, framebuffer in PSRAM. Waveshare's engineering-sample sources
   (<https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75>) or an LVGL port are the
   candidates. Vendor the driver in `lib/` the way the CrowPanel vendors `ElecrowEPD`.
6. **CST9217 touch**, then the on-screen UI: thread list, agent reply text, approve/reject, and
   push-to-talk.
7. **ES7210 microphone array.** The one genuinely new driver: an I2C register init, then a standard
   I2S read. Note this is neither of the two modes the CrowPanel capture layer supports — it is not
   PDM, and it is not a bare I2S MEMS mic that needs no configuration. Downmix the array to mono at
   16 kHz before upload; the ASR discards the second channel.
8. **Wire capture to the existing endpoints.** `POST /v1/device/media` then an `audio_prompt` intent
   already works and is exercised by the CrowPanel capture build — reuse it rather than inventing a
   path. Note the gateway does not currently auto-transcribe device audio; that gap is Category 2 of
   the roadmap.
9. **On-screen keyboard**, once voice is working. Voice first: it is the better input on a round
   466x466 panel, and the keyboard is the fallback for correcting a transcript.
10. **Power profile.** Measure idle, screen-on, Wi-Fi-active, and recording draw against the battery
    before committing to any runtime claim.

## Build

```
pio run -e waveshare-amoled-175c              # bring-up, audio off
pio run -e waveshare-amoled-175c-capture      # audio capture enabled
```

Copy `include/controller_config.example.h` to `include/controller_config.h` first. Wi-Fi credentials
are deliberately not in it — they are entered by the owner through the SoftAP portal and stored in
NVS. Hold BOOT for 10 seconds to wipe them and re-enter provisioning.

## Vendor documents

`docs/` is empty. Add the 1.75C schematic, the CO5300 and CST9217 datasheets, and the ES7210/ES8311
datasheets here, following the pattern of the other board folders — the pin map above stays
unverified until the schematic is in this directory.
