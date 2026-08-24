# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Cloud control plane ("gateway") that lets remote controller hardware (ESP32 devices) and a web console drive
[T3 Code](https://github.com/pingdotgg/t3code) agent environments running on a user's own machine. The gateway never
runs agents itself — it authenticates actors, applies policy, and dispatches orchestration commands to a paired T3 Code
instance over HTTP.

Node >= 22 is required. The server uses ESM (`.mjs`) with **zero runtime web framework** — a hand-rolled `node:http`
server. The frontend is React 19 + Vite 8 + Tailwind 4.

## Commands

```bash
npm start                 # build client, then run gateway on http://127.0.0.1:3996
npm run dev:server        # gateway with --watch (no client build)
npm run dev:app           # Vite on :5173, proxies /v1 and /health to :3996
npm test                  # build:app + typecheck:app + test:app + test:server
```

Targeted checks:

```bash
npm run test:server                        # node --test test/*.test.mjs
node --test test/policy.test.mjs           # one server test file
node --test --test-name-pattern="claim"    # one server test by name
npm run test:app                           # vitest run (frontend, jsdom)
npx vitest run --config frontend/vitest.config.ts src/format.test.ts   # one frontend test file
npm run typecheck:app                      # tsc --noEmit on frontend/
```

Supporting scripts:

```bash
node scripts/mock-t3.mjs        # fake T3 Code instance for local dev
node scripts/simulate-device.mjs # register a fake controller device
npm run smoke:local             # HTTP smoke flow against the in-memory/file store
npm run smoke:convex            # same flow against a deployed Convex backend
npm run setup:t3                # guided T3 install/auth/tunnel/pairing wizard
npm run convex:dev              # convex dev (deploy convex/ functions)
```

There is no linter configured. `npm test` is the gate.

## Architecture

### Request flow

`src/server.mjs` loads config → picks a store → calls `createApp()`. Everything routes through a single `handle(req, res)`
function in `src/app.mjs` (~1800 lines): a long `if` chain matching `req.method` + `url.pathname` (exact strings) or
`url.pathname.match(/regex/u)` for parameterized routes. **New endpoints go in that chain** — order matters, static-file
and health routes are checked first. Handlers throw `HttpError` from `src/http.mjs`; the outer `try/catch` converts it to
a JSON error response.

### Three authentication realms

Every route belongs to exactly one, and they never mix:

| Realm | Credential | Helper | Rate limit helper |
|---|---|---|---|
| Platform user | Clerk session/JWT, or a legacy `Bearer` platform token | `authenticateUser()` | `enforceUserRead/Write` |
| Device | `x-device-id` + `x-device-secret` headers | `authenticateDevice()` | `enforceDevice{Heartbeat,Read,Write}` |
| Factory | `FACTORY_TOKEN` env secret | `authenticateFactory()` | `enforceFactoryWrite` |

Auth mode comes from `AUTH_PROVIDER` (defaults to `clerk` if `CLERK_SECRET_KEY` is set, else `dev`). In Clerk mode
`POST /v1/users/dev` is hard-disabled; dev tokens only exist for tests and `DEMO_MODE=1`. `src/clerkAuth.mjs` adapts the
raw `node:http` request into a WHATWG `Request` for `@clerk/backend` and caches user profiles for 5 minutes.

`authenticateUser()` takes an optional `url` argument, which enables `?token=` query-string auth for endpoints the
browser cannot send headers on (SSE). That path only applies in non-Clerk mode — in Clerk mode the same-origin session
cookie is used and the query token is ignored.

### Agent harnesses and models

Verified against a live T3 Code 0.0.28: `GET /api/orchestration/snapshot` returns **only**
`{snapshotSequence, projects, threads, updatedAt}`. There is no provider catalogue on the paired
HTTP API — T3 publishes it to its own web UI over the authenticated WebSocket (server spans:
`upsertProviders`, `publishEnrichedSnapshot`). So harnesses come from two places, merged in
`src/t3Harness.mjs`:

1. **Snapshot-derived** — instances/models referenced by `projects[].defaultModelSelection` and
   `threads[].modelSelection`. Shows what is *in use*, not what exists.
2. **Registered catalogue** — `scripts/setup-t3.mjs` runs on the T3 host, reads
   `<base-dir>/caches/<instanceId>.json`, and `PUT`s it to `/v1/t3/environments/:id/catalogue`.
   This is the authoritative list, stored on the environment as `providerCatalogue`.

`validateModelSelection()` only rejects when a catalogue is registered (`source === "catalogue"`).
Without one it returns null, because T3 provider instance ids are not restricted to built-ins and
rejecting against snapshot-derived data would block legitimate user-defined instances.

**Why this matters:** T3 accepts a dispatch and *then* has the provider reject an unknown model, so
a bad slug produced a command stuck at `dispatched` forever with no assistant reply. Thread launch
now validates before dispatch (422), and `extractSessionFailures()` surfaces `threads[].session.lastError`.

### The T3 WebSocket API

The orchestration HTTP API only exposes projects and threads. Everything else — the provider
catalogue, terminals, settings — is served over an authenticated WebSocket speaking Effect's RPC
protocol. `src/t3Ws.mjs` implements it (reverse-engineered against T3 Code 0.0.28, verified live):

```
POST /api/auth/websocket-ticket   ->  { ticket }
ws://host/ws?wsTicket=...
client -> {"_tag":"Request","id","tag","payload","headers":[]}
server -> {"_tag":"Exit","requestId","exit":{"_tag":"Success","value"}}
          {"_tag":"Chunk","requestId","values":[…]}   // must be Ack'd or the stream stalls
          {"_tag":"Defect","defect":"Unknown request tag: …"}
```

`tag` values are T3's `WS_METHODS` (`server.getConfig`, `terminal.open`, `terminal.write`,
`orchestration.dispatchCommand`, …). `server.getConfig` returns `providers` — the authoritative
harness catalogue, which is why `catalogueSource` can now be `"live"`.

