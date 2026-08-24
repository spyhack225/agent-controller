# firmware/shared

PlatformIO libraries shared by every Agent Controller board, pulled in with `lib_extra_dirs = ../shared`.

The target is for every board to run the same client logic and differ only in its panel and input
surface. Keeping that logic here is what will stop `CrowPanel-ESP32-2.13-E-paper`, `vision-master-t190`,
`Waveshare-ESP32-S3-Touch-AMOLED-1.75C`, and `Hosyond-ESP32-S3-2.8-Touchscreen` from drifting into
four unrelated firmwares.

All four are pinned to one toolchain — ESP-IDF 5.5 / Arduino core 3.3 via the
[pioarduino](https://github.com/pioarduino/platform-espressif32) platform fork. The official
`platformio/platform-espressif32` is unmaintained and frozen at Arduino 2.0.17 / ESP-IDF 4.4, which
has no `driver/i2s_std.h` and therefore cannot build the on-board audio boards.

**This library does not yet hold enough.** `DeviceStore`, `Provisioning`, and `ThinkingOrb` are shared today;
the gateway client — heartbeat, display-state fetch, intent submission, OTA, media upload — still
lives inside the CrowPanel's 3652-line `src/main.cpp`. That was tolerable with one real board and
one bring-up sketch. Two audio boards later it is the single thing standing between a recorded
clip and a dispatched intent — the Hosyond board already captures audio and can do nothing with it.
Extracting the client here is now the prerequisite for a second working firmware, not a cleanup
task. Port plans:
[`Waveshare`](../Waveshare-ESP32-S3-Touch-AMOLED-1.75C/README.md),
[`Hosyond`](../Hosyond-ESP32-S3-2.8-Touchscreen/README.md).

## AgentControllerCore

| Unit | What it owns |
|---|---|
| `DeviceStore` | Writable device state in NVS (namespace `agentctl`): identity, gateway profiles and switch journal, Wi-Fi credentials, the cached claim code, and the last-known runtime config. |
| `Provisioning` | The boot state machine and its first transport, a SoftAP captive portal. |
| `ThinkingOrb` | Provider-neutral visual state model and point-cloud renderer used by display-capable boards. |

### Why this exists

Everything above used to be a compile-time `#define`, which made a shipped unit unrecoverable:

- the factory cannot know the customer's Wi-Fi network, so a baked-in SSID could never work;
- a wrong password left `connectWiFi()` spinning in an unbounded loop until someone reflashed over USB;
- a rotated device secret had no way to reach the device at all;
- a revoked device displayed `HTTP 401` forever with no on-device recovery.

See [docs/device-setup-flow.md](../../docs/device-setup-flow.md) for the full analysis and phasing.

### State machine

```
unprovisioned --> provisioning --> connecting --> online
                       ^               |            |
                       |               v            v
                       +---- 3 join failures    link lost --> connecting
```

The rule the whole design serves: **the device never blocks indefinitely in any state.** Every state
has a screen, and every failure has a next action visible on that screen.

### NVS keys

Keys are capped at 15 characters by NVS, hence the abbreviations. `buildNvsSeedCsv()` in
[`src/manufacturing.mjs`](../../src/manufacturing.mjs) emits these same names — change one and you
must change the other, or factory-flashed units authenticate against nothing.

| Key | Written by |
|---|---|
| `dev_id`, `dev_secret` | factory flashing station (or a bench seed from `controller_config.h`) |
| `gw_url` | factory default; the owner can override it in the portal |
| `gw_profiles`, `gw_rev`, `gw_active` | device-synced gateway profile cache, revision, and active profile; `gw_url` remains the active URL for compatibility |
| `gw_pending`, `gw_purl`, `gw_prev`, `gw_state`, `gw_error` | two-phase gateway switch journal; an interrupted or failed probe retains the prior working URL |
| `wifi_ssid`, `wifi_pass` | the owner, through the portal |
| `claim_code`, `claim_exp` | the device, from the one time `/v1/device/setup-code` returns plaintext |
| `cfg_cache` | the device, from `/v1/device/config` |

On production units this partition needs flash encryption. Without it, `esptool read_flash` recovers
both the Wi-Fi password and the device secret — see
[docs/production-security.md](../../docs/production-security.md).

### The portal is not an auth surface

It is an open AP serving one local form. It never carries the device secret, never talks to the
gateway, and never asks for an Agent Controller account. A WPA passphrase the owner would have to
read off a 122x250 panel doubles the failure surface for no real gain.

Credentials are validated by attempting the join **before** they are persisted, so a wrong password
returns the owner to the form instead of writing a value that bricks the next boot.

## Status

Compiles on all 11 environments across all four board folders: CrowPanel 4, Hosyond 4, Waveshare 2,
and Vision Master T190 1. Hosyond has exercised NVS-backed provisioning, the SoftAP portal, BOOT
recovery, and `ThinkingOrb` on silicon. That does not validate CrowPanel, Waveshare, or T190, and the
shared gateway client remains absent. Current evidence and blockers are maintained in
[roadmap/IMPLEMENTATION-STATUS.md](../../roadmap/IMPLEMENTATION-STATUS.md).
