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

### Agent verbs (what the orb animates)

The controller renders nine orb animations. Five were driven by the words this gateway already
speaks; `searching` / `solving` / `weaving` / `shaping` are now derived in `src/agentVerb.mjs` and
published on the **selected** row's `status` in `GET /v1/device/threads` — the one field the orb
reads (`presentationForState()` in the Hosyond `ui.cpp`). The other six words are never replaced;
a verb only ever refines `running`.

**The snapshot cannot answer this and never could.** T3's own handler comment
(`src/orchestration/http.ts` in the 0.0.32 source map) says `GET /api/orchestration/snapshot`
serves "the lightweight command read model (thread bodies empty)" because hydrating every message
and activity "has OOM-killed servers" — which is why `test/fixtures/t3-snapshot.json` carries no
`messages` and no `activities` on any thread. The work log lives on
`GET /api/orchestration/threads/:threadId`, contract endpoint `threadSnapshot`, with an optional
`?turnLimit=` window. `fetchT3ThreadDetail()` calls it with `turnLimit: 1`, for the selected thread
only, and only while that thread is running.

The evidence is `thread.activities[]` (`OrchestrationThreadActivity`), whose tool rows
`ProviderRuntimeIngestion.ts` emits as `kind: tool.started|tool.updated|tool.completed` with
`payload.itemType` from `TOOL_LIFECYCLE_ITEM_TYPES` and a `payload.data` that
`ActivityPayloadProjection.ts` slims to `{item, command, files[].path, toolCallId, kind, rawOutput}`
— so `data.rawInput` is **not** on the wire and nothing may read it.
`classifyToolActivity()` is a port of T3's own `classifyToolAction`
(`packages/shared/src/toolActivity.ts`), so the gateway and the T3 UI cannot disagree about what a
tool call was.

Three refusals are the point: a settled turn yields no verb, an activity stamped with a different
`turnId` never speaks for the live one, and an unclassifiable tool (`mcp_tool_call`,
`dynamic_tool_call` with no `data.kind`) stays at `running`. A single-file edit is likewise not
`weaving`, which means "coordinated edits across multiple files" and needs two distinct paths.
T3 publishes no "the model is generating" activity, so a finished `tool.completed` with nothing
after it still reports that tool — a known, uncloseable gap.

**Known firmware gap:** `orbModeForAgentState()` compares against lowercase literals
(`ThinkingOrb.cpp`), but `GatewayOperate.cpp` upper-cases `ThreadOption.status` before the orb table
reads it, so the fallback mapper cannot match a verb until that compare is made case-insensitive.

### Media storage and processing

`storagePath` on a media record is a **local path or an S3 object key** depending on
`MEDIA_STORAGE_PROVIDER`; the record shape and Convex schema are identical either way, so switching
backends needs no migration. `readStoredMedia`/`deleteStoredMedia` take `config` as a second
argument — omit it and they always hit local disk, which is a silent bug under S3.

`src/s3.mjs` speaks SigV4 by hand (no dependency). Leave `S3_FORCE_PATH_STYLE` unset unless you
mean it: unset auto-detects (MinIO/R2 need path style, AWS does not), and coercing it to `false`
breaks non-AWS endpoints.

Two pluggable media processors, both `disabled` | `mock` | real provider, but no longer the same
shape. `describeStoredImage` (`src/vision.mjs`) still runs inside the request; transcription does
not. Images carry `visionStatus`/`descriptionSource`; audio carries
`transcriptionStatus`/`transcriptSource`. A vision description is user content — it is redacted from
support bundles alongside every transcript version.

### Media names are derived, never stored

Firmware calls every recording `controller.wav`, so a library of controller captures was a column of
identical rows. `src/mediaNaming.mjs` builds a `displayName` on read instead —
`Hosyond Touch screen · Verify Workspace · 24 Aug 19:32` — from the device label, the thread the
capture was pinned to, and its creation time, plus a structured `origin`. `nameMediaRecords()` in
`app.mjs` attaches both to every owner-facing media response.

