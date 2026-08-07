# Agent Controller Implementation Roadmap

## Current Status

Every phase is complete to the limit of what code can carry. What remains is physical and
commercial execution, listed explicitly at the end.

| Phase | Status | Notes |
|---|---|---|
| 0 Product scope | Done | All three v1 workflows; deferred items still deferred |
| 1 Cloud foundation | Done | Convex/file/memory stores; S3-compatible media via `src/s3.mjs` |
| 2 T3 integration | Done | HTTP orchestration **and** the WebSocket RPC API (`src/t3Ws.mjs`); background snapshot poller |
| 3 Environment pairing | Done | Token exchange, encrypted storage, expiry handling, 4 connection modes |
| 4 Device provisioning | Code done | QR claim labels; `REQUIRE_TLS` enforcement. **eFuse ceremony outstanding** |
| 5 Firmware MVP | Code done | Compiles on 4 environments incl. audio/camera capture. **Unvalidated on hardware** |
| 6 Text / audio / camera | Done | Real attachments, transcription, and OCR/vision; device capture compiles |
| 7 Policy engine | Done | All 8 dimensions; credential/deletion/install screening; custom profiles |
| 8 Phone and web apps | Done | PWA, mobile Quick page, profile editor, billing |
| 9 Shell input | Done | Stages 1–4; `terminal:operate` opt-in, confirm-always, dispatched over WS |
| 10 Observability | Done | Metrics plus alerts at the Phase 11 budgets |
| 11 Beta launch | Measurable | `/v1/observability/beta-readiness`. **Needs real users** |
| 12 Commercial | Code done | Billing, transfer/reset, diagnostics, OTA + rollback. **Rollback untested on hardware** |

### Outstanding, and not completable by writing code

1. **Secure boot / flash encryption** — irreversible eFuse operations. Build config ships; the key
   ceremony is a human decision. See `docs/production-security.md`.
2. **OTA rollback test** — four-step procedure documented; needs one board and a deliberately
   broken image. Keep `ENABLE_OTA_APPLY=0` on shipping units until it passes.
3. **Hardware capture validation** — I2S audio and camera compile but have never run on a board.
4. **Beta** — 10–20 users and 50+ paired device-days is real adoption over real time.

### Verified during implementation

- T3's WebSocket RPC protocol reverse-engineered and confirmed live against T3 Code 0.0.28.
- Provider catalogue read live from `server.getConfig`.
- QR encoder checked byte-for-byte against two independent encoders and decoded by OpenCV.
- SigV4 checked against official AWS vectors and round-tripped through MinIO.
- Partition table confirmed byte-for-byte against the attached ESP32-S3.
- Original local E2E on `/Users/example/Documents/Claude/Projects/Tacs` remains valid.

## Target Architecture

```text
Device / Phone / Web
        |
        v
Your Platform API
  auth, users, devices, profiles, media, policies
        |
        v
T3 Code environment endpoint
  Tailscale / T3 Connect / HTTPS reachable backend
        |
        v
Codex / Claude / terminals
```

The platform owns identity, device control, policy, media processing, and audit logs. T3 Code remains the private execution runtime that controls Codex, Claude, terminals, projects, and workspace state.

## Phase 0: Product Scope

Define v1 around three workflows:

- Remote status: inspect active T3 Code environments, projects, threads, and agent state.
- Remote prompt: send text or audio prompts to Codex or Claude.
- Remote control: stop, continue, approve, reject, and run saved macros.

Defer until later:

- Continuous video.
- Arbitrary terminal streaming from the hardware device.
- Multi-user team permissions.
- Integration marketplace.
- LoRa remote mode.

## Phase 1: Cloud Foundation

Build the VPS/SaaS backend as the commercial control plane.

Core services:

- Auth service.
- User accounts.
- Organizations, optional for later.
- Device registry.
- Device pairing.
- Device policy profiles.
- T3 environment registry.
- Command router.
- Audit log.
- Media upload and processing pipeline.

Chosen stack:

```text
Backend: Node.js / TypeScript
Auth: Clerk
Storage: Convex
Realtime: Server-sent events first, Convex subscriptions/WebSocket later
Queue: Convex actions or managed queue when background work grows
Object storage: Local disk for prototype, S3-compatible storage for production media
```

Initial Convex tables:

```text
users
devices
device_credentials
device_sessions
t3_environments
t3_tokens
controller_profiles
commands
command_events
media_uploads
audit_logs
```

Gateway boundary:

```text
HTTP/API routes -> Store API -> Convex functions
```

Keep the gateway route code independent from Convex-specific calls. This allows local memory/file storage during hardware development and Convex storage in the hosted platform.

## Phase 2: T3 Code Integration

Use T3 Code's existing environment HTTP API first.

Known useful endpoints:

```text
GET  /.well-known/t3/environment
POST /oauth/token
GET  /api/orchestration/snapshot
POST /api/orchestration/dispatch
POST /api/auth/websocket-ticket
GET  /ws?wsTicket=...
```

Start with HTTP polling:

```text
VPS -> T3 snapshot every few seconds
VPS -> compressed state for device
```

Add WebSocket later for live updates.

Required T3 scopes for normal remote agent control:

```text
orchestration:read
orchestration:operate
```

Keep this separate and opt-in:

```text
terminal:operate
```

## Phase 3: T3 Environment Pairing

User flow:

1. User opens the web dashboard.
2. User adds a T3 Code environment.
3. T3 Code generates a pairing token.
4. User pastes the token or opens a pairing URL.
5. The platform exchanges the token via `/oauth/token`.
6. The platform stores the encrypted T3 access token.
7. The platform verifies the connection with `/api/orchestration/snapshot`.

