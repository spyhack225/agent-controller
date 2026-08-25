# Implementation status

Canonical progress ledger for
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
This file records what the repository can do now; the roadmap records the target and sequence.
Anything not marked **done** is not complete.

Last verified: **2026-08-24**, at commit `1d7ad51`.

## Verified baseline

- **Delivery:** Milestone 0.5 is complete. Milestones 2 and 3 are substantially complete —
  this file previously recorded both as not started, which was wrong. Milestone 4 is partial.
  Milestones 0, 1 and 5 are not started.
- **Web/server gate:** production frontend build and typecheck pass; 204 frontend tests pass;
  439 server tests, 436 passing, 3 S3 integration tests intentionally skipped when no S3 service
  is configured.
- **Firmware gate:** all PlatformIO environments across four board folders compile.
- **Hardware evidence:** Hosyond ES3C28P has been flashed and exercised on silicon: 8 MB PSRAM,
  16 MB flash, battery reading, ES8311 codec, microphone samples, SoftAP provisioning, ILI9341
  display, panel polarity, and the orb UI. Other boards remain unvalidated on hardware.
- **Onboarding proven end to end, without user-side flashing:** a factory NVS seed was written
  once, after which the owner entered Wi-Fi through the SoftAP portal, the device discovered the
  gateway over LAN broadcast, reported itself unclaimed, displayed its claim code, and was claimed
  from the console.
- **Reboot loop fixed and verified on hardware.** Two distinct bugs, found in sequence:
  1. Both HTTP call sites declared `HTTPClient` before the `WiFiClient` handed to `begin()`. C++
     destroys locals in reverse order, so `~HTTPClient()` ran `stop()` on freed memory.
  2. `ThinkingOrb`'s scratch buffer was a file-scope global shared by every orb instance while
     `capacity_` stayed per-instance, so `pushDot()`'s bound check guarded the wrong object. The
     UI builds a 900-dot orb then a 180-dot one; the smaller `begin()` ran last and shrank the
     shared buffer, and the main orb kept writing 405 entries into room for 180 — 2.7 KB past the
     end, thirty times a second, into the internal-RAM pool the WiFi driver takes its buffers
     from. Hence panics inside `ieee80211_crypto_decap` and `etharp_tmr` with none of our code on
     the stack, and hence invisible to `heap_caps_check_integrity_all()`, which validates block
     headers while the overrun landed in payload.

  **150 s soak after the fix: 0 resets, 0 panics** (previously 18 resets in 120 s). This also
  explains the "device only ever shows Ready" symptom: the device reached `link: claimed` and then
  crashed during the config burst before it could paint the operate screens. One bug, two symptoms.
- **Render stall resolved.** The gateway cycle now runs on core 0 while the renderer keeps core 1.
  Measured on hardware: **worst frame gap 2332 ms -> 68 ms**, sustained 30.3 fps, typical draw
  9-20 ms of a 33 ms budget, 170 s soak with 0 resets and 0 panics.

  The first attempt at this crashed within seconds and was withdrawn. The second core was never the
  problem; sharing mutable Arduino Strings across it was. Three things make it correct:
  `request()` hands the state lock back for the duration of every socket wait (tracking recursion
  depth explicitly, since a recursive mutex only releases when given back as many times as taken);
  all 14 touch-driven entry points take the lock themselves; and the renderer holds it across the
  whole frame — affordable only because of the first point — skipping a frame rather than painting
  from state being rewritten underneath it.
- **The device UI is a real operate surface**, not a status screen: contextual action bar,
  pull-down status drawer, and environment -> folder -> thread browsing. Orb state selection is a
  total table over the vocabulary the gateway actually sends; it previously matched only one of
  those words and rendered failed turns identically to idle ones. Four of the nine animations
  (searching, solving, weaving, shaping) have no honest trigger yet and are deliberately unused
  outside the `-orbbench` environment.
- **Speaker and notification LED** are implemented behind compile flags. The LED pin (GPIO42) is
  documented from four vendor sources; no LED has been lit and no sound has been heard, so both
  remain hardware-unverified.
