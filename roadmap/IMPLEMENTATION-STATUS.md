# Implementation status

Canonical progress ledger for
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
This file records what the repository can do now; the roadmap records the target and sequence.
Anything not marked **done** is not complete.

Last verified: **2026-08-24**, at commit `ba35cbc` plus any later documentation-only changes.

## Verified baseline

- **Delivery:** Milestone 0.5 is complete. None of Milestones 0–5 is complete.
- **Web/server gate:** production frontend build and typecheck pass; 166 frontend tests pass;
  341 server tests pass and 3 S3 integration tests are intentionally skipped when no S3 service is
  configured.
- **Firmware gate:** all 11 PlatformIO environments across four board folders compile: CrowPanel
  4, Hosyond 4, Waveshare 2, and Vision Master T190 1.
- **Hardware evidence:** Hosyond ES3C28P has been flashed. Its 8 MB PSRAM, 16 MB flash, battery
  reading, ES8311 codec, microphone samples, SoftAP provisioning, ILI9341 display, panel polarity,
  and orb UI have been exercised on silicon. Other boards remain unvalidated on hardware.
- **Critical product gap:** a request can be dispatched to T3 Code, but Agent Controller still
  cannot show and interact with the complete live response, provider approvals/questions,
  subagents, or parallel work.

The frontend build also reports a non-blocking JavaScript chunk-size warning (about 655 kB).
Firmware compilation reports deprecated ESP32 legacy I2S/PCNT API warnings in capture/probe code.

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

### Milestone 1 — live conversation and interaction parity: todo

No user-visible parity deliverable has landed. Agent Controller still ends the visible workflow at
`dispatched`; it cannot stream the selected T3 thread, render provider tool activity, answer T3
questions, route provider approvals with their full decision set, or inspect subagents and parallel
tasks. Existing snapshot normalization and one-shot RPC helpers are prerequisites, not milestone
completion.

### Milestone 2 — composer and connection: partial

Operate already has free-form text and the Milestone 0.5 ordered-attachment controls. Environment
updates can preserve an existing record. The unified picker/capture composer, QuickPage composer,
console-first connection handoff, local discovery, and guided re-pair flow have not landed.

### Milestone 3 — automatic Parakeet voice pipeline: todo

No Parakeet code, ASR service, processing queue, raw upload/finalize protocol, transcript versioning,
automatic transcription, retry, or auto-send policy exists. Current transcription remains an
explicit, synchronous Media-page operation. The target is CPU-hosted Parakeet V2; a GPU is optional
for higher concurrency, not a server requirement.

### Milestone 4 — controller voice paths: partial

Hosyond hardware capture and visual status work are real. The clip remains local to the device
because the shared gateway client has not been extracted. The PWA companion/deep link and compact
response/interaction experience are also missing.

### Milestone 5 — adapter hardening and rollout: todo

Compatibility checks, scopes, and transport helpers predate this initiative, but there is no
consolidated `T3Adapter`, rollout flags for the new flows, load/failure testing, or staged beta for
live threads and voice.

## Hardware status

| Board / component | State | Current evidence |
|---|---|---|
| CrowPanel 2.13-inch e-paper | partial | Most complete gateway-connected firmware; four environments compile; no current silicon validation recorded |
| Hosyond ES3C28P | partial | Four environments compile; provisioning, flash/PSRAM, battery, codec, microphone, ILI9341 display, polarity, orb rendering, and BOOT recovery were exercised on hardware; no gateway client, touch, upload, or agent-state feed; orb buffer/anti-alias tuning is active |
| Waveshare AMOLED 1.75C | partial | Two scaffold environments compile; board and pin map remain unverified on silicon |
| Vision Master T190 | partial | One bring-up environment compiles; placeholder pins and incomplete protocol client remain |
| Shared `AgentControllerCore` | partial | `DeviceStore`, `Provisioning`, and `ThinkingOrb` are shared; gateway transport, heartbeat, display-state, intent, OTA, and media upload are not |

## Active blockers and next dependency

1. **Live T3 event contract:** Milestone 0 must define the long-lived subscription, sequence,
   resume, deduplication, interaction, and work-node contracts before the conversation UI can be
   reliable.
2. **Shared firmware gateway client:** Hosyond can capture audio but cannot upload or dispatch it
   until the CrowPanel gateway logic is extracted into `firmware/shared/AgentControllerCore`.
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
