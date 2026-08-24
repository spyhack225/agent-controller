# Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen

Vendor materials live in [`docs/`](docs/) — schematic, specification, datasheets, and a 30-example
Arduino pack. This board's pin map and audio driver both come from there, not from guesswork.

**Status: hardware-proven prototype with a full touch UI; five environments compile.** The board has
been flashed and used to verify 8 MB PSRAM, 16 MB flash, battery telemetry, SoftAP provisioning, the
ES8311 codec and on-board microphone, the ILI9341 display, panel polarity, and the animated orb.

The five screens, the touch routing, media upload, and every gateway call behind them **have not run
on silicon** — they compile and no board has been attached since they were written. What is proven is
the layer underneath: the orb, the panel, the codec, NVS, and provisioning. See the
[canonical implementation ledger](../../roadmap/IMPLEMENTATION-STATUS.md).

## Why this board runs the full workflow

It has an on-board microphone **and** speaker, a capacitive touch screen, and 8 MB of PSRAM. That
is the same capability set as the Waveshare AMOLED board, with one structural simplification: a
single **ES8311 mono codec handles both directions** — ADC for the downward-facing MEMS microphone,
DAC for the speaker connector. The Waveshare board needs two chips for that (ES7210 to capture,
ES8311 to play), so this one is less driver work, not more.

Capture runs from on-board hardware. No Bluetooth headset or external microphone is required: the
ES8311 records locally today; the planned shared gateway client and CPU-hosted Parakeet service will
handle upload and transcription.

| Capability | This board |
|---|---|
| Voice input | On-board MEMS microphone via ES8311 ADC, 16 kHz mono — exactly what the gateway's transcription pipeline expects, so no on-device resampling |
| Audio output | Speaker connector via ES8311 DAC through an FM8002E amplifier, 1.5 W (8 Ω) or 2 W (4 Ω). Driven by `src/speaker.cpp` — seven UI cues and a PCM path |
| Typing / rich input | FT6336G capacitive touch, 240x320 — an on-screen keyboard fits a rectangular panel far better than the Waveshare's round one |
| Showing an agent reply | 2.8" IPS, 240x320, 262K colours |
| Clip memory | 8 MB OPI PSRAM; a 30 s 16 kHz mono clip is ~960 KB |
| Recording indicator | Single-wire WS2812B RGB LED on GPIO42, driven by `src/led.cpp` — seven breathing states |
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

All four boards and all 12 environments were rebuilt and pass on the new platform, so the tree
runs one toolchain rather than two.

## Display configuration

Taken from the vendor's own init sequence, `docs/.../2-规格书_Specification/ILI9341V_Init.txt`,
which is the authority for this glass. Adafruit_ILI9341 handles almost all of it; one setting it
does not:

| Setting | Value | Why |
|---|---|---|
| **Display inversion** | **corrected in software, not by `0x21`** | The vendor's sequence sends INVON, but on real glass this panel's polarity does not respond to INVON or INVOFF at all — both were flashed and photographed and the screen was identical. Sending it on top of Adafruit's own init simply cancelled out. So every colour goes through `panelGrey()` / `panelRgb()` in `src/display.h` instead, where the bytes are ours and the result is deterministic. Do not "restore" `invertDisplay(true)` from the vendor file without looking at the panel. |
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

## Speaker output

`src/speaker.h` is the whole surface: `speakerBegin()`, `speakerSetVolume(pct)`,
`speakerPlayCue(cue)`, `speakerPlayPcm(samples, count, rateHz)`, `speakerBusy()`, `speakerStop()`.
Seven cues — tap, confirm, error, turn-complete, approval-needed, recording-start, recording-stop —
synthesised as sine segments under a raised-cosine envelope, because a tone that starts on a step
is a click and on a 45 ms cue the click is most of what you hear.

**Nothing here waits for a sound to finish.** A cue is handed to a FreeRTOS task pinned to core 0
and the caller returns in microseconds; the render loop in `src/ui.cpp` has a 33 ms budget and the
shortest cue is 45 ms, so a synchronous API could not be called from the place that knows a button
was tapped. Core 0 rather than core 1 because core 1 runs the panel, touch, and the blocking
gateway calls — a beep that stutters because an HTTP POST is waiting on a socket is worse than no
beep. The one call that touches I2C, `speakerSetVolume()`, deliberately runs on the *caller's*
thread so the shared `Wire` bus is only ever driven from the core that already polls touch.