**Derived, not stored, for the same reason the transcript diff is** (`withTranscriptChange`): a
stored name goes stale the moment a device is relabelled or a thread retitled, and it would need a
migration to reach clips a user already has. `originalName` is never overwritten — it is what the
client uploaded and what the agent still sees as the attachment filename.

The destination comes from the media **job** (`job.threadId`, pinned at enqueue), falling back to
`device.config.threadId`; the current binding is where the device points *now*, not where the
capture was going. Thread titles exist only in T3, so they are remembered from snapshots the gateway
already fetches (`readT3Snapshot()`, the poller) rather than fetched per listing, with one
short-timeout refresh for a stale environment and failures cached like successes. Every segment is
optional and every degenerate case has a defined answer: no label gives `Controller 7d2c9f`, no
thread drops the segment, an unresolvable title gives `Thread 4f2a1c`, a console upload gives
`Console · diagram.png · ...`. The frontend never composes its own name — `mediaLabel()` in
`features/MediaCapture.tsx` is the single reader, so the library, the composer picker and an
attachment chip cannot disagree. Support diagnostics deliberately keep the **undecorated** records: a
thread title would be new user content in the bundle.

### Transcription is a durable job

A 30-second ASR call held a connection open and died with the process, leaving the media stuck at
`processing` forever. So `POST /v1/media/:id/transcribe` now answers **202 with a job row** and
`src/mediaJobs.mjs` drives it — the same shape as the snapshot poller: constructed in `createApp()`,
**started only from `server.mjs`**, with a `runOnce()` tests call directly.

`src/transcription.mjs` is the provider interface (`transcribe()` → raw text plus metadata, or a
`TranscriptionError`). Its `retryable` flag is the whole point: a 429 or a timeout goes back to
`queued` and costs one attempt, while a missing API key fails terminally instead of burning three
identical attempts.

`failureCause` is the second axis on that error, and it is **declared at the throw site, never
parsed out of the message**: `configuration` (no provider, missing credential, sidecar that was not
running, English-only checkpoint pointed at French), `input` (container nothing decodes, clip over
the length limit, silence), `provider` (a 500, a timeout, storage having a bad minute) and
`unknown`. It is recorded on *every* failure, not only terminal ones — a retryable failure that
later burns the last attempt is failed inside `claimMediaJobs`, which has no error to look at and
inherits the cause left on the row.

Stages: `queued → transcribing → normalizing → review_required|ready → dispatching → dispatched`,
with `failed` terminal. `dispatched` and `failed` are never re-claimed — that is what stops a
restart from dispatching the same transcript twice.

**The one exception is an owner asking.** `POST /v1/media/jobs/retry-configuration` (owner realm)
requeues failed jobs whose recorded cause is `configuration`, and nothing else; it refuses with 409
when no provider is usable *now*, resets `attempts` to zero (the budget was spent on a fault that no
longer exists), and reports every skipped job with its cause. There is deliberately no boot hook and
no poller sweep: a terminal stage promises nothing happens on its own, and only a person may break
that promise. `store.requeueMediaJob()` also forces `reviewRequired` on, which is not a parameter —
see the safety rule below.

Two subtleties worth keeping:

- **`claimMediaJobs` recomputes the stage from stored evidence** (`resumeStageFor`), not from where
  the job crashed. A worker that died after recording the raw transcript does not pay for the ASR
  call again. A job whose `attempts` are spent is failed *inside the claim* rather than handed out,
  or it would be rediscovered on every tick forever.
- **The transcript is versions, not a field.** `rawTranscript` (verbatim ASR, whitespace included)
  and `normalizedTranscript` are write-once — `updateMediaJob` silently ignores a second write.
  Only `userEditedTranscript` stays writable, and the last version present wins. `review_required`
  is not runnable: it waits on a person and must not hold a lease.

The audio is never consumed. A transcript is derived; the upload has to stay playable.

