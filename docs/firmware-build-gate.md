# Firmware build gate

The canonical firmware inventory is [`firmware/build-matrix.json`](../firmware/build-matrix.json).
It names all 15 PlatformIO environments, their hardware model, and whether an environment is a
release image, recovery image, probe, benchmark, or scaffold. `src/hardware.mjs` must point a
production-capable board at its `release` entry. CrowPanel therefore selects
`crowpanel-esp32-213-epaper-secure`, and Hosyond selects `hosyond-es3c28p-controller`.

## Commands

```bash
npm run check:firmware-manifests
npm run build:firmware
npm run build:firmware:all
```

The first command is the credential-free CI contract. It verifies that every `[env:*]` section is
represented exactly once, all projects use the same pinned pioarduino toolchain, release entries
explicitly force verified TLS, the hardware catalogue selects the intended entry, and placeholder
configs fail closed.

The build commands use `scripts/build-firmware-matrix.mjs`. They copy only the build inputs and
`controller_config.example.h` to a newly created directory under the operating system's temporary
directory. They never read or copy `controller_config.h` or `controller_config.old.h`. This keeps
live credentials out of the artifacts and also keeps `.pio` output outside a cloud-synced checkout.

Each environment has a ten-minute default timeout. Override it only for a known slow runner:

```bash
FIRMWARE_BUILD_TIMEOUT_MS=900000 npm run build:firmware:all
```

Failures are classified as timeout, network/dependency, dependency resolution, compile/link, or
configuration/toolchain. PlatformIO still needs its pinned packages and declared libraries in its
cache or over the network; the gate does not pretend a download failure is a compiler failure.

## Current local evidence — 2026-09-02

| Board | Current post-TLS evidence | Resource evidence |
| --- | --- | --- |
| CrowPanel | secure release, default, e-paper probe, and raw-session capture carrier compile pass | release 16.9% RAM / 34.4% flash; current isolated capture-placeholder 20.4% / 37.5% |
| Hosyond | secure controller release, base, and capture pass | release 17.9% RAM / 24.8% flash; capture 17.8% / 24.0% |
| Waveshare | shared secure claim/health/recovery base and capture builds pass with every unproved UI/media capability disabled | both 15.8% RAM / 20.9% flash |
| Vision Master | shared secure status build and explicitly gated external-input browse/operate variant pass | default 16.9% RAM / 34.2% flash; gated input 16.9% / 35.1% |

The original CrowPanel/Waveshare attempts did not fail compilation. Their worktree `.pio`
directories carried macOS File Provider conflict directories named `build 2` and `libdeps 2`, and
resolution stalled before compilation. The isolated runner removed that failure mode. A later
contended exhaustive run also showed PlatformIO's internal `uv pip install` repair for
`tool-esptoolpy` timing out; a clean bounded Waveshare capture retry then passed. These are local
runner/tool setup observations, not source failures.

The remaining Hosyond recovery/display/orb-benchmark/bench environments have older green evidence
but did not finish a new quiet-runner invocation during this audit. Run the complete matrix on an
uncontended local or dedicated CI host before publishing firmware.

## What this does not prove

A compile proves that the selected source, libraries, partitions, and toolchain link. It does not
prove pin correctness, display/touch/audio behavior, production CA contents, trusted-clock
bootstrap, negative certificate refusal, OTA rollback, WAN recovery, or a controller-to-cloud-to-T3
journey. Keep those as separate physical and deployed gates in the implementation ledger.