The ES8311 needs no separate bring-up for output: `es8311_codec_init()` already configures the DAC
and sets a volume, so `ENABLE_SPEAKER` requires `ENABLE_AUDIO_CAPTURE` and `#error`s without it
rather than half-building.

### Capture and playback share one codec — the arbitration rule

Both directions run on one ES8311, one I2S port, one MCLK, one amplifier enable line. The rule,
written out in full in [`src/audio_bus.h`](src/audio_bus.h), is:

> **Recording wins, always, and a cue is dropped rather than deferred.**

- While a capture is live the speaker task starts nothing and aborts anything already sounding, at
  the next DMA chunk boundary (16 ms).
- A cue requested during a capture is **discarded, not queued**. A cue is feedback about something
  the person just did; playing it eleven seconds later when the clip finally ends is not late
  feedback, it is a mystery noise — and deferral would make the queue longest exactly when the user
  is mid-sentence, so every beep would arrive in a burst at the release.
- Capture never waits for playback. `startRecording()` is on the finger-lift path of the render
  loop and may not block on a task on the other core, so it signals and proceeds.
- The amplifier is forced off by capture regardless of what the speaker task believed. An idle
  class-D amp hisses, and it hisses into the microphone.

**It is worth being precise about why**, because the obvious explanation is wrong. This is *not* a
half-duplex codec taking turns. The ES8311 has an independent ADC and DAC, `i2s_new_channel()`
hands back a tx and an rx handle on the same port precisely so both can run at once, and the
vendor's own `Example_17_echo` streams capture straight back out to the speaker in real time.
Simultaneous playback and capture **works** on this silicon.

It is refused anyway, for an acoustic reason that is worse than a driver limitation because no
amount of correct code fixes it: the speaker connector and the downward-facing MEMS microphone are
centimetres apart, and unlike the Waveshare AMOLED board there is no ES7210 and no echo canceller
anywhere in the chain. A confirmation beep played while recording is a confirmation beep
transcribed by Parakeet and dispatched to somebody's shell as part of their instruction. The rule
is a product rule, deliberately stricter than the hardware requires.

Two generation counters rather than two flags make it correct rather than nearly correct.
`captureGeneration()` distinguishes "no capture happened" from "a whole capture started and
finished while the speaker task was not looking" — a plain boolean misses the second, and the tail
of the cue plays into the tail of the clip. `stopGeneration` does the same for `speakerStop()`: a
flag that the task cleared as it picked up each request cancelled the sound that was playing and
then let the very next queued cue straight through.

## Notification LED

One WS2812B-class addressable RGB LED on **GPIO42**, driven from `src/led.h`: `ledBegin()`,
`ledSetState(state)`, `ledTick()`, plus `ledSetBrightness(pct)`.

Seven states — Idle, Connecting, Listening, Thinking, NeedsApproval, Error, Offline — and **not one
hard blink in the file**. Every effect is a continuous function of time, a raised cosine or a sum
of them, crossfaded over 300 ms when the state changes, gamma-corrected so the ramp looks linear to
the eye. The board's visual language is already the Thinking Orb, which morphs rather than cuts;
a blinking LED reads as a fault indicator on consumer hardware, which is precisely the wrong thing
to say about an agent that is merely thinking.

Listening is red with the brightest floor of any state, because a live microphone is red on every
device anybody owns and this is the one state where being understood across a room beats being
pretty. Error is told apart from it by **rhythm** rather than hue — three grouped pulses against a
continuous breath — because "is that reddish or that other reddish" is not a distinction people
make at a glance, and colour-blind users make it never.

`ledTick()` paces itself to 40 Hz and returns after one `millis()` comparison when an update is not
due. When one is due it costs a few floating-point operations and one **asynchronous** 24-bit RMT
transmission it does not wait for. It uses the Arduino core's RMT peripheral driver directly rather
than `Adafruit_NeoPixel`, whose `show()` disables interrupts and busy-waits for the whole frame —
that is what lets `ledTick()` be honest about being non-blocking.

### The pin is vendor-documented, not guessed