If T3 changes this protocol, its own contract is readable at
`/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` (the source map ships `sourcesContent`,
including `packages/contracts/src/rpc.ts`).

### Terminal input (Phase 9 stage 3)

`terminal_input` is a capability **no built-in profile grants** — it needs a custom profile *and* an
environment paired with the `terminal:operate` scope, which standard pairing never requests. It is
also confirm-always: `baseline.terminal-input` returns `requiresApproval` regardless of which
dimension allowed it, because a raw terminal write cannot be pattern-screened. Dispatch goes over
the socket (`terminal.open` then `terminal.write`), not orchestration dispatch — both in
`submitIntent` and in `approveCommand`.

`ALL_KNOWN_CAPABILITIES` in `policy.mjs` is derived from `DEVICE_CAPABILITIES`; it was previously a
hardcoded copy, which silently un-gated any newly added capability.

### Command reconciliation

`dispatched` means "T3 accepted the command", not "the agent replied". The poller closes that gap:
each reachable poll calls `extractThreadOutcomes()` and `reconcileCommandStatus()`, flipping stuck
`dispatched` commands to `failed` or `completed` and emitting a `command.reconciled` SSE event.

The discriminators matter and were verified against real T3 state — **`session.status` reads
`"stopped"` for success *and* failure**, so it proves nothing on its own:

| | failed turn | successful turn |
|---|---|---|
| `session.lastError` | populated | `null` |
| assistant message | none | present |
| turn `state` (T3 sqlite) | `error` | `completed` |

Reconciliation only acts on evidence *newer* than the command's own dispatch, so a reply or failure
from an earlier turn on the same thread is never misattributed. Terminal commands are never
re-decided, and a streaming assistant message does not yet count as a reply.

Real captured data lives in `test/fixtures/` (a live snapshot and the five provider caches); tests
run against it rather than invented shapes.

### Media storage and processing

`storagePath` on a media record is a **local path or an S3 object key** depending on
`MEDIA_STORAGE_PROVIDER`; the record shape and Convex schema are identical either way, so switching
backends needs no migration. `readStoredMedia`/`deleteStoredMedia` take `config` as a second
argument — omit it and they always hit local disk, which is a silent bug under S3.

`src/s3.mjs` speaks SigV4 by hand (no dependency). Leave `S3_FORCE_PATH_STYLE` unset unless you
mean it: unset auto-detects (MinIO/R2 need path style, AWS does not), and coercing it to `false`
breaks non-AWS endpoints.

Two pluggable media processors, same shape (`disabled` | `mock` | real provider):
`transcribeStoredAudio` (`src/mediaStore.mjs`) and `describeStoredImage` (`src/vision.mjs`). Both
write processing state before calling out. Images carry `visionStatus`/`descriptionSource`; audio
carries `transcriptionStatus`/`transcriptSource`. A vision description is user content — it is
redacted from support bundles alongside transcripts.

