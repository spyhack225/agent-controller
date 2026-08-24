# ES8311

Espressif's ES8311 codec driver, **vendored unmodified**.

- Source: `docs/…/Example_17_echo/echo/{es8311.cpp,es8311.h,es8311_reg.h}` in this board's own
  example pack.
- Upstream: Espressif Systems, `SPDX-License-Identifier: Apache-2.0`.

Vendored rather than pulled from a library registry for the same reason the CrowPanel vendors
`ElecrowEPD`: the audio path must not depend on a network fetch or a third-party package that can
move. Keep these files byte-identical to the vendor drop so a future re-sync is a plain diff.

The ES8311 is a **mono codec handling both directions** — ADC for the on-board MEMS microphone and
DAC for the speaker connector. That is the main structural difference from the Waveshare AMOLED
board, which splits the job across an ES7210 (mic ADC) and an ES8311 (playback).

`es8311_codec_init()` at the bottom of `es8311.cpp` is the board-specific convenience wrapper: it
creates a handle on `I2C_NUM_0` at address 0x18, configures 16-bit resolution at
`EXAMPLE_SAMPLE_RATE` (16 kHz) with MCLK from the MCLK pin, and enables the microphone. The
`EXAMPLE_*` macros it reads live in `es8311.h`.