**Normalisation may move spacing, punctuation and case — never letters.** `describeTranscriptChange()`
enforces that by comparing the two versions with everything but letters and digits stripped out; if
they differ, the job parks at `review_required` whatever `TRANSCRIPTION_REVIEW_REQUIRED` says. A
"correction" that changes someone's command has to be shown as a diff, not dispatched on their
behalf. The diff is computed on read (`withTranscriptChange` in `app.mjs`) rather than stored, so it
cannot go stale against the versions it describes.

### The device voice loop

`POST /v1/device/media` **enqueues transcription itself** — a controller records, uploads, and is
done, so nothing else was ever going to ask. Before this, device audio was stored and never
transcribed; the only caller of the transcriber was the owner-facing endpoint.

The device gets back one id and polls one device-realm route, `GET /v1/device/media/jobs/:id`, which
returns the projection in `src/deviceAudio.mjs` — six milestones (`recorded`, `uploading`,
`transcribing`, `review`, `ready`, `sent`, `failed`) plus `done`/`ok`/`transcript`/`error` and
nothing else. Stages, leases, attempt counts, provider names and timings are worker bookkeeping a
few square centimetres of screen cannot render, and they stay on `/v1/media/jobs/:id`. The route is
scoped to `job.deviceId`, not merely to the owner: two controllers on one account are two
microphones in two rooms, and the transcript is in the response. The same projection builds the
`media.job` SSE payload, so a console that listens and a device that polls cannot disagree.

