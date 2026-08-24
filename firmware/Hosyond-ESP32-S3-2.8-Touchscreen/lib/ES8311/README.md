# ES8311

Espressif's ES8311 codec driver, **vendored unmodified**.

- Source: `docs/…/Example_17_echo/echo/{es8311.cpp,es8311.h,es8311_reg.h}` in this board's own
  example pack.
- Upstream: Espressif Systems, `SPDX-License-Identifier: Apache-2.0`.

Vendored rather than pulled from a library registry for the same reason the CrowPanel vendors
`ElecrowEPD`: the audio path must not depend on a network fetch or a third-party package that can
move.

## Divergences from the vendor drop

Two, both necessary. Keep the rest byte-identical so a future re-sync stays a plain diff.

1. **Dropped `#include "ESP_Panel_Board_Custom.h"`** — the vendor's LVGL panel config, which this
   driver never reads and which would drag their display setup into our build.

2. **I2C moved from the legacy ESP-IDF driver to Arduino `Wire`.** This one is not optional.
   ESP-IDF 5.x ships two I2C driver generations and *aborts from a constructor* if both are linked:

   ```
   E (210) i2c: CONFLICT! driver_ng is not allowed to be used with this old driver
   abort() was called
   ```

   It fires at 210 ms, during static init, before `Serial` exists — so the board dies silently and
   explains nothing. It fires on link, not on use, so disabling audio does not avoid it.

   The vendor driver called `i2c_master_write_to_device` / `i2c_master_write_read_device` (legacy),
   while Adafruit BusIO — pulled in by the ILI9341 display driver — uses `Wire`, which is the new
   generation. Two call sites, replaced with `Wire` transactions; the read keeps its repeated start
   rather than issuing a stop, matching what `i2c_master_write_read_device` did.

   This is the right direction regardless of the display: the board shares one I2C bus between the
   codec, the FT6336G touch controller and the external header, so everything on it has to speak
   through the same driver generation.

The ES8311 is a **mono codec handling both directions** — ADC for the on-board MEMS microphone and
DAC for the speaker connector. That is the main structural difference from the Waveshare AMOLED
board, which splits the job across an ES7210 (mic ADC) and an ES8311 (playback).

`es8311_codec_init()` at the bottom of `es8311.cpp` is the board-specific convenience wrapper: it
creates a handle on `I2C_NUM_0` at address 0x18, configures 16-bit resolution at
`EXAMPLE_SAMPLE_RATE` (16 kHz) with MCLK from the MCLK pin, and enables the microphone. The
`EXAMPLE_*` macros it reads live in `es8311.h`.