- **Critical product gap:** a request can be dispatched to T3 Code, but Agent Controller still
  cannot show and interact with the complete live response, provider approvals/questions,
  subagents, or parallel work. This is Milestone 1. Its transport foundation has now landed (see
  below); the user-visible parity work has not.

The frontend build also reports a non-blocking JavaScript chunk-size warning (about 655 kB).
Firmware compilation reports deprecated ESP32 legacy I2S/PCNT API warnings in capture/probe code.

## Correction notice

Milestone numbering clashes between artefacts: commit `49caa52` calls the Parakeet/voice work
"Milestone 2" while the roadmap calls it Milestone 3. The roadmap's numbering is authoritative
here. Earlier revisions of this file recorded Milestones 2 and 3 as `todo` when both were largely
implemented, and listed "shared firmware gateway client" as an active blocker after it had been
resolved. Status claims in this file are now expected to cite the file or test that evidences them.

## Legend

| State | Meaning |
|---|---|
| done | Implemented and covered by the current verification gate |
| partial | Useful implementation exists, but the roadmap outcome is not met |
| todo | Scheduled but not implemented |
| blocked | No meaningful implementation can continue until the named dependency changes |

## Category progress

| Category | State | What is real now | What remains |
|---|---|---|---|
| 1. Open request and composer | partial | Operate sends arbitrary text; ordered multi-attachment selection, removal, reordering, and first-turn attachments work | One unified composer, inline capture/upload, QuickPage composer, request envelope/state machine, and idempotency |
| 2. Unified media | partial | Media library supports browser upload, recording, camera capture, manual transcription/editing, retention, and deletion; Operate can reuse stored media | Reusable picker/capture dialog in the composer, raw upload/finalize, upload state, previews, paste/drop, and richer origin metadata |
| 3. Voice transcription | todo | Synchronous `disabled`, `mock`, and OpenAI provider branches and manual transcription exist | CPU-hosted Parakeet adapter, durable jobs, automatic processing, raw/normalized transcript versions, correction, retry, review/auto-send, and metrics |
| 4. Controller voice | partial | Hosyond records 16 kHz mono audio to PSRAM and proves the microphone; the display and orb UI run on hardware | Shared gateway client, upload/dispatch, device request status, touch/review controls, PWA deep link, and response/interaction projection |
| 5. T3 environments | partial | Eight typed failure reasons, reason-specific recovery, dependency preview, idempotent removal, reference repair, and in-place environment update exist | `T3Adapter`, probed capability manifest, console-first pairing/discovery, guided handoff, tombstones, and dependency-label confirmation |
| 6. Live T3 conversation | todo | Snapshot message normalization, one-shot WebSocket RPC, compact pending-interaction counts, and low-level approval command building exist | Persistent thread subscription, event folding, streamed responses/tools, T3 approval and user-input UI, subagent/work graph, background liveness, reconnect/backfill, and notifications |
| 7. Security, observability, testing | partial | Auth, policy, TLS controls, rate limits, media ownership/quotas, signed URLs, redaction, audit, diagnostics, and strong Milestone 0.5 tests exist | Voice-queue/live-stream metrics and audit, request/task attribution, new store parity, failure injection, and end-to-end tests for the initiative |

## Milestone progress

### Milestone 0.5 — independent repairs: done

| Item | State | Evidence |
|---|---|---|
| Remove environment + dependency repair | done | Dependency preview; idempotent delete; actions/macros disabled with `environment_removed`; onboarding and device defaults repaired across stores |
| Reason-specific recovery dialog | done | Eight failure reasons, retryability metadata, reason-specific instructions, and recovery polling behavior |
| First-turn attachments | done | Project launch resolves and passes attachments through the same ownership/type/limit checks as follow-up turns |
| Multiple attachments end to end | done | Ordered list, maximum of eight, scalar protocol-v1 alias, validation, and Operate add/remove/reorder controls |