Four independent sources in `docs/` agree, which is why this is not behind an "unverified default"
caveat the way an inferred pin would be:

| Source | What it says |
|---|---|
| `5-原理图_Schematic/ESP32-S3芯片IO资源分配表.xlsx`, row **48 \| IO42** | 单线RGB三色LED灯控制引脚 — "single-wire RGB tri-colour LED control pin". The same sheet the rest of this board's pin map came from |
| `2.8inch_ESP32-S3_Display_Schematic.pdf` | names the part **XL-5050RGBC-WS2812B**, one instance, net `RGB_LED` |
| `4-数据手册_DataSheet/RGB+LED(IC)_WS2812B-V5-W.PDF` | the LED's own datasheet ships in the pack |
| `Example_06_RGB_LED`, `Example_15_RGB_LED_TOUCH` | both `#define LED_PIN 42`, Adafruit_NeoPixel at 800 kHz |

GPIO42 is MTMS (JTAG TMS) and is **not** a strapping pin, so unlike the backlight on GPIO45 there
is no boot hazard here — the board uses the internal USB-Serial-JTAG, leaving the pin free.

One detail is *not* confirmed: both vendor examples declare `LED_COUNT 60`, and `Example_06`
declares `NEO_GRBW`. Both are unedited Adafruit strip-demo boilerplate — the schematic shows a
single RGB (not RGBW) part and `Example_15` uses `NEO_GRB`. We drive one LED in GRB order. If a
real board lights up with red and green swapped, `LED_COLOR_ORDER_GRB` is the switch.

## The screens

`src/ui.cpp` owns the screens; `src/ui_paint.cpp` owns the shapes they are drawn from.

**There is no tab bar.** Navigation is a status drawer pulled down out of the header, and the bottom
of the screen carries a contextual action bar that is drawn only while there is something to press.
A permanent five-tab strip spent 42 px advertising four destinations that were usually inert; the
drawer says what is actually true of the device and doubles as the way to the screen that fixes it.

- **Pull down, or tap the header**, for DEVICE / GATEWAY / THREAD / ACTIVITY — each a one-line
  status and each a route to where that thing is changed. Only the rows the device's state justifies
  are drawn: an unclaimed unit has no thread and no activity, because every route behind both
  answers 403.
- **The action bar** carries at most three things, all of them doable on the screen in front of you:
  APPROVE/REJECT on a held command, SEND/DISCARD on a recorded clip, PREV/NEXT on a paged reply,
  RETRY on a failed turn, RELOAD on an empty list. When it has nothing, it is not drawn and those
  58 px belong to the content.
- **A vertical drag** scrolls a list, **a horizontal swipe** pages the response, and **a drag that
  started in the header** pulls the drawer. One gesture, one meaning, decided by where the finger
  landed rather than by where it ended up.

| Screen | What it is for |
|---|---|
| **HOME** | The orb, the selected thread, and the last thing that happened. The orb's mode comes from `orbModeForAgentState()`, fed by the best signal the device protocol carries: a live recording, then a response still arriving, then the selected thread's status |
| **THREADS** | The thread list, scrolled with a finger; tapping a row selects it. The breadcrumb capsule at the top shows the bound environment and folder, and opens the browser |
| **ENVIRONMENTS** | Which paired T3 host this controller drives. Tapping a row `POST`s it and clears the folder and thread, because those ids only meant something inside the environment being left |
| **FOLDERS** | The projects inside the bound environment, each with its thread count. There is no "all folders" row: `POST /v1/device/config/project` reads `projectId` as a required string, so widening the scope again is a console operation |
| **SEND** | Hold-to-talk at the top, saved actions below. There is no keyboard and there will not be one: on this device a request is voice or a choice the owner saved earlier |
| **REPLY** | The assistant's answer, paged. The gateway wraps to 31 characters for a 122x250 e-ink panel; this screen re-joins and re-wraps to 19 so the text can be size 2 and read at arm's length |
| **APPROVALS** | One held command at a time with REJECT and APPROVE. Approve goes through a second confirm, because it runs on the owner's own machine |
| **DEVICE** / **GATEWAY** | Identity, Wi-Fi, model, URL, link and probe state, with the config portal and the provisioning reset behind them. Both stay reachable on an unclaimed unit, because they are what somebody opens when the claim screen is not working |

