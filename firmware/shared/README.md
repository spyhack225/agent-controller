# firmware/shared

PlatformIO libraries shared by every Agent Controller board, pulled in with `lib_extra_dirs = ../shared`.

Both boards run the same client logic and differ only in their panel. Keeping that logic here is what
stops `esp32-controller` and `vision-master-t190` from drifting into two unrelated firmwares.

## AgentControllerCore

| Unit | What it owns |
|---|---|
| `DeviceStore` | Writable device state in NVS (namespace `agentctl`): identity, gateway URL, Wi-Fi credentials, the cached claim code, and the last-known runtime config. |
| `Provisioning` | The boot state machine and its first transport, a SoftAP captive portal. |

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

Compiles on all three `esp32-controller` environments. **Not yet validated on hardware** — the
portal, the join-timeout path, and the long-press reset have never run on real silicon.
