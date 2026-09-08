# Waveshare ESP32-S3-Touch-AMOLED-1.75C

Vendor documentation: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.75C>

**Status: network bring-up scaffold, never flashed.** The source now uses the shared authenticated
gateway client for heartbeat, claim-code caching, credential rotation, firmware-manifest
observation, and link truth (`unclaimed`, `claimed`, `revoked`, or `unreachable`). BOOT tap reopens
configuration without erasing working Wi-Fi; a 10-second hold clears owner setup while preserving
the factory identity.

This is deliberately not a usable controller yet. Its heartbeat advertises no `display`,
`thread_picker`, `microphone`, or `camera`, and the shared client therefore does not poll operate
resources for it. USB serial reports provisioning/link transitions and the claim code for bring-up;
it is not counted as customer UI or remote-operation parity. No board has been in hand, so nothing
here has run on silicon, and the pin map is transcribed from community sources for the non-cased
variant. See [What is unverified](#what-is-unverified).

Both isolated placeholder-config environments compile from the current source. Each uses 51,684
bytes of static RAM (15.8% of the build target) and 1,095,187 bytes of its 5 MiB app slot (20.9%).
That is compile evidence only; it does not validate the board definition or any physical path.

## Implemented safe path

- NVS factory identity seed and owner-managed SoftAP Wi-Fi/gateway provisioning.
- Fail-closed shared TLS gate for every device-credential request.
- Background heartbeat and event tasks, so gateway I/O does not stall the provisioning/recovery
  loop.
- Stable cached claim code plus explicit claimed, revoked, unreachable, and missing-identity states.
- Two-step device-credential rotation and OTA rollback observation from the shared core; OTA apply
  remains disabled.
- BOOT tap to reopen configuration without data loss, and BOOT hold to clear owner setup without
  erasing the factory identity.

Environment/project/thread browsing, controls, command outcome rendering, approvals, responses,
AMOLED, touch, microphone, speaker, battery telemetry, and OTA apply remain unavailable on this
board. The shared APIs exist, but wiring them before input/output hardware works would be a false
capability claim.

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
5. **That the build matches the board.** A clean compile only proves
   the toolchain and the code are consistent — it says nothing about whether `qio_opi`, the flash
   size, or the native-USB CDC setting are right for this hardware. `src/main.cpp` prints the
   detected PSRAM and flash size at boot precisely so the first flash answers that.
6. **Power consumption**, for which Waveshare publishes nothing.

## Port plan

The order matters: the PMIC gates the rails everything else needs.

1. **Bring-up.** Flash `src/main.cpp` as-is. It boots, opens NVS, runs shared provisioning plus the
   authenticated claim/heartbeat path, and prints memory, identity, provisioning, and gateway-link
   transitions over USB serial. This is designed not to touch an unverified peripheral pin.
2. **Confirm the pin map** against the 1.75C schematic and correct
   `include/controller_config.example.h`. Everything below depends on this.
3. **AXP2101 over I2C.** Rails first. Battery telemetry feeds the existing heartbeat fields.
4. **CO5300 panel over QSPI**, framebuffer in PSRAM. Waveshare's engineering-sample sources
   (<https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75>) or an LVGL port are the
   candidates. Vendor the driver in `lib/` the way the CrowPanel vendors `ElecrowEPD`.
5. **CST9217 touch**, then the on-screen UI. Only after the rendered list and confirmed touch target
   work should the heartbeat enable `display` and `thread_picker` and the board call the shared
   environment/project/thread, controls, command-result, approvals, and response APIs.
6. **ES7210 microphone array.** The one genuinely new driver: an I2C register init, then a standard
   I2S read. Note this is neither of the two modes the CrowPanel capture layer supports — it is not
   PDM, and it is not a bare I2S MEMS mic that needs no configuration. Downmix the array to mono at
   16 kHz before upload; the ASR discards the second channel.
7. **Wire capture to the shared raw upload-session client and assigned capture control.** Enable the
   `microphone` capability only after the ES7210 path produces a measured, gap-free clip. Reuse the
   shared media/action contract rather than inventing a board route.
8. **On-screen keyboard**, once voice is working. Voice first: it is the better input on a round
   466x466 panel, and the keyboard is the fallback for correcting a transcript.
9. **Power profile.** Measure idle, screen-on, Wi-Fi-active, and recording draw against the battery
    before committing to any runtime claim.

## Build

```
pio run -e waveshare-amoled-175c              # safe claim/health scaffold
pio run -e waveshare-amoled-175c-capture      # compile probe only; microphone still unadvertised
```

Copy `include/controller_config.example.h` to `include/controller_config.h` first. Wi-Fi credentials
are deliberately not in it — they are entered by the owner through the SoftAP portal and stored in
NVS. Tap BOOT to reopen configuration without erasing them. Hold BOOT for 10 seconds to clear
owner setup and re-enter provisioning; the factory device ID and secret remain intact.

## Vendor documents

`docs/` is empty. Add the 1.75C schematic, the CO5300 and CST9217 datasheets, and the ES7210/ES8311
datasheets here, following the pattern of the other board folders — the pin map above stays
unverified until the schematic is in this directory.
