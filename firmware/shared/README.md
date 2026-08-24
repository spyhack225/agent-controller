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

**Still to lift out of the CrowPanel's `src/main.cpp`:** media upload, OTA (manifest poll, signed
download, rollback confirm), and the two-phase gateway-profile switch. `GatewayClient` now covers
claiming and the whole operate flow, so a board can drive a thread — but until media upload moves
here, a board that records a clip still has nowhere to put it. Port plans:
[`Waveshare`](../Waveshare-ESP32-S3-Touch-AMOLED-1.75C/README.md),
[`Hosyond`](../Hosyond-ESP32-S3-2.8-Touchscreen/README.md).

## AgentControllerCore

| Unit | What it owns |
|---|---|
| `DeviceStore` | Writable device state in NVS (namespace `agentctl`): identity, gateway profiles and switch journal, Wi-Fi credentials, the cached claim code, and the last-known runtime config. |
| `Provisioning` | The boot state machine and its first transport, a SoftAP captive portal. |
| `ThinkingOrb` | Provider-neutral visual state model and point-cloud renderer used by display-capable boards. |
| `GatewayClient` | The device's whole conversation with the gateway: claim, heartbeat, runtime config, saved actions, threads, dispatch, response paging, and the approval queue. No drawing — see [the operate surface](#the-operate-surface). |
| `OperateModel.h` | The board-agnostic shapes a UI renders from, and the fixed cap on every one of them. |

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

## The operate surface

`GatewayClient` splits its calls two ways, and the difference decides how a board uses them.

**Polled.** `runCycle()` refreshes the display, the controls layout, the approval queue, and an open
response page on their own timers — heartbeat 30 s, config 60 s, controls 30 s, approvals 30 s,
display 5 s. It makes **at most one HTTP request per call** on every path, including the
just-connected edge, which marks the operate resources due rather than firing them in a burst. A UI
never asks for these: it renders whatever the accessors hold, and repaints when `revision()` changes.

**Gesture.** `refreshThreads()`, `selectThread()`, the `send*` / `run*` calls, `fetchResponsePage()`,
and `answerApproval()` are driven by a person. Each performs one request and **blocks for up to the
5 s timeout** — `HTTPClient` has no async mode, and a worker task would put a lock in front of every
accessor. The contract inherited from the CrowPanel firmware is therefore: paint a pending frame
first, then call. On a board running a continuous renderer, expect the animation to stall.

Two things in here are easy to break by simplifying:

- **`responseAfter`.** A dispatch returns an ISO timestamp; `openResponse()` takes it and carries it
  into every page fetch. Without it the gateway answers with the *previous* turn's completed reply
  the instant an action is fired, and the poll that waits for the real one never starts.
- **Local confirmation is not gateway approval.** `runControl()` deliberately does not enforce
  `requiresConfirmation` — that gate belongs to the UI, which is what lets a confirmed action be
  re-dispatched without looping back into its own prompt.

Every collection is a fixed array, because this runs beside a renderer and an unbounded `String`
vector fragmenting the heap over days of uptime does not show up on the bench. Caps: 8 controls (the
gateway's `limits.menuItems`), 12 threads, 3 response lines per page (the gateway's page size, not
screen geometry — a taller screen walks pages), 2 follow-ups, 4 pending approvals, 6 macros, and an
8 KB ceiling on any response body. `setLimits()` declares the first two to the gateway in the
heartbeat; wrong numbers there come back as clipped text rather than as an error.

`GatewayClient` itself only picks a thread. The two levels above it — which paired T3 host, and
which folder inside it — live in `GatewayBrowse.{h,cpp}`, against
`GET/POST /v1/device/environments` and `/v1/device/projects`
(`docs/hardware-protocol.md`, "Environment, project, and thread API").

It is a separate class with its own state and its own copy of the request helper, not new members
on `GatewayClient`, so a board that does not browse pays nothing and the class every board already
depends on did not have to grow a surface. Caps are 8 environments and 12 projects, truncation
reported rather than silently clipped. Two behaviours are load-bearing: changing environment clears
the project and thread server-side, so both local lists are dropped rather than kept; and
`POST /v1/device/config/project` reads `projectId` as a **required** string, so a device can narrow
to a folder but cannot widen back to "all folders" — that stays a console operation.

Earlier revisions of this file said such a picker was impossible because the thread list was the
whole picker the protocol offered. That was true, and stopped being true when the gateway grew
those routes.

### Media upload

`uploadMedia()` is the one call that does not go through `request()`. Its body is base64 inside JSON
and a 30 s voice note is over a megabyte encoded, so `MediaUpload.h` streams
`prefix + base64(header ++ body) + suffix` four characters at a time straight into the TCP buffer —
the capture buffer in PSRAM stays the only full copy. `buildWavHeader()` fills the 44-byte header as
its own segment so the PCM is never memmoved to make room in front of it.

It repeats the local backoff gate, the device credentials and the retry-after handling rather than
skipping them, takes a 30 s timeout against everyone else's 5 s, and answers 413 locally — without
opening a socket — when the decoded size exceeds the `mediaUploadBytes` declared in `setLimits()`,
which is the same number the gateway checks.

## Status

Compiles on all 12 environments across all four board folders: CrowPanel 4, Hosyond 5, Waveshare 2,
and Vision Master T190 1. Hosyond has exercised NVS-backed provisioning, the SoftAP portal, BOOT
recovery, and `ThinkingOrb` on silicon. **The operate surface has run on no board at all** — it is a
port of a flow verified end to end on the CrowPanel, compiled here but never executed against a live
gateway. Current evidence and blockers are maintained in
[roadmap/IMPLEMENTATION-STATUS.md](../../roadmap/IMPLEMENTATION-STATUS.md).