The current Remove flow still hard-deletes the environment rather than retaining a tombstone, and it
does not require typing the environment label. Those are Category 5 hardening tasks, not regressions
in the completed Milestone 0.5 repair.

### Milestone 0 — contracts and diagnostics: todo

No milestone deliverable has landed. The repository has no `RequestSubmission`,
`clientRequestId`, `/v1/requests`, durable request state machine, long-lived T3 subscription, work
node model, or expanded probed capability manifest. The `/v1/intents` versus `/v1/requests` design
decision remains open.

### Milestone 1 — live conversation and interaction parity: partial

**The transport is real now.** `orchestration.subscribeThread` had been a string constant in
`src/t3Ws.mjs` that nothing called; the gateway learned what an agent had done by refetching a
snapshot every five seconds. `openT3ThreadStream()` (`src/t3Ws.mjs`) now holds a real
subscription — acknowledging every `Chunk`, because effect's RpcServer parks the stream on a latch
until it does (`effect/dist/unstable/rpc/RpcServer.js:271-291`) — and `src/threadStream.mjs`
turns it into `t3.thread.snapshot` / `t3.thread.event` / `t3.thread.status` on the existing SSE
broker. Subscriptions are demand-driven leases (`POST|DELETE
/v1/t3/environments/:id/threads/:threadId/watch`, renewed automatically by a device polling
`/v1/device/thread-output`), resume by T3's global event sequence, deduplicate the replay/live
overlap, and reconnect on exponential backoff. A resume gap T3 refuses to replay
(`THREAD_RESUME_MAX_GAP`) arrives as a snapshot and is published with `gap: true` rather than
silently appended. Constructed in `createApp()`, started only from `server.mjs`, driven by
`runOnce()` in `test/threadStream.test.mjs` (17 tests). `src/commandArbiter.mjs` makes the live
stream and the snapshot poller share one decision per command.

**What remains is the milestone itself.** Nothing renders these events: the console's
`useController()` does not subscribe to `t3.thread.*` and no view shows a live conversation or
provider tool activity. Provider approvals still route through the existing capability path with
their gateway decision set rather than T3's, structured user input (`thread.user-input-response`)
is not wired, and subagent/parallel-work inspection does not exist.

### Milestone 2 — composer and connection: substantially done

Corrected: this was recorded as `partial` with the composer "not landed". It had landed.
`frontend/src/features/Composer.tsx` exports `ComposerShell`, `useComposerDraft`,
`buildComposerIntent` and `sendComposerIntent`, and pulls `MediaPicker`/`MediaCaptureDialog` from
`MediaCapture.tsx`; `Composer.test.tsx` covers ten cases including paste/drop, the single source
menu, camera reuse, and the server attachment ceiling. `QuickPage.tsx` imports the same composer
rather than forking it, and `MediaPage.tsx` reuses `MediaCaptureDialog` — a real extraction.
Console-first connection landed as `POST /v1/t3/connect-sessions` + `/redeem` +
`GET /v1/t3/connect-sessions/:id` (`src/connectSession.mjs`, 7 tests); local discovery as
`GET /v1/discovery` (`src/discovery.mjs`, 5 tests); guided re-pair as
`PUT /v1/t3/environments/:id`.

Outstanding: funnel instrumentation for the Add-environment flow.

### Milestone 3 — automatic Parakeet voice pipeline: substantially done

Corrected: this was recorded as `todo` asserting none of it existed. Most of it does.
`src/transcription.mjs` lists `parakeet` in `TRANSCRIPTION_PROVIDERS` with a dedicated adapter,
concurrency gate and three terminal pre-checks (`test/parakeet.test.mjs`, 16 tests).
`src/mediaJobs.mjs` implements the durable stage machine
`queued → transcribing → normalizing → review_required|ready → dispatching → dispatched`
(`test/mediaJobs.test.mjs`, 19 tests). Transcript versioning exists as
`rawTranscript`/`normalizedTranscript`/`userEditedTranscript` with the `describeTranscriptChange`
letter-preservation guard. Auto-send is `PUT /v1/devices/:id/voice-auto-send` with the policy
re-read at dispatch. Metrics cover `queueWaitMs`, `gateWaitMs`, `inferenceMs`, `realtimeFactor`.
The device loop is `POST /v1/device/media` → `GET /v1/device/media/jobs/:id`
(`src/deviceAudio.mjs`, 13 tests).