### Device profiles

Three built-ins live in code (`src/profiles.mjs`); custom profiles are user-scoped rows. The
critical wiring is `resolveActorProfile()` in `app.mjs`: a device stores only a profile *slug*, so a
custom profile must be looked up per user and passed to the policy engine as an object — otherwise
`capabilitiesForProfile()` cannot resolve it and silently falls back to `read-only`.
Built-ins cannot be shadowed, edited, or deleted, and a profile still assigned to a device is a 409.

Note the Convex naming: `updateDeviceProfile` assigns a profile *to a device*, while
`updateDeviceProfileDefinition` edits a custom profile's own definition.

### Billing and entitlements

`src/billing.mjs` owns the plan catalogue and what each tier grants; the payment provider only
supplies the tier. **Everything is gated behind `BILLING_ENFORCED` (default off)** — the default tier
is `free`, which grants 0 devices and no shell, so enabling it unconditionally would break every
existing deployment. When off, `assertWithinPlan()` returns immediately and no `subscriptionTier` is
passed to the policy engine. `POST /v1/billing/webhook` verifies an HMAC over the **raw** body
(hence `readRawBody`, not `readJson`) with a timestamp window, and is refused with 503 when no
secret is configured. A `past_due` or `canceled` subscription falls back to free entitlements
without losing data.

### Storage: one interface, three implementations

`src/storage.mjs` selects by `STORAGE_PROVIDER`:

- **memory** (default, no env) — `createStore()` / `createMemoryStore()` in `src/store.mjs`, the reference implementation
  and the source of truth for behavior. All tests run against it.
- **file** — `src/fileStore.mjs` wraps the memory store and persists `exportState()` to `DATA_FILE` on every change.
- **convex** — `src/convexStore.mjs` maps the same ~45 method names to `gatewayStore:*` Convex functions
  (see `DEFAULT_FUNCTIONS` at the top of that file), authenticating each call with `GATEWAY_CONVEX_SECRET`.

**Adding a store method means touching all three**, plus `convex/gatewayStore.ts` and `convex/schema.ts`. The store API
surface is listed as the return object at the bottom of `src/store.mjs` (~line 833).

Secrets are never stored in plaintext: device secrets and API tokens are stored as SHA-256 hashes and compared with
`timingSafeEqual`; T3 access tokens are AES-256-GCM sealed by `src/secretBox.mjs` (`v1:iv:tag:ciphertext`, key derived
from `T3_TOKEN_ENCRYPTION_KEY`). Secret generation always happens in Node, never in Convex.

### Device lifecycle

Factory pre-provisions (`preprovisionDevice` → claim code) → user claims (`claimDevice`) → device authenticates with its
own secret. Supports `rotateDeviceSecret`, `resetDeviceForTransfer`, and `revokeDevice`. Each device carries a **profile**
(`src/profiles.mjs`: `agent-controller`, `read-only`, `power-controller`) that maps to a capability set.

**Claim codes are stable, not rotating.** `ensureUnclaimedDeviceClaimCode({deviceId, rotate})` returns the existing code
untouched while it is unexpired — `POST /v1/device/setup-code` answers `200` with `rotated: false` and `claimCode: null`,
and only `rotate: true` (or an expired/absent code) mints a new one at `201`. This matters because firmware asks for a
setup code on its first 403, seconds after boot; the previous always-rotate behaviour invalidated the label printed on the
box before the owner ever read it. Plaintext is unrecoverable by design, so the *device* caches its code in NVS.
`claimCodeExpiresAt` defaults to 30 days and an expired code is refused by `claimDevice` rather than treated as unknown.

A scanned QR lands on `/claim?device=…&code=…`. `frontend/src/claimLink.ts` reads `location.search` **before** the hash
router (which would discard it) and mirrors the link into sessionStorage so it survives a Clerk round trip;
`features/ClaimPage.tsx` renders it, including an explicit dead-end for a used or expired code.

`buildOnboardingReadiness` requires `device.presence.latestActivityAt` — proof the hardware reached the gateway at least
once. Deliberately not `presence.online`: a controller unplugged since setup must not un-complete someone's onboarding.

### Intent → policy → command → T3

The core write path, in `submitIntent()` (`src/app.mjs`):