An unclaimed device gets none of the thread-shaped screens. It shows the claim code and the three
steps to use it, with no action bar at all — rotating the code invalidates the number the owner may
be part-way through typing, so it stays behind a deliberate tap on the code itself.

### Environment -> project -> thread

The gateway grew device-facing endpoints for the two levels above a thread
(`docs/hardware-protocol.md`, "Environment, project, and thread API"), and
`firmware/shared/AgentControllerCore/src/GatewayBrowse.cpp` is the client for them:
`GET/POST /v1/device/environments` and `/v1/device/projects`, in their own translation unit with
their own state rather than as new members on `GatewayClient`.

Older comments in this tree still say a picker is impossible because `GET /v1/device/threads` is
the only list the protocol offers. That was true and is not any more.

### The shapes

The orb is an anti-aliased point cloud with no straight edge in it, and everything drawn beside it
used to be a hard-cornered `fillRect` and a one-pixel rule. `displaySoftRoundRect`,
`displaySoftSegment` and `displaySoftArcDivider` in `src/display.cpp` composite a signed distance
field through the same DMA staging row the orb blit already uses — no second buffer, and a
`feather` that can be wider than a pixel where an edge should read as soft rather than merely
un-jagged. Separators are shallow arcs that fade out before either bezel; every button is a
capsule; the drawer and the action tray are surfaces that slide, eased, rather than appearing.

### Push-to-talk

Holding the microphone button records into PSRAM, releasing uploads and dispatches. The recording
runs as a state the frame loop pumps rather than a blocking `while (key down)` loop — the old
version could not see the finger lift, and the orb stopped for the duration of the clip.

On release the clip goes to `POST /v1/device/media` as base64 streamed straight into the TCP buffer,
then to the owner's saved capture action if there is one, or to a plain `audio_prompt` on the
selected thread if there is not.

## What `src/main.cpp` does today

Boots, reports memory and battery, opens NVS, brings up the panel, touch, the codec, and the shared
provisioning state machine, then runs the loop that drives the gateway client and the UI. It is the
board — pins, radios, the one physical button — and nothing in it knows what a thread is.

- **Tap BOOT** to reopen the configuration portal without erasing otherwise-valid Wi-Fi credentials.
  This is the escape hatch for a mistyped gateway URL.
- **Hold BOOT for 10 s** to wipe Wi-Fi and re-enter provisioning, matching the CrowPanel's EXIT
  long-press recovery. This is the way back from a revoked device, a house move, or a resale.
- BOOT no longer records. It was overloaded three ways and the screen is the interface now.

### Hardware evidence recorded on 2026-08-24

- 8 MB PSRAM and 16 MB flash detected at runtime.
- Battery telemetry reported 4116 mV on the connected unit.
- ES8311 acknowledged and the boot microphone self-test produced non-zero, non-clipping samples
  (`peak 779`, `RMS 284`, `DC offset 12`) at 30 dB gain in a quiet room.
- SoftAP provisioning and the BOOT recovery path ran on the board.
- The ILI9341 panel initialized after the ES8311/Adafruit stack was unified on the same `Wire`
  driver generation; IPS inversion and the orb UI were then exercised visually. Internal-buffer,
  anti-alias, and flicker tuning is still active.

## What is missing

In dependency order:

1. **OTA.** `partitions_ota.csv` is in place, but the manifest poll, the download, and the
   `confirmFirmwareIfPendingVerify()` rollback confirm still live only in the CrowPanel's
   `src/main.cpp`. A board that cannot be updated in the field is a board that has to come back.
2. **Gateway profiles.** The two-phase LAN/tailnet switch protocol is likewise unported, so
   `config.gatewayUrl` is read and ignored rather than persisted unprobed.
3. **On-screen keyboard**, for correcting a transcript rather than for composing a request.
4. **Automatic transcription of device audio.** The gateway does not currently transcribe an upload
   that arrives from a device; that gap is Category 3 of the
   [open-input roadmap](../../roadmap/open-input-media-voice-environments-roadmap.md).

## What is unverified

1. **Everything on the glass.** Every screen, the status drawer, the action bar, all the soft
   shapes, every tap target, the list scrolling, push-to-talk, media upload, and every gateway call
   behind them were written without a board attached. They compile; nothing has been executed. The
   frame cost of the drawer's largest slide frame — a 240x240 distance-field fill plus its band
   clear — is estimated, not measured: read `draw<=` off the `[fps]` line on real hardware before
   believing it.