**Auto-send is three-valued, and defaults on for a microphone.** `device.voiceAutoSend.ownerChoice`
is `true`, `false`, or `null` for "never said"; `enabled` is derived — an explicit choice always
wins, and only in its absence does the hardware decide, from `status.features` including
`microphone` (evidence the firmware sent, never the board's datasheet). A controller whose whole
purpose is to be spoken to should work when it is spoken to; a board that never claimed a microphone
gets nothing. The third state is load-bearing: with a plain boolean, an owner's "off" is
indistinguishable from silence and the default would switch it back on at the next heartbeat,
restart or re-claim. `PUT /v1/devices/:id/voice-auto-send` (owner realm) takes `true`, `false`, or
`null` to withdraw the decision; `enabledBy`/`enabledAt` stay null for a default, because a default
has nobody behind it and must not be recorded as a grant somebody signed. Still per device, never
per account: a device claimed later earns its own answer from its own hardware.

**A capture requeued by the configuration-retry path always waits for a person**, whatever the
grant says. The grant means "send what I say as I say it" — it was never consent for what was said
last Tuesday, and a bulk retry could otherwise dispatch a batch of hours-old transcripts into a
coding agent as instructions. The rule lives in `requeueMediaJob()` (forced `reviewRequired`) and is
enforced again in the worker, which parks a `ready`/`dispatching` job that must be reviewed and has
no `userEditedTranscript` — necessary because `resumeStageFor()` sends a job already holding both
transcript versions straight to `dispatching`, past the normalizing stage where review is normally
decided.

**The grant, the device and the policy are read at dispatch, never at enqueue.** A capture can sit
through a retry budget while the owner tightens a profile or revokes the grant, and the newer rule
has to win; `dispatchVoiceTranscript()` in `app.mjs` re-reads all three and then goes through the
ordinary `submitIntent()` path. The worker itself knows nothing about policy — the hook is injected
into `createMediaJobRunner()`.

Transcription succeeding and the send being refused are independent, which is why the outcome lives
on its own fields (`dispatchStatus`, `dispatchError`, `commandId`, `autoSend`) instead of
`lastError`/`failureKind`. A blocked send still reaches stage `dispatched`, because the transcript
is on the media record and the owner has something to look at; reporting it as `ready` would claim
the words are waiting when the gateway has already declined to act on them.

### The parakeet adapter

`TRANSCRIPTION_PROVIDER=parakeet` is its own adapter in `src/transcription.mjs`, not the OpenAI
branch with a different URL. It talks HTTP to a local sidecar running `nvidia/parakeet-tdt-0.6b-v2`:
the gateway never imports Python and never blocks its event loop on inference. The sidecar is
`scripts/parakeet-sidecar.py` and its weights come from `scripts/fetch-parakeet-model.mjs`
(`npm run parakeet:fetch` then `npm run parakeet:sidecar`). It runs the ONNX export of the
checkpoint under onnxruntime rather than the `.nemo` archive under nemo_toolkit — same weights,
without PyTorch/Lightning/Hydra — and nothing about the ONNX choice is visible to the gateway,
which only ever sees the HTTP contract in `docs/api.md`. **Leaving `TRANSCRIPTION_PROVIDER` unset
means `disabled`, and a disabled provider fails every job terminally**: the voice pipeline is inert
until it names a real provider, which is not obvious from the media UI. CPU is the supported
default, which is why `PARAKEET_TIMEOUT_MS` is minutes and `PARAKEET_CONCURRENCY` is 1 — the gate in
`createConcurrencyGate()` hands a released slot straight to the next waiter, because decrementing and
re-acquiring would let a fresh caller overtake the queue.

Three things it refuses before spending an inference, all terminal because no retry changes them:
a container outside `PARAKEET_ACCEPTED_CONTENT_TYPES` (browser WebM/Opus and MP4/AAC and controller
WAV are in; anything else fails naming the list, rather than becoming an opaque 4xx from a Python
traceback); a WAV whose own header says it is longer than `PARAKEET_MAX_CLIP_SECONDS`; and a
language the configured checkpoint cannot speak — v2 is English, and pointing it at French produces
confident nonsense rather than French, so that is a configuration error and is reported as one.

`timings` on a finished job carries `queueWaitMs`, `gateWaitMs`, `decodeMs`, `inferenceMs`,
`providerMs`, `normalizeMs` and `totalMs`, plus `realtimeFactor` (compute seconds per audio second)
when the sidecar reports the clip length — the number that decides whether a GPU is worth adding.

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
surface is listed as the return object at the bottom of `src/store.mjs`. `test/storeParity.test.mjs` guards the parts
that have to exist twice, including a check that every `gatewayStore:*` name the adapter maps is actually exported —
`updateMediaDescription` was mapped to a function that had never been written.

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
| `Hosyond-ESP32-S3-2.8-Touchscreen` | 2.8" IPS 240x320 touch, on-board mic + speaker (ES8311) | Five-screen touch UI over the shared gateway client (home/threads/send/reply/approvals) with hold-to-talk upload; 5 environments, `-controller` is the product build. Capture/display/orb/provisioning proven on silicon, the UI and every gateway call are not |

Every board is pinned to **ESP-IDF 5.5 / Arduino core 3.3** via the pioarduino platform fork. The official
`platformio/platform-espressif32` is unmaintained at Arduino 2.0.17 / ESP-IDF 4.4, which lacks `driver/i2s_std.h`
and cannot build the audio boards. Changing the pin means re-verifying all 11 environments.

A board **can** browse environments → projects → threads. That was untrue for most of this
project's life — `GET /v1/device/threads` was the only list the device protocol offered — and the
claim outlived the gateway change that fixed it. The routes are
`GET/POST /v1/device/environments` and `/v1/device/projects` alongside the thread pair
(`docs/hardware-protocol.md`, "Environment, project, and thread API"); each level is scoped by the
one above and every id is checked server-side, so the owner still keeps the boundary. The firmware
client is `firmware/shared/AgentControllerCore/src/GatewayBrowse.cpp`, in its own translation unit
with its own state rather than as members on `GatewayClient`, and the Hosyond board drives it.
Two limits are real: changing environment clears the project and thread server-side, and
`POST /v1/device/config/project` reads `projectId` as a **required** string — so a device can narrow
to a folder but cannot widen back out to "all folders" without the console.

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