1. `normalizeIntent()` (`src/intent.mjs`) validates the intent shape (`agent_prompt`, `media_prompt`, `shell_input`,
   `session_control`, `approval_response`, `status`).
2. `evaluateIntentPolicy()` (`src/policy.mjs`) checks the device profile's capabilities, then screens `shell_input`
   against `DANGEROUS_SHELL_PATTERNS` (`rm -rf`, `sudo`, `git push`, `terraform apply`, …). Dangerous commands are not
   blocked outright — they become `requiresApproval` with risk `high` and wait for an owner decision via
   `/v1/commands/:id/approve|reject`.
3. `buildT3Command()` (`src/t3Client.mjs`) translates the intent into T3's wire protocol (`thread.turn.start`,
   `thread.session.stop`, `thread.turn.interrupt`, `thread.approval.respond`).
4. `dispatchT3Command()` POSTs to `{environment.baseUrl}/api/orchestration/dispatch`.

Media referenced by an intent becomes a real attachment (`buildMediaAttachments`): a signed,
short-lived, single-media URL (`src/mediaLinks.mjs`) that `GET /v1/media/:id/content` honours
**without a platform session**, since the T3 environment has no Clerk credentials — plus the bytes
inlined when under `MEDIA_INLINE_MAX_BYTES`. `storableT3Command()` strips both the inline bytes and
the live URL before the command is persisted, so neither media content nor a usable token is
retained in audit or support exports.

Every step writes a command record plus a `commandEvent` timeline entry, so `/v1/commands/:id/events` reconstructs the
full history. T3 commands are always dispatched with `runtimeMode: "approval-required"`.

T3 environments are paired either by exchanging a pairing token at `{baseUrl}/oauth/token` (RFC 8693 token exchange) or
by supplying an access token directly (local dev only). Expired tokens surface as `token_expired` health and block
snapshot/dispatch until re-paired.

### Real-time

`src/events.mjs` is an SSE broker. `store.subscribe()` is wired in `createApp()`, so any store
mutation pushes to `/v1/events` (user-scoped) and `/v1/device/events` (device-scoped).
`src/displayState.mjs` builds the compact payload the e-ink device renders.

The two store families report changes differently and `createApp()` handles both: memory/file hand
back a full snapshot (`broadcastStateChange`), while Convex can only name the affected user
(`broadcastUserChange`) because it holds the state remotely. Subscribers treat `state.changed`
purely as a refetch trigger, so the lighter payload is equivalent.

`src/snapshotPoller.mjs` keeps T3 state warm (roadmap Phase 2). It polls only users who are
actually present — an open SSE stream or a recent device heartbeat — since polling every
environment does not scale and Convex exposes no global enumeration. It pushes `t3.snapshot` only
when the compressed screen actually changes, and skips overlapping ticks. Started from
`server.mjs`, never from `createApp()`, so tests stay hermetic and drive `runOnce()` directly.

### Onboarding

`src/onboarding.mjs` defines a versioned six-step state machine (`welcome → host → connect → workspace → device → ready`)
persisted per user. `buildOnboardingReadiness()` gates completion on *operational evidence* (a reachable environment, a
real thread, a claimed device or an explicit `browser_only` choice) — the server refuses to mark it complete on client
assertion alone. Mirrored in `frontend/src/onboarding.ts` and `features/OnboardingPage.tsx`. See
[docs/onboarding-flow.md](docs/onboarding-flow.md).

### Frontend

`frontend/src/controller.ts` is a single large `useController()` hook holding essentially all app state and API calls;
`App.tsx` renders a nav shell over the `features/*Page.tsx` route workspaces (operate, devices, environments, media,
activity, settings). `api.ts` is the thin fetch wrapper (`ApiError`, `requestJson`). Clerk session tokens are fetched
fresh per request and **never** written to `localStorage`. Builds to `dist/web`, which the gateway serves statically;
The pre-React dashboard has been removed; the React build is the only client.

## Conventions

- Server code is `.mjs` ESM with no build step and no dependencies beyond `@clerk/backend` — keep it that way.
- IDs come from `src/ids.mjs` (`createId("prefix")`); timestamps are ISO strings via `nowIso()`.
- Server tests use `node:test` + `node:assert/strict`, spin up a real `createApp()` server on an ephemeral port, and stub
  `globalThis.fetch` to fake the T3 instance (restore it in `t.after()`). Follow the pattern at the top of
  `test/app.test.mjs`.