2. **The touch coordinate mapping.** `src/touch.cpp` maps the FT6336G's frame onto the panel's as
   the identity, which is what the vendor's own examples do at rotation 0 — but it has never been
   checked against a finger. If the tap targets are mirrored or transposed, the fix is one of the
   three flags at the top of that file; `-DTOUCH_TRACE=1` prints the raw and mapped points.
3. **Every sound the speaker makes.** `src/speaker.cpp` compiles and its arbitration is reasoned
   through, but nobody has heard it. Specifically unproven: that the amplifier produces audible
   output at all; that `SPEAKER_PA_SETTLE_MS`/`SPEAKER_PA_TAIL_MS` are long enough to suppress the
   switch-on and switch-off pop, which are guesses biased towards "no pop" rather than measurements
   against the FM8002E datasheet; that the cue volumes are sensible in a room rather than merely
   sensible on paper; and that a cue aborted mid-tone by a recording sounds like a cut rather than
   a bang. The PA polarity itself is no longer a guess — see below.
4. **Every colour the LED shows.** `src/led.cpp` compiles and the pin is vendor-documented four
   ways, but no LED on this board has been lit by this firmware. Unproven: the GRB channel order
   (the vendor examples contradict each other, hence `LED_COLOR_ORDER_GRB`); that one LED is the
   right count; that the WS2812B-V5 part latches on our 100 ns-tick bit timings; and every
   brightness and hue judgement, all of which were made without seeing the diffuser.
5. **OTA rollback.** The 16 MB flash/partition configuration boots, but the dual-slot failure and
   rollback ceremony has not been tested.
6. **Touch/display bus coexistence.** Display and codec work, but adding FT6336G on the shared I2C
   bus still needs a real-board test.
7. **Sustained capture/upload power and thermals.** Local clips work; Wi-Fi upload under battery
   load cannot be measured until the gateway client is present. The LED and the amplifier both add
   to that budget — a WS2812B at full white is roughly 60 mA, which is why
   `LED_DEFAULT_BRIGHTNESS_PCT` is 55 and not 100.

**Promoted out of this list:** the PA enable polarity on GPIO1 used to be recorded here as an
inference from one vendor example. It is not an inference any more — the manufacturer's IO
allocation table states 音频功放IC使能引脚，低电平使能 ("audio power amplifier IC enable pin, LOW
enables") for GPIO1, and three vendor examples agree. What remains unverified is whether the
amplifier makes a noise, not which way round its enable line goes.

## Build

```
pio run -e hosyond-es3c28p-controller   # display + microphone: the actual product
pio run -e hosyond-es3c28p              # bring-up, display and audio off
pio run -e hosyond-es3c28p-capture      # microphone + speaker, no panel
pio run -e hosyond-es3c28p-display      # panel + touch UI, no microphone
pio run -e hosyond-es3c28p-recovery     # provisioning/recovery image
pio run -e hosyond-es3c28p-orbbench     # cycles every orb mode and reports frame cost
```

Two flags gate the hardware added most recently. `ENABLE_SPEAKER=1` is set in `-capture` and
`-controller`; it requires `ENABLE_AUDIO_CAPTURE=1` and refuses to build without it, because the
I2S channels and the ES8311 are brought up by `src/audio.cpp` and the DAC borrows them.
`ENABLE_NOTIFICATION_LED=1` is set in `-capture`, `-display`, `-orbbench` and `-controller` — the
LED needs no codec, so a display bisect can still have its status light while everything touching
I2S stays out of a build whose whole purpose is to have no audio in it. Both are off in the base
and `-recovery` environments, following the convention `ENABLE_LCD` set for unproven hardware.

`-display` and `-capture` each disable half the product, which was right while both were bring-up
harnesses and is not right now that the screen is the interface and the microphone is how a request
is made. They are kept because bisecting a display fault still wants a build with no audio in it,
and vice versa. Flash `-controller`.

Copy `include/controller_config.example.h` to `include/controller_config.h` first. Wi-Fi
credentials are deliberately not in it — the owner enters them through the SoftAP portal and they
live in NVS.