Outstanding, and genuinely missing: the two-step raw upload/finalize protocol. Media still moves as
base64 JSON through `POST /v1/media`; there is no `uploadStatus` field distinct from processing
status, no presigned PUT, and no abandoned-session cleanup.

### Milestone 4 — controller voice paths: partial

Corrected: the shared gateway client HAS been extracted. `firmware/shared/AgentControllerCore/src/`
now holds `GatewayClient.{h,cpp}`, `GatewayDiscovery.{h,cpp}`, `GatewayOperate.cpp`,
`MediaUpload.{h,cpp}` and `OperateModel.h`; the Hosyond `main.cpp` instantiates `GatewayClient` and
`ui.cpp` includes `MediaUpload.h`. Three boards pull `lib_extra_dirs = ../shared`.

The device can also now list and select its environment, project and thread — `GET/POST
/v1/device/environments`, `/v1/device/projects`, `/v1/device/threads` and the matching
`/v1/device/config/*` setters (documented in `docs/hardware-protocol.md`).

Outstanding: the PWA deep-link/QR companion (`claimLink.ts` handles device *claiming*, not thread
deep links), and silicon validation of the operate UI and its gateway calls.

### Milestone 5 — adapter hardening and rollout: todo

Compatibility checks, scopes, and transport helpers predate this initiative, but there is no
consolidated `T3Adapter`, rollout flags for the new flows, load/failure testing, or staged beta for
live threads and voice.

## Hardware status

| Board / component | State | Current evidence |
|---|---|---|
| CrowPanel 2.13-inch e-paper | partial | Most complete gateway-connected firmware; four environments compile; no current silicon validation recorded |
| Hosyond ES3C28P | done (hardware) | Only board validated end to end on silicon: provisioning, LAN discovery, claim, flash/PSRAM, battery, codec, microphone, ILI9341 display, polarity, touch, orb rendering, BOOT recovery. Operate UI confirmed on glass from photographs. 170 s soak: 0 resets, 0 panics, 30.3 fps, worst frame gap 68 ms. Speaker and LED compile but are unheard and unlit |
| Waveshare AMOLED 1.75C | partial | Two scaffold environments compile; board and pin map remain unverified on silicon |
| Vision Master T190 | partial | One bring-up environment compiles; placeholder pins and incomplete protocol client remain |
| Shared `AgentControllerCore` | done | `DeviceStore`, `Provisioning`, `ThinkingOrb`, `OrbPainter`, `GatewayClient`, `GatewayDiscovery`, `GatewayOperate`, `MediaUpload` and `OperateModel` are all shared and consumed by three boards |

## Active blockers and next dependency

1. **Live T3 event contract:** Milestone 0 must define the long-lived subscription, sequence,
   resume, deduplication, interaction, and work-node contracts before the conversation UI can be
   reliable.
3. **Request API decision:** choose either one expanded `/v1/intents` path or a new
   `/v1/requests` path with a dated intent deprecation. Do not leave two indefinite policy entry
   paths.
4. **Parakeet job boundary:** automatic CPU transcription needs a durable request/media job model;
   the current synchronous HTTP handler is not a safe base for device retries or auto-send.

## Next recommended implementation order

1. Settle the request API and live-thread contracts in Milestone 0.
2. Implement Milestone 1 so dispatched work becomes a complete, interactive T3 conversation.
3. Finish the unified Operate/QuickPage composer and console-first connection flow.
4. Add the CPU-hosted Parakeet queue and review/auto-send policies.
5. Extract the shared firmware gateway client, then connect Hosyond capture to the same request
   pipeline.
6. Consolidate the adapter and run staged load, failure, security, retention, and end-to-end gates.