- Rate limiting (`src/rateLimit.mjs`) is fixed-window behind a pluggable backend: in-process by
  default, shared via `RATE_LIMIT_REDIS_URL` (raw RESP in `src/resp.mjs`, no dependency). `check()`
  is **async**, so every `enforce*` call must be awaited — an un-awaited one silently skips the
  limit and then crashes on the rejection. `test/rateLimit.test.mjs` has a guard test that fails if
  any call site in `app.mjs` loses its `await`.
- In `handle()`, any `return someAsyncFn(...)` must be `return await` — a bare returned promise
  escapes the surrounding try/catch and becomes a process-killing unhandled rejection.
- Support diagnostics (`/v1/support/diagnostics`) run everything through the `redact*` helpers in `app.mjs`; any new
  field containing user content or secrets must be added there too.

### Production security

`REQUIRE_TLS=1` makes the gateway refuse to issue or accept a device credential over plaintext
(`src/transport.mjs`). The subtlety: a loopback socket is only exempt when **no** `x-forwarded-proto`
is present — once a proxy forwards a request, the real client is elsewhere and its scheme decides.
Off by default so existing deployments keep working.

Firmware rollback is real but needs all three of: `partitions_ota.csv` (dual app slots),
`confirmFirmwareIfPendingVerify()` confirming only after a successful heartbeat, and a bootloader
built with rollback enabled. `docs/production-security.md` documents the eFuse ceremony, which is
deliberately not scripted.

## Docs

[docs/api.md](docs/api.md) (endpoints + local e2e flow), [docs/auth-storage.md](docs/auth-storage.md) (Clerk/Convex
deployment validation), [docs/hardware-protocol.md](docs/hardware-protocol.md) (device provisioning/display/intent wire
format), [roadmap/open-input-media-voice-environments-roadmap.md](roadmap/open-input-media-voice-environments-roadmap.md)
(active product roadmap), and [roadmap/IMPLEMENTATION-STATUS.md](roadmap/IMPLEMENTATION-STATUS.md)
(canonical verified progress). Milestone 0.5 is complete; Milestones 0–5 remain open.

Firmware is PlatformIO C++ under four board folders; copy `include/controller_config.example.h` to
`controller_config.h`, then `pio run`.

| Folder | Board | State |
|---|---|---|
| `CrowPanel-ESP32-2.13-E-paper` | 2.13" e-ink, five active-low keys | Most complete gateway-connected implementation; 4 build environments; current silicon validation not recorded |
| `vision-master-t190` | 1.9" TFT | Bring-up sketch |
| `Waveshare-ESP32-S3-Touch-AMOLED-1.75C` | 466x466 round AMOLED touch, dual-mic array | Scaffold; pin map unverified |
| `Hosyond-ESP32-S3-2.8-Touchscreen` | 2.8" IPS 240x320 touch, on-board mic + speaker (ES8311) | Hardware-proven capture/display/orb/provisioning prototype; no shared gateway client or touch path |

Every board is pinned to **ESP-IDF 5.5 / Arduino core 3.3** via the pioarduino platform fork. The official
`platformio/platform-espressif32` is unmaintained at Arduino 2.0.17 / ESP-IDF 4.4, which lacks `driver/i2s_std.h`
and cannot build the audio boards. Changing the pin means re-verifying all 11 environments.

**Every ESP32-S3 board is BLE-only** — no Bluetooth Classic, so no HFP headset microphone, and no LE Audio.
Bluetooth earbuds cannot be a microphone source on any current or planned board. On-board mics or a phone
companion are the two real paths.

`firmware/shared/AgentControllerCore` (via `lib_extra_dirs`) owns the writable device state and orb
renderer the boards share:
`DeviceStore` wraps NVS (namespace `agentctl`) for identity, gateway URL, Wi-Fi credentials, the cached claim code, and
the config cache; `Provisioning` is the boot state machine plus a SoftAP captive portal. **`controller_config.h` is a
bench seed, not a source of truth** — `DeviceStore` copies it into NVS only on a unit that has none, and a factory unit
gets its identity from the `nvsSeed` CSV that `POST /v1/factory/batches` returns. There is no `WIFI_SSID` macro any more;
the factory cannot know the customer's network. CrowPanel uses EXIT hold for Wi-Fi reset; Hosyond
uses BOOT hold, while a short BOOT tap reopens its configuration portal. See
`firmware/shared/README.md` and the board READMEs.