Support more than one connection mode:

```text
Tailscale HTTPS endpoint
T3 Connect / hosted relay endpoint
Manual HTTPS endpoint
Local development endpoint
```

For commercial use, do not assume every customer will let the VPS join their Tailnet. T3 Connect or user-provided HTTPS endpoints may become cleaner defaults.

## Phase 4: Device Provisioning

Manufacturing flow:

```text
Generate device_id
Generate per-device secret or keypair
Flash firmware
Print QR code
Store public identity in platform
```

User pairing flow:

```text
Device shows code / QR
User logs into web app
User claims device
Platform binds device to account
Device receives profile
```

Minimum production security:

- TLS only.
- Per-device credential.
- Credential rotation.
- Lost-device revocation.
- Firmware version tracking.
- OTA update support.
- Secure boot and flash encryption where practical.

## Phase 5: Device Firmware MVP

For the ESP32 controller:

- Wi-Fi setup.
- Device authentication.
- WebSocket or MQTT connection to VPS.
- E-ink status rendering.
- Rotary encoder and menu navigation.
- Button actions.
- OTA update check.
- Heartbeat, battery, and status reporting.

First device actions:

```text
status
switch environment
switch thread
send saved prompt
continue
stop
approve
reject
```

Allow shell input capture from hardware, phone, and web clients, but route it through the platform policy engine before dispatch. In early firmware, keep hardware shell entry to short macro-style inputs because the encoder/e-ink UI is not ergonomic for long commands.

## Phase 6: Text, Audio, And Camera Input

Normalize every input into a platform command:

```ts
type UserIntent =
  | { type: "agent_prompt"; text: string; source: "web" | "phone" | "device" }
  | { type: "shell_input"; command: string; targetTerminalId?: string }
  | { type: "approval_response"; requestId: string; decision: "approve" | "reject" }
  | { type: "media_prompt"; text?: string; imageUrl?: string; audioTranscript?: string };
```

Text flow:

```text
phone/web/device -> VPS -> T3 thread.turn.start
```

Audio flow:

```text
device/phone -> VPS upload/stream -> transcription -> prompt preview -> dispatch
```

Camera flow:

```text
device/phone -> VPS image upload -> OCR/vision/attachment -> prompt -> dispatch
```

For ESP32, start with:

- Short push-to-talk audio clips.
- Still images.
- No continuous video.

Continuous audio/video will stress battery, bandwidth, memory, and cloud cost.

## Phase 7: Policy Engine

Because shell input is allowed, policy is a core platform feature from the start.

Separate input capability from execution permission:

```text
Device can capture shell text
Platform decides whether it may execute
```

Policy dimensions:

```text
user
device
environment
command type
risk level
time window
network location
subscription tier
```

Example profiles:

```text
Read-only
Agent prompts only
Approvals allowed
Media prompts allowed
Terminal input allowed
Admin
```

Require confirmation for:

```text
destructive shell commands
git push
deployments
file deletion
credential access
package install
terminal:operate actions
```

## Phase 8: Phone And Web Apps

Web dashboard:

- Device management.
- T3 environment pairing.
- Session browser.
- Prompt composer.
- Audio and camera input.
- Approval queue.
- Audit log.
- Profile editor.
- Billing.

Phone app or PWA:

- Push-to-talk.
- Camera prompt.
- Approval notifications.
- Device setup.
- Quick macros.

If BLE setup is required on iPhone, plan for a native app eventually. Browser BLE support on iOS is not a strong foundation.

## Phase 9: Shell Input

Add shell control in stages:

1. Shell as agent prompt: "Run npm test and summarize."
2. Saved shell macros: predefined commands only.
3. Direct terminal write: requires `terminal:operate`.
4. Interactive terminal: web/phone only, not e-ink hardware.

This avoids turning the hardware into an unaudited remote shell.

## Phase 10: Reliability And Observability

Track:

```text
device online/offline
last heartbeat
command latency
T3 environment reachable/unreachable
token expiration
failed dispatches
media processing failures
firmware version
battery level
```

Add audit events for every remote action:

```text
who
device
environment
thread
input type
normalized command
risk level
result
timestamp
```

## Phase 11: Beta Launch

Beta success criteria:

```text
10-20 users
50+ paired device-days
<2s median command acknowledgement
<10s audio-to-prompt dispatch
zero unauthenticated command execution
reliable device reconnect after Wi-Fi loss
clear token/device revocation
```

Beta device feature set:

```text
status
prompt
push-to-talk
approve/reject
stop
saved macros
basic camera snapshot
```

## Phase 12: Commercial Launch

Before selling broadly:

- Billing and subscriptions.
- Device transfer/reset flow.
- Factory reset.
- OTA update pipeline.
- Support diagnostics bundle.
- Privacy settings for audio/image retention.
- SOC2-minded logging boundaries.
- Clear T3 Code setup docs.

## Build Order

Implement in this order:

1. VPS platform skeleton.
2. T3 Code pairing and snapshot.
3. Web dashboard for sending prompts.
4. Device registry and simulated device client.
5. ESP32 firmware for status and buttons.
6. Audio upload and transcription.
7. Camera snapshot.
8. Policy engine and policy-screened shell input.
9. Higher-trust shell approvals for dangerous actions.
10. OTA and production provisioning.

## Highest-Risk Areas

The riskiest parts are not the buttons or e-ink display. They are:

- T3 environment connectivity.
- Remote authentication.
- Shell permissions.
- Media processing cost and reliability.
- Token storage and revocation.
- Customer setup complexity.

Build these boundaries early, test them with simulated devices, and only then expand the hardware input surface.
