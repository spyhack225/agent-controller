# Open Input, Media, Voice, Live Threads, and Environment Roadmap

Status: **active**. Last code-and-test verification: **2026-08-24**. Milestone 0.5 is complete;
Milestones 0–5 remain open. The canonical, item-level progress ledger is
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). This roadmap supersedes the
product-usability portions of
[agent-controller-implementation-roadmap.md](agent-controller-implementation-roadmap.md), which
remains useful for the original platform, hardware, and commercial scope.

This roadmap covers the request to make Agent Controller an unrestricted, convenient control
surface for arbitrary agent requests; bring media and voice into the main composer; improve the
T3 Code connection and recovery flow; show and control the complete T3 conversation, including
approvals, user-input requests, subagents, and parallel work; and make obsolete environments easy
and safe to remove.

## Current progress snapshot

| Category | State | Progress as of 2026-08-24 |
|---|---|---|
| 1. Open request and composer | partial | Operate sends arbitrary text and ordered stored-media attachments; first-turn attachments work. Unified capture/upload and the QuickPage composer do not. |
| 2. Unified media | partial | The Media page uploads, records, captures photos, transcribes, edits, retains, and deletes. Those controls are not reusable from the composer. |
| 3. Voice transcription | todo | Manual synchronous providers exist; Parakeet, durable jobs, automatic processing, transcript versions, and auto-send do not. |
| 4. Controller voice | partial | Hosyond audio capture, microphone proof, display, and orb UI run on hardware. Upload/dispatch and phone-companion flows do not. |
| 5. T3 environments | partial | Typed recovery and dependency-aware removal are complete. Adapter consolidation, probed capabilities, discovery, console-first pairing, and tombstones remain. |
| 6. Live T3 conversation | todo | Low-level snapshot/RPC helpers exist, but users still cannot see or interact with the complete live response, T3 approvals/questions, subagents, or parallel tasks. |
| 7. Security, observability, testing | partial | Strong platform baseline and Milestone 0.5 coverage exist; initiative-specific stream, voice-job, attribution, and end-to-end coverage remain. |

| Milestone | State |
|---|---|
| 0.5 — independent repairs | **done** |
| 0 — contracts and diagnostics | todo |
| 1 — live conversation and interaction parity | todo |
| 2 — composer and connection | partial |
| 3 — automatic Parakeet voice pipeline | todo |
| 4 — controller voice paths | partial |
| 5 — adapter hardening and rollout | todo |

Verified gate: production frontend build and typecheck pass; 166 frontend tests pass; 341 server
tests pass with 3 S3 integration tests skipped when no S3 service is configured; all 11 PlatformIO
environments across four board folders compile. Hosyond is the only board with current silicon
evidence.

## Executive decisions

1. **Free-form requests are the default product path.** Saved actions and predefined commands stay
   available as hardware-friendly shortcuts, but they must not define what the user is allowed to
   ask an agent to do.
2. **One composer component, mounted on every surface that can send.** Text, upload, existing media,
   camera, and voice recording belong beside the Send action. Operate gets the full version and
   `QuickPage` gets a compact one — built from the same components, because a phone that can only
   approve and replay saved actions is the problem this roadmap exists to fix. The separate Media
   page remains the library and retention-management surface.
3. **Server-side transcription is the default voice path.** Keep the original audio, produce an
   immutable raw transcript plus an editable normalized transcript, and dispatch only after the
   selected review/auto-send policy is satisfied.
4. **Do not depend on direct T3 audio yet.** Current upstream T3 Code accepts image attachments in
   its typed attachment contract, not audio. Direct audio must be capability- and version-gated;
   transcription to text is the reliable baseline.
5. **Do not promise ordinary Bluetooth-earphone capture on any ESP32-S3 board.** The chip has
   Bluetooth LE but no Bluetooth Classic and no ESP-BLE-ISO/LE Audio support, so no board choice
   fixes it — the Waveshare AMOLED evaluated in Category 4 has the identical limitation. Use a
   phone/PWA with the earbuds, or a board with an on-board microphone. Treat a different
   radio/audio coprocessor as a future hardware program. In practice the earbuds were only ever a
   way to get a microphone, and an on-board array gets one without the radio problem.
6. **Environment failures need reason codes, not a generic outage string.** Milestone 0.5 shipped
   eight typed reasons covering stopped/unreachable T3, timeout, TLS, credential, and compatibility
   failures, with retryability and targeted recovery actions.
7. **“Unpair” was already a hard delete in the backend.** Milestone 0.5 replaced the ambiguous
   wording with a dependency-aware Remove flow and repaired live references. Historical tombstones
   and stronger label confirmation remain Category 5 hardening work.
8. **Connecting the first environment is part of this initiative, not a prerequisite for it.** The
   current path routes a new user to a terminal on another machine before the product does anything.
   Diagnosis and removal only matter once an environment exists; getting the first one connected is
   the step that decides whether anyone reaches the rest.
9. **The visible repairs shipped before the contract work.** Dependency-aware environment removal,
   reason-specific recovery, first-turn attachments, and multi-attachment support landed together
   as Milestone 0.5.
10. **A dispatch acknowledgement is not an agent conversation.** T3 remains the canonical source
    for thread messages, activities, session state, checkpoints, and background work. Agent
    Controller must load the selected thread detail and follow its live stream until it settles;
    the local `dispatched` command is only an acknowledgement and audit link.
11. **Keep Agent Controller approvals and T3 provider approvals distinct.** A gateway policy
    approval authorizes Agent Controller to dispatch a command. A T3 approval answers a provider
    request that occurred after dispatch. Give both visible source labels, different stable IDs,
    and separate response endpoints even when they appear in one pending-interactions area.
12. **Expose T3-native subagents and parallel work instead of inventing a second orchestrator.**
    Fold structured T3 task/workflow activities into one inspectable work graph. Show progress and
    outputs everywhere; show controls only when the certified T3/provider contract advertises them.

## What exists today

Every row below was re-verified against the code after Milestone 0.5 landed on 2026-08-24.

| Area | Existing implementation | Main gap |
| --- | --- | --- |
| Free-form web input | `OperatePage.tsx` sends arbitrary `agent_prompt` text through `POST /v1/intents` | Prompt/Image/Audio/Shell remain mutually exclusive intent modes, and upload/record/camera controls are not integrated into the composer |
| Mobile / Dashboard input | `QuickPage.tsx` renders the current workspace, the approval queue, and five saved actions | **There is no composer at all** — the page cannot send a free-form request and has no microphone. This is the recommended voice-companion surface |
| Saved controller input | Actions, macros, device controls, and protocol-v1 menu intents | Shortcuts are perceived as the only allowed requests; the small device has no general text-entry path |
| Browser media | `MediaPage.tsx` supports upload, microphone recording, camera capture, manual transcription/editing, retention, and deletion | Capture remains a separate workflow. Operate can choose multiple existing media items and reorder/remove them, but cannot upload, record, capture, paste, drag, or preview inline |
| Device media | `POST /v1/device/media`; the CrowPanel capture build can upload WAV/JPEG and submit an intent; Hosyond records and measures audio locally | Stock CrowPanel capture is compile-time off; Hosyond has no gateway client; device upload does not automatically start transcription |
| Media attachment transport | Signed media URLs, optional inline bytes, redacted persistence, ordered `mediaUploadIds`, per-item validation, an eight-item limit, and scalar protocol-v1 compatibility | The transport repair is complete. The remaining gap is the unified composer, richer processing state, raw upload/finalize, and durable request orchestration |
| First-turn attachments | The launch endpoint resolves owned media and passes attachments through `buildT3ProjectLaunchCommands` to the bootstrap turn | **Milestone 0.5 repair complete**; the future request envelope should reuse this path rather than add a third attachment contract |
| Speech-to-text | Synchronous `disabled`, `mock`, and OpenAI branches in `mediaStore.mjs`; manual trigger and transcript editing in the Media page | No Parakeet adapter, queue, automatic processing/dispatch, transcript versions, correction stage, or retry worker |
| T3 integration | HTTP snapshot/dispatch, WebSocket catalogue/terminal calls, compatibility checks | Hand-built contracts span several modules; error and attachment capabilities are too coarse |
| Live T3 response | The frontend normalizes snapshot `thread.messages` when present; `orchestration.subscribeThread` is named in `t3Ws.mjs` | The gateway uses a one-shot RPC helper that buffers until exit and closes. Operate therefore commonly shows the local `dispatched` command instead of T3 working state, streamed content, tools, or final answer |
| T3 interactions | `pendingThreadInteractions` produces compact approval/user-input counts; low-level approval command building exists | Operate renders only Agent Controller command approvals. T3 approval payloads and full decisions are not shown, and there is no `thread.user-input.respond` path or form |
| Subagents / parallel work | Full T3 thread activities may contain provider task/workflow lifecycle data | Agent Controller does not normalize task activities, background liveness, plan progress, parent/child identity, or per-task output. There is no agents/work inspector, parallel-task summary, notification, or capability-gated control |
| Workspace recovery | Eight typed failure reasons, retryability metadata, reason-specific instructions/actions, and availability polling | **Milestone 0.5 repair complete**. Setup instructions are still client-authored, and re-pairing is not yet a single guided in-place flow |
| Environment pairing (first run) | Four access modes, gateway profiles, token exchange, `npm run setup:t3` | Connecting a workspace still means running a wizard on the T3 host and pasting a token into the browser. No discovery, no guided handoff, no way to start from the console |
| Environment removal | The UI calls it Remove, previews dependent devices/actions/macros/onboarding, hard-deletes idempotently, clears defaults/selections, and disables fixed-target actions/macros with `environment_removed` across storage implementations | **Milestone 0.5 repair complete**. Historical tombstones, typed-label confirmation for dependency-heavy removal, and a richer post-removal redirect remain |

## Category 1 — Open request and composer experience

### Outcome

A signed-in user can type any request, record a voice request, attach one or more images/audio
items, and send it to the selected agent thread without first creating a saved action or choosing a
special command type. Hardware shortcuts remain fast entry points into the same request pipeline.

### Product and UX changes

1. Make one free-form textarea the primary control in `OperatePage.tsx`.
2. Replace the Image and Audio intent modes with an attachment button and attachment chips. Keep
   Shell as an explicit secondary mode because its policy and approval semantics differ.
3. The attachment button opens one source menu:
   - Upload from this device.
   - Record voice.
   - Take a photo.
   - Choose from Media library.
4. Show each pending attachment as a removable chip/preview with type, name, size, source, upload
   state, and processing state. Support multiple attachments, bounded by a server capability limit.
5. Let users paste or drag images/audio onto the composer on desktop. Preserve keyboard send,
   visible focus, screen-reader labels, reduced motion, and coarse-pointer targets.
6. Keep Saved actions in the existing disclosure below the composer. Copy should present them as
   reusable shortcuts, not as the allowed command vocabulary.
7. **Completed in Milestone 0.5:** new-thread launch accepts the same ordered attachment list and
   media validation as an existing thread. Preserve that behavior when the request envelope lands.
8. **Give `QuickPage.tsx` a composer.** The Dashboard is currently approvals plus five saved actions
   and nothing else, which makes it the strongest single illustration of "the app only runs commands
   someone already defined". It is also the phone-sized surface, so Category 4's recommended voice
   path lands here. Ship a compact version of the same composer — free-form text, one attachment
   button, push-to-talk — reusing the Operate components rather than forking them. A user who opens
   Agent Controller on a phone must be able to say something to an agent without navigating to
   Operate first.

### Contract and code work

1. Introduce a high-level request envelope used by web, phone/PWA, and devices:

   ```ts
   interface RequestSubmission {
     clientRequestId: string;
     environmentId: string;
     threadId?: string;
     projectId?: string;
     text: string;
     mediaUploadIds: string[];
     source: "web" | "pwa" | "device";
     delivery: "send_when_ready" | "review_transcript";
   }
   ```

2. Add `POST /v1/requests` as the orchestration-level API. It should validate ownership, media
   kinds, limits, environment/thread scope, and idempotency, then call the existing policy and
   `submitIntent` path when ready. Keep `/v1/intents` for backward compatibility and low-level
   controls.
3. Add a request-submission record with `received`, `processing`, `ready`, `dispatching`,
   `dispatched`, `failed`, and `cancelled` states. This avoids pretending a command exists before
   transcription and policy evaluation have completed.
4. Implement the record and methods in all storage implementations: `src/store.mjs`,
   `src/fileStore.mjs`, `src/convexStore.mjs`, `convex/schema.ts`, and
   `convex/gatewayStore.ts`. Add store-parity coverage.
5. Extend the launch endpoint in `src/app.mjs` and `buildT3ProjectLaunchCommands` in
   `src/t3Client.mjs` to carry attachments on the first turn.
6. Use `clientRequestId` as an idempotency key so reconnects and device retries never create two
   turns.
7. Emit request/media state changes through the existing SSE stream. Update the composer in place
   instead of forcing `refreshAll()` — which is twelve parallel requests (`controller.ts:268`), is
   already coalesced and rate-limit-throttled to keep it from storming, and is called after every
   send, action run, and approval today.

### Acceptance criteria

- A user can send arbitrary text to an existing or new T3 thread without creating an action.
- The same is true on a phone, from the Dashboard, without navigating to Operate first.
- A request can include multiple compatible media items from any supported source.
- Refreshing or retrying during upload/dispatch creates at most one T3 turn.
- Shell input still passes through the existing policy and approval path.
- Saved actions remain runnable from web and device, but no empty state implies they are required.

## Category 2 — Unified media capture, upload, and library

### Outcome

Media can be added at the moment of conversation, reused from the library, or captured by a claimed
controller. Every item shows where it came from and whether it is ready to send.

### Frontend work

1. Extract the creator in `MediaPage.tsx` into reusable `MediaPicker` and `MediaCaptureDialog`
   components. Reuse the existing `useAudioRecorder` and `useCameraCapture` hooks.
2. Mount the picker from the Operate composer and keep the Media page focused on library,
   transcript, processing, retention, and deletion management.
3. **Completed in Milestone 0.5:** `OperatePage.tsx` uses an ordered attachment draft with add,
   remove, move-up, and move-down controls. Replace its plain library selector with the reusable
   picker without regressing ordering.
4. Filter the library by the T3 adapter's supported types. Do not show audio as directly sendable
   when it still requires transcription; show `Transcribing`, `Ready`, or `Failed` instead.
5. Add origin metadata to `MediaItem` (`user`, browser/PWA, or device label), audio duration, image
   dimensions, checksum, and an optional thumbnail/waveform. The store already records `deviceId`;
   expose it in frontend types and render it.
6. Add audio playback and image preview before send. Both need explicit remove controls and should
   avoid downloading full media until opened.

### Upload and storage work

1. Retain the current base64 JSON route as protocol-v1 compatibility for short controller clips.
2. Add a raw, two-step upload protocol for browser/PWA and future firmware:
   - Create upload metadata and receive an upload ID/limit.
   - Upload raw bytes to an authenticated gateway endpoint or a short-lived pre-signed S3 PUT.
   - Finalize after size, MIME sniffing, and SHA-256 validation.
3. Enforce both declared and detected MIME type, per-kind size/duration limits, per-user quotas, and
   decompression/image pixel limits.
4. Keep media private by default. Continue using short-lived signed read URLs for T3 and stripping
   URLs/inline data from stored commands and support bundles.
5. Add explicit `uploadStatus` separately from transcription/vision status so a failed upload is
   not confused with a failed processor.
6. Add cleanup for abandoned upload sessions and retain the existing user-configured expiry purge.

### Device-originated media

1. Keep `POST /v1/device/media` authenticated with the claimed device credential and preserve
   `deviceId` attribution.
2. Return a compact processing/request ID so the controller can poll one status endpoint rather
   than infer success from several resources.
3. Add milestones that fit the e-ink UI: Recorded, Uploading, Transcribing, Ready/Review, Sent,
   Failed. Do not continuously animate telemetry.
4. Maintain the legacy upload + intent sequence during rollout, then activate the request envelope
   by device protocol version/capability.

### Acceptance criteria

- Upload, camera, record, and library selection are all reachable from the composer in two actions
  or fewer.
- Media captured by a device appears in the owner's library with device attribution.
- The user can preview, remove, reorder, and retry attachments before dispatch.
- No signed media URL, raw bytes, or transcript appears unredacted in diagnostics/audit exports.

## Category 3 — Voice transcription, correction, and dispatch

### Outcome

Stopping a recording starts server-side speech processing automatically. The system preserves the
source audio and raw transcript, produces a clean prompt, lets the user review it when appropriate,
and dispatches it reliably to T3.

### Processing model

1. Replace the synchronous provider branch in `transcribeStoredAudio` with a provider interface and
   background job runner. Development can use an in-process worker; production should use a
   durable queue/lease stored with the configured backend so a gateway restart does not lose work.
2. Add transcript versions instead of overwriting one string:
   - `rawTranscript`: exact ASR output.
   - `normalizedTranscript`: punctuation/whitespace and optional correction output.
   - `userEditedTranscript`: the final reviewed value, when present.
   - Provider, model, language, timestamps, processing times, and last error.
3. Processing stages are `queued -> transcribing -> normalizing -> review_required|ready ->
   dispatching -> dispatched`, with retryable and terminal failures distinguished.
4. Parakeet already supplies punctuation and capitalization. Start correction with deterministic
   cleanup only. Add an optional second-pass corrector later for project names, paths, model names,
   and code terms; preserve the raw transcript and show the diff because a “correction” can change
   the user's command.
5. Never convert dictated text directly into `shell_input` without explicit review/confirmation.
   Voice defaults to an agent request, where the agent and existing approval mode provide another
   safety boundary.

### Parakeet adapter

1. Add `TRANSCRIPTION_PROVIDER=parakeet` and a dedicated adapter instead of overloading the OpenAI
   branch. Configure service URL, model, timeout, maximum duration, language, and concurrency.
2. Run `nvidia/parakeet-tdt-0.6b-v2` on the Agent Controller server through a small local ASR
   service using NVIDIA NeMo. It is a compact 600M-parameter English model with punctuation,
   capitalization, word timestamps, and CC-BY-4.0 terms. CPU inference is the default deployment;
   a GPU is an optional throughput accelerator, not a requirement. Keep the ASR runtime in a local
   worker/sidecar so Python model dependencies and inference work do not block the Node gateway's
   HTTP and SSE event loop.
3. Normalize browser formats (WebM/Opus, M4A) to 16 kHz mono PCM in the worker; the current device
   WAV already uses 16 kHz mono.
4. Record queue wait, decode, inference, normalization, and total stop-to-dispatch latency. Enforce
   bounded retries and dead-letter/error state instead of holding HTTP requests for 30 seconds.
5. Make language support explicit. V2 is English; choose a separate configured model for other
   languages rather than silently producing low-quality English output.

### Review and auto-send policy

1. Web/PWA default: stop recording, transcribe automatically, place the normalized transcript in
   the composer, and require Send. Offer an account/device opt-in for `send_when_ready`.
2. Small controller default: show a short transcript preview plus Send, Record again, and Discard.
   If the display cannot show enough text, require a configured auto-send policy or hand off review
   to the phone/PWA.
3. If transcription fails, keep the audio and offer Retry, Edit/type prompt, or Discard. Do not send
   the current fallback sentence as if it were the user's request.

### Direct audio to T3

Current upstream T3 Code's typed `ChatAttachment` union contains image attachments only. Therefore:

1. Set `audioDirect: false` in the T3 capability adapter by default.
2. Transcribe audio and send text; retain the original audio in Agent Controller for playback and
   audit/retention policy.
3. Add direct audio only when a probed T3 version advertises an audio attachment contract and the
   selected provider accepts it. Use the transcript as fallback context, never send an unknown
   attachment shape optimistically.

### Acceptance criteria

- A controller or browser recording automatically enters transcription without a manual Media-page
  action.
- Raw, normalized, and user-edited text are distinguishable and traceable.
- A processor restart resumes or safely retries queued work without duplicate dispatch.
- English voice stop-to-ready meets a measured target (initially p50 under 5 seconds and p95 under
  10 seconds for five-second clips on the reference CPU server), or the UI clearly reports delay.
  Benchmark the actual production CPU before locking the SLO; GPU acceleration may be added later
  only when concurrency or queue latency requires it.
- No audio is sent directly to an unsupported T3 version/provider.

## Category 4 — Controller hardware and wireless voice

### Outcome

The small controller can initiate arbitrary voice requests without pretending that its display is
a keyboard. The supported hardware path is explicit and manufacturable.

### Feasibility decision

The current CrowPanel uses an ESP32-S3. Espressif documents Bluetooth Classic as unsupported on
this chip, and its support table lists ESP-BLE-ISO and ESP-BLE-AUDIO as unavailable. Most existing
wireless-earphone microphone profiles depend on Bluetooth Classic HFP; LE Audio headsets need the
LE Audio/ISO stack. Consequently, direct pairing with ordinary earbuds is not a viable production
feature for this board.

### Near-term implementation paths

1. **Recommended companion path:** make the existing responsive React/PWA composer the voice
   companion. Earbuds pair with the phone or computer, the browser captures their selected
   microphone, and the request travels over Wi-Fi through the same gateway. Add a QR/deep link on
   the controller that opens the correct environment/thread after authentication.
2. **Controller microphone variant — now an off-the-shelf board, not a custom PCB.** The
   Waveshare ESP32-S3-Touch-AMOLED-1.75C ships a dual-microphone array with an ES7210
   echo-cancellation ADC, an ES8311 codec and speaker pads, 8 MB octal PSRAM, a 466x466 round
   capacitive touch AMOLED, an AXP2101 PMIC and a battery header — in an enclosure. It removes the
   carrier-board program described below from the critical path and answers the "too small to type
   on" problem with a touch screen. A scaffold folder exists at
   `firmware/Waveshare-ESP32-S3-Touch-AMOLED-1.75C/`; both PlatformIO environments compile, no board
   has been flashed, and its README carries the evaluation, the unverified pin map, and the port
   plan. Two caveats: it has **no camera**, so device-originated `camera_prompt` intents are not
   possible on it, and an always-on AMOLED cannot match e-ink battery life — it complements the
   CrowPanel status controller rather than replacing it.

   The port's real cost is not the drivers. It is that only `DeviceStore` and `Provisioning` are
   shared today; the gateway client still lives inside the CrowPanel's 3652-line `main.cpp`. A
   second working board requires extracting it into `firmware/shared` first.

   **A second candidate, and currently the better-evidenced one:** the Hosyond/LCDWIKI ES3C28P
   (`firmware/Hosyond-ESP32-S3-2.8-Touchscreen/`) — 2.8" IPS 240x320 capacitive touch, on-board MEMS
   microphone and speaker through a single ES8311 codec, 8 MB PSRAM, battery charging, microSD. Its
   vendor pack ships a schematic, a full pin-allocation table, and a working ES8311 driver, so its
   pin map is verified and its capture path is implemented rather than sketched: hold a key, record
   to PSRAM, measure peak/RMS, play back through the speaker — all offline. It has no echo
   cancellation and one microphone instead of an array, and it is a bare module rather than a cased
   unit, but it is the cheaper way to answer whether on-device voice works at all.

   Neither board has a camera, so device-originated `camera_prompt` intents are impossible on both.
   Whichever wins, the gateway-client extraction above is the shared prerequisite.

   The older plan, retained because it still applies to any board without a microphone: use the
   existing PDM/I2S implementation in
   `firmware/CrowPanel-ESP32-2.13-E-paper/src/media_capture.cpp` and the
   `crowpanel-esp32-213-epaper-capture` PlatformIO environment. Note that neither of its two modes
   fits the AMOLED board — the ES7210 is not PDM and needs an I2C register init before it emits
   anything. The stock CrowPanel has neither mic
   nor camera and only a two-pin expansion header, so define a carrier-board BOM with a supported
   two-wire PDM microphone, validate pin conflicts, enclosure acoustics, PSRAM, and power.
3. **Future wireless-audio hardware:** evaluate a Bluetooth Classic HFP audio coprocessor or a new
   LE Audio-capable MCU/module. Require a proof of headset interoperability, microphone uplink,
   coexistence with Wi-Fi, memory, licensing, battery, and OTA support before placing it on the
   product roadmap.

### Firmware work

1. Promote audio capture from a compile-time demo to a declared hardware capability in heartbeat
   and `/v1/device/controls`.
2. Add first-run microphone diagnostics: permission/capability, input level, clipping, silence,
   memory budget, maximum clip duration, and upload reachability.
3. Use push-to-talk: hold OK, release to stop, then Send/Record again/Discard. Preserve the current
   decision not to refresh e-ink during the recording window.
4. Add request idempotency, upload retry with backoff, and cancellation. Keep clips short; do not add
   continuous audio/video.
5. Surface `transcribing` and the final plain-language agent result through the existing display and
   thread-output endpoints.

### Acceptance criteria

- The product documentation clearly names which controller SKU can capture audio.
- A supported PDM/I2S build records intelligible five-second clips without starving Wi-Fi/e-ink
  memory and reports failures locally.
- A phone using Bluetooth earbuds can open the selected thread and record/send through the PWA.
- The stock ESP32-S3 UI never advertises Bluetooth-headset microphone support it cannot provide.

## Category 5 — T3 integration, recovery, and environment lifecycle

### Outcome

Connecting T3, diagnosing an outage, re-pairing, and removing an obsolete environment are coherent
flows with precise status, guided next actions, and no silent contract mismatch.

### T3 adapter and capability work

1. Create a `T3Adapter` boundary around HTTP snapshot/dispatch and WebSocket catalogue/terminal
   calls. Keep transport details out of `src/app.mjs` and make version-specific wire shapes testable.
2. Expand `/capabilities` from scope-derived booleans to a probed manifest:
   - Installed T3 version and contract version.
   - Shell snapshot, thread-detail read/pagination, thread subscription, dispatch, live catalogue,
     terminal, and launch support separately.
   - Attachment types and limits (`image`, `audio`, file) separately.
   - Runtime and interaction modes.
   - Approval decisions, structured user-input responses, interruption/session stop, proposed plans,
     checkpoints, and task/workflow lifecycle events.
3. Add fixtures and contract tests for the currently certified T3 version and latest supported
   version. Do not mark `attachments: true` merely because orchestration operate scope exists.
4. Prefer the official client/SDK if T3 publishes a stable one; until then, keep the adapter small
   and fail closed when a command cannot be encoded for the probed contract.
5. Reuse `t3Compatibility.mjs` results in Operate/Environments instead of isolating compatibility
   details in Settings.

### First-run connection

Diagnosing and removing environments only matters after one exists, and connecting the first one is
still the least forgiving step in the product: the user must find a terminal on the T3 host, run
`npm run setup:t3`, complete a wizard, copy a token, and paste it into the browser. Nothing in the
console helps until that has already succeeded.

1. Make the console the starting point. `Add environment` should hand the user a single copyable
   one-liner to run on the T3 host, scoped to the access mode they picked, and then wait — polling
   for the pairing to land rather than asking them to come back and paste.
2. Have `setup:t3` complete the handoff itself where it can: exchange the token against the gateway
   directly, so the browser only ever confirms a connection that already exists. Keep manual paste
   as the fallback for hosts that cannot reach the gateway outbound.
3. Offer local discovery for the Local/LAN mode — probe `/.well-known/t3/environment` on the
   obvious candidates and offer what answers, instead of asking for a URL the user must construct.
4. Pre-fill the label and access mode from the probe result. `inferEnvironmentAccessMode`
   (`EnvironmentsPage.tsx:89`) already derives the mode from a URL; extend that into the add flow
   rather than making it a manual choice.
5. Treat re-pairing an existing environment as the same flow, entered from the recovery dialog. It
   must update the environment in place — never create a second row for the same host.
6. Instrument the funnel: how many users start `Add environment`, how many reach a reachable
   snapshot, and where the rest stop. This is the number that decides whether onboarding works.

### Structured health and recovery

1. Introduce an environment failure reason enum:

   ```text
   process_not_running | network_unreachable | timeout | tls_error |
   token_expired | authentication_failed | contract_incompatible | unknown
   ```

2. Make `t3Client.mjs` throw typed errors with HTTP status, network code, endpoint, retryability,
   and sanitized detail. `checkEnvironmentHealth` — which lives in `src/app.mjs:3183-3223`, not in
   `t3Client.mjs` — stores the reason and last successful contact. It already narrows to
   `token_expired` / `reachable` / `unreachable`, so this is widening an existing classification
   and then actually surfacing it, not building one from nothing.
3. Replace `WorkspaceRecovery { message }` with structured recovery data. Preserve the generic
   message only as fallback.
4. Update `WorkspaceRecoveryDialog.tsx`:
   - `process_not_running`: show host-specific T3 start/setup command and auto-retry.
   - `token_expired` or `authentication_failed`: explain how to start T3, obtain a fresh pairing
     token, and open the selected environment's Credential tab.
   - Network/TLS: show the saved URL and access-path checks without exposing credentials.
   - Contract mismatch: show installed/supported versions and the compatibility action.
5. Generate setup instructions from a server endpoint using environment access mode and platform,
   rather than hard-coding one command in the dialog. Keep `npm run setup:t3` as the guided local
   fallback.
6. Continue automatic recovery for retryable outages, with exponential backoff and jitter. Stop
   polling for token/contract failures that require user action; resume after the credential or
   version changes.
7. Preserve the quiet centered empty state from the supplied screenshot, but make its primary
   action `Start/reconnect T3 Code` and its secondary action `Connection settings`.

### Remove old environments

1. **Completed in Milestone 0.5:** rename `Unpair environment` to `Remove environment`; preview
   assigned devices, saved actions, macros, and onboarding dependencies before confirmation.
2. **Completed in Milestone 0.5:** erase the credential/record idempotently, clear device and
   onboarding selections, and disable dependent fixed-target actions/macros with
   `environment_removed` rather than silently retargeting them.
3. Extend the dependency preview with current project/thread, recent command count, last
   reachability, and current UI selection where those are not already represented. Retain immutable
   command/audit context with an environment label/base-URL snapshot for history.
4. Prefer a tombstone (`deletedAt`, credential removed) for the environment row so command history
   remains explainable; hide tombstones from normal lists. Add permanent purge only as a separate,
   explicitly destructive maintenance action.
5. Require the environment label in the confirmation for environments with dependencies and return
   a deletion summary. Make repeated deletion idempotent.
6. Clear selected environment/project/thread and route to the next valid environment or the Connect
   empty state after success.

### Acceptance criteria

- A new user can connect their first environment without leaving the console except to run one
  copied command, and the console detects success without a manual paste on the common path.
- A stopped process, expired token, and unreachable host produce different UI instructions.
- Restarting T3 closes the retryable modal automatically and reloads the same environment/thread
  when it still exists.
- Re-pairing updates the existing environment ID and does not create a duplicate for the same host.
- Removing an environment is discoverable, confirmed with dependency impact, removes credentials,
  and leaves no active device/action/macro targeting a missing host.
- Historical activity remains readable after removal.

## Category 6 — Live T3 conversation, decisions, and multi-agent work

### Outcome

After a user sends a request, Agent Controller becomes a complete remote control surface for that
T3 thread: it shows the agent's response as it streams, tool and command activity, working and
background status, approvals and questions that need an answer, and subagent/parallel-task progress.
The user can follow up, answer, approve, interrupt, or stop without opening T3 Code.

### Gateway thread-detail and streaming architecture

1. Add a long-lived streaming RPC path to `T3Adapter`; do not reuse `callT3Rpc`, whose one-shot
   lifecycle deliberately collects chunks and waits for `Exit`. For each selected thread:
   - Load a bounded recent thread-detail snapshot, including messages, activities, session,
     checkpoints, proposed plans, and its `snapshotSequence`.
   - Subscribe with `orchestration.subscribeThread { threadId, afterSequence,
     requestCompletionMarker: true }`.
   - Apply live events in sequence, deduplicate overlaps, and backfill after reconnect. Page older
     turns only when the user asks for them.
2. Relay normalized thread events to the signed-in browser through the existing gateway SSE
   connection or a dedicated authenticated per-thread stream. Scope every subscription by user,
   environment, and thread; unsubscribe when the selection changes or the last viewer leaves.
3. Introduce a versioned Agent Controller view contract rather than exposing raw T3 wire objects:

   ```ts
   interface ThreadDetailView {
     environmentId: string;
     threadId: string;
     sequence: number;
     messages: ThreadMessageView[];
     activities: ThreadActivityView[];
     pendingInteractions: PendingInteractionView[];
     session: ThreadSessionView | null;
     work: WorkNodeView[];
     backgroundLiveness: "working" | "monitoring" | null;
     planProgress: { step: string; completed: number; total: number } | null;
   }
   ```

4. Keep T3 authoritative for transcript and provider activity. Cache only resumable sequence,
   minimal last-known state, unread markers, and Agent Controller's own response audit. On refresh,
   reload detail from T3 rather than reconstructing a transcript from gateway `Command` records.
5. Coalesce high-frequency assistant deltas and task progress before sending/rendering them. Preserve
   message/activity IDs and task linkage so parallel streams never splice into the wrong output.
6. Define explicit stream states: `connecting`, `synchronized`, `live`, `reconnecting`, `stale`, and
   `unavailable`. A stale cached response must remain readable but visibly stale; it must never show
   a false `live` or `finished` state.

### Conversation and workbench UI

1. Replace the command-card fallback as the primary thread feed. Render, in order:
   - User and assistant messages, including streaming text and safe Markdown/code blocks.
   - Tool/command activity with source, status, concise summary, elapsed time, and expandable detail.
   - Plan/progress updates, errors, diffs, checkpoints, and final completion state.
   - The gateway dispatch record only as a compact delivery receipt linked to its T3 turn.
2. Preserve the docked composer throughout a turn. Allow a normal follow-up when T3 allows it; show
   clear queued/steering semantics when the thread is already busy. Add `Interrupt turn` and `Stop
   session` as distinct actions, gated by current session state and capability.
3. Put the most recent pending approval or user-input request directly above the composer and also
   inline beside the activity that caused it. Do not replace the canvas with a large blocking modal.
4. Auto-follow new output only while the user is already near the bottom. Otherwise preserve their
   reading position and show a `New activity` control. Keep focus stable while deltas arrive and
   announce important state changes through an accessible live region.
5. Add source-aware sidebar badges and optional notifications for `approval required`, `answer
   required`, `failed`, `completed`, and `background work still running`. Clear unread state only
   when the matching activity is viewed or resolved.

### Approvals and structured user input

1. Normalize both approval realms into `PendingInteractionView`, but retain a source discriminator
   (`agent-controller-policy` or `t3-provider`), the source request ID, environment/thread/turn IDs,
   risk/detail, available decisions, creation time, and resolution.
2. Route decisions by source:
   - Agent Controller policy: keep `/v1/commands/:id/approve|reject`.
   - T3 provider: dispatch `thread.approval.respond` using the T3 `requestId` and advertised
     decision set. Support `acceptForSession` only when the current provider exposes it; label its
     scope precisely and never silently translate it to a permanent grant.
3. Add `user_input_response` to intent normalization, profile capabilities, policy evaluation, and
   `buildT3Command`, mapping it to `thread.user-input.respond { requestId, answers }`.
4. Render T3's structured questions as accessible controls (single choice, multiple choice, text,
   and validation when present). Preserve partially entered answers through reconnects and submit
   them atomically with an idempotent command ID.
5. Show a resolving state immediately, but mark the interaction resolved only after T3 accepts the
   command and the stream confirms it. Disable repeated decisions while pending and show a retryable
   error without discarding the original question or approval detail.

### Subagents, workflows, and parallel tasks

1. Fold structured `task.started`, `task.progress`, `task.updated`, `task.completed`, and workflow
   activities into a stable work graph; do not infer agents from message wording or tool labels when
   structured linkage exists:

   ```ts
   interface WorkNodeView {
     id: string;
     parentId: string | null;
     kind: "workflow" | "subagent" | "parallel-task" | "tool";
     label: string;
     status: "queued" | "working" | "waiting" | "completed" | "failed" | "stopped";
     progress?: { summary?: string; completed?: number; total?: number };
     outputRef?: string;
     startedAt?: string;
     completedAt?: string;
     capabilities: { inspect: boolean; provideInput: boolean; stop: boolean; resume: boolean };
   }
   ```

2. Keep the thread feed primary. Collapse a fan-out into one inline row such as `Started 4 parallel
   tasks · 2 complete · 2 working`; selecting it opens an `Agents & work` inspector. Use a right-side
   drawer on desktop and a sheet/tab on smaller screens.
3. In the inspector, show the parent/child tree, role/model when T3 provides them, live status,
   elapsed time, current step/tool, output summary, failures, and token/tool counts. Selecting a node
   filters/highlights its activities without mixing child narration into the parent answer.
4. Derive the thread's visible `Working` state from both the parent session and T3
   `backgroundLiveness`; a settled foreground turn with active children must not look finished.
5. Capability-gate every control. If T3 exposes only thread/session-level stop, label it `Stop all
   background work` and do not draw fake per-agent Stop buttons. Add per-node stop, resume, or input
   only after a certified contract exposes a stable target ID and response command.
6. Keep the composer targeted at the parent T3 thread unless the contract exposes a real child-task
   input command. If direct subagent messaging is unavailable, say so in the inspector and offer a
   parent-thread follow-up such as `Ask the research agent to...`; do not imply it is a private
   message to that child.
7. For the small hardware controller, show aggregate status and the first actionable interaction:
   task count, working/completed/failed, approval/answer needed, and final result. Keep the full graph
   on the web/PWA rather than forcing a dense tree onto e-ink.

### Acceptance criteria

- Within one second of T3 accepting a turn event, an online Agent Controller viewer sees its
  working state or first streamed output under normal LAN conditions.
- A refresh or WebSocket reconnect resumes from sequence without missing or duplicating messages,
  task activities, or decisions.
- The user can read the final T3 answer, send a follow-up, interrupt a running turn, and stop a
  session without opening T3 Code.
- Both Agent Controller policy approvals and T3 provider approvals are visible, correctly labeled,
  and resolved through the correct backend path.
- Every structured T3 user-input request can be answered from Agent Controller.
- Parallel/subagent work remains visibly active after the parent turn settles, and each structured
  task's status/output is attributable to the correct node.
- Unsupported per-agent controls are absent—not disabled-looking promises—and the UI explains the
  available thread-level control.

## Category 7 — Security, observability, testing, and rollout

### Security and privacy

1. Treat audio, transcripts, correction output, images, and descriptions as user content. Apply the
   current retention/redaction rules to every new field and processing job.
2. Do not log raw prompts, transcripts, signed URLs, tokens, or inline attachment bytes.
3. Enforce TLS for remote device uploads, per-actor rate limits, media quotas, MIME sniffing, and
   short-lived URLs. Keep policy evaluation immediately before dispatch so a delayed voice request
   cannot bypass a newer policy.
4. Make auto-send opt-in per user/device and record who enabled it. Provide an obvious way to stop
   or cancel a processing request.
5. Authorize every T3 detail subscription and interaction against the selected environment/thread.
   Redact command payloads and file paths according to the existing policy before relaying them to a
   browser or small controller.
6. Audit who approved, declined, answered, interrupted, or stopped work, recording the source realm
   and request/turn/task IDs without storing credentials or duplicating sensitive transcript text.

### Observability and service targets

Add metrics for upload success/bytes, queue depth/age, transcription latency by stage/provider,
correction latency, review time, stop-to-dispatch time, T3 dispatch result, duplicate prevention,
recovery reason, time-to-recover, and environment removal dependencies. Extend beta readiness from
`mediaCapturedAt -> dispatch` to stage-level measurements so a slow ASR queue is diagnosable.

For live threads, add dispatch-to-first-T3-event, dispatch-to-first-token, event relay lag, reconnect
and backfill counts, sequence-gap failures, pending-interaction age, decision latency/error, active
background-work age, task-event coalescing ratio, and incorrect/stale liveness incidents.

Initial targets:

- Text request acknowledgement p50 under 500 ms and p95 under 2 seconds, excluding T3 work.
- Five-second voice clip stop-to-ready p50 under 5 seconds and p95 under 10 seconds on the reference
  CPU-hosted Parakeet service, with the final target calibrated from production-server benchmarks.
- No duplicate T3 turn for the same `clientRequestId`.
- No unauthenticated media read or request dispatch.
- Recovery reason classification on at least 95% of failed T3 health checks.
- Live thread relay p95 under one second on the reference LAN, excluding T3/provider generation.
- Zero known cross-thread message, decision, or task-attribution errors.

### Test plan

1. **Frontend/Vitest:** composer text, drag/paste/upload, multiple attachment chips, inline record,
   transcript review/auto-send, retry/cancel, recovery reason variants, Remove confirmation with
   each dependency type present, the `QuickPage` compact composer, and the first-run connection
   states (waiting for host, discovered candidate, paired, manual-paste fallback). Add live message
   deltas, pinned scroll position, new-activity affordance, both approval realms, structured user
   input, background liveness, and work-graph/inspector states.
2. **Server/node:test:** request state machine, idempotency, media ownership/type/limits, Parakeet
   success/timeout/retry, correction versioning, policy-at-dispatch, T3 capability gating, typed
   health errors, deletion dependency cleanup, thread subscription lifecycle, event deduplication,
   sequence-gap recovery, user-input response encoding, and source-correct approval routing.
3. **Store parity:** every new request/media/environment method against memory, file, and Convex.
4. **T3 contract fixtures:** certified image attachment, rejected audio on image-only T3, future
   audio capability fixture, first-turn attachments, thread-detail snapshot/pagination, live message
   and activity events, approval decisions, structured questions, task/workflow lifecycle,
   background liveness, and version skew.
5. **Firmware/bench:** default CrowPanel build, capture build, five-second audio memory budget,
   silence/clipping, Wi-Fi loss during upload, retry idempotency, and e-ink milestone screens.
6. **End-to-end:** browser text, browser voice review, device/PDM auto-send, phone with Bluetooth
   earbuds, stopped-T3 recovery, token re-pair, environment removal with dependencies, streamed T3
   response and follow-up, provider approval, structured answer, interrupt/stop, reconnect during a
   turn, and parallel subagents whose parent turn has already settled.

## Recommended delivery sequence

### Milestone 0.5 — Complete (shipped 2026-08-24)

Everything here shipped independently of the request envelope and ASR pipeline.

- **Done — Remove environment.** The UI uses Remove, previews dependencies, hard-deletes
  idempotently, repairs device/onboarding references, and disables dependent fixed-target actions
  and macros.
- **Done — reason-specific recovery modal.** Eight typed reasons carry retryability and targeted
  instructions/actions to the frontend.
- **Done — first-turn attachments.** Project launch resolves and sends the same validated ordered
  attachments as follow-up turns.
- **Done — multiple attachments end to end.** The intent contract accepts an ordered list with an
  eight-item limit and preserves the scalar field as a protocol-v1 alias; Operate can add, remove,
  and reorder stored media.

The completed repair has dedicated frontend, server, and store coverage in the current test gate.

### Milestone 0 — Contracts and diagnostics (1–2 weeks)

- Request envelope/state model and idempotency.
- Typed T3 errors and expanded capability manifest.
- Versioned thread-detail/event, pending-interaction, and work-node view contracts.
- Persistent T3 thread subscription client with sequence resume, deduplication, and test fixtures.
- Storage schema/methods in memory, file, and Convex.
- Test fixtures for current T3 attachments and health failures.

This milestone is the dependency for every reliable voice flow, and for the durable job handling
that Milestone 3 needs. It is *not* a dependency of Milestone 0.5.

**Open design question, to settle before building it:** the plan adds `POST /v1/requests` beside
`POST /v1/intents` and keeps intents "for backward compatibility" without ever deprecating it. That
leaves two permanent write paths into the same policy engine, and policy-at-dispatch has to be
correct on both. Extending `/v1/intents` with the asynchronous request states would buy the same
idempotency and staged processing without the fork. Pick one deliberately: either commit to a dated
deprecation of `/v1/intents`, or extend it in place.

### Milestone 1 — Live conversation and interaction parity (2–4 weeks)

- Selected-thread detail loading and live relay to the browser.
- Streamed user/assistant messages, tool/activity timeline, safe reconnect/backfill, and visible
  working/final states.
- T3 provider approvals, full advertised decision semantics, structured user-input responses,
  follow-up, interrupt, and session stop.
- Inline parallel-work summary, `Agents & work` inspector, background-liveness status, and
  capability-gated controls.
- Sidebar badges/notifications and a compact controller status/result projection.

This closes the critical post-dispatch gap shown in the screenshots: the user can see and control
what T3 is doing instead of leaving Agent Controller to finish the task in T3 Code.

### Milestone 2 — Composer and connection (2–3 weeks)

**State: partial.** Free-form Operate text, ordered stored-media chips, first-turn attachments, and
in-place environment updates exist. The deliverables below remain.

- Unified free-form composer with reusable picker and multiple attachment chips.
- A composer on `QuickPage` so the phone-sized surface can send a request at all.
- First-run connection flow: copyable host command, gateway-side handoff, LAN discovery, polling
  instead of manual paste.
- Re-pairing in place from the recovery dialog.

This delivers the largest usability improvement without waiting for new hardware.

### Milestone 3 — Automatic Parakeet voice pipeline (3–5 weeks)

**State: todo.** Manual synchronous transcription is baseline infrastructure, not this milestone.

- Raw upload/finalize path and durable processing jobs.
- CPU-hosted local Parakeet service/adapter, format conversion, transcript versions, and retry. A
  GPU is not required; optional acceleration is a later capacity choice.
- Inline recording, transcript review, opt-in auto-send, SSE progress, and metrics.
- Direct-audio capability kept disabled on current T3.

### Milestone 4 — Controller voice paths (2–4 weeks plus hardware lead time)

**State: partial.** Hosyond capture, microphone proof, display, and orb UI are working on silicon;
gateway upload/dispatch, request status, touch controls, and the PWA companion remain.

- PWA deep link/QR companion path for phone and Bluetooth earbuds.
- Supported PDM/I2S carrier-board prototype and firmware capability reporting.
- Device review/re-record/discard flow and request-status polling.

Do not block the software voice release on a new controller PCB.

### Milestone 5 — T3 adapter hardening and rollout (1–2 weeks, then ongoing)

**State: todo.** Existing compatibility and transport helpers have not yet been consolidated into
the roadmap adapter or rollout gates.

- Versioned adapter consolidation and compatibility UI integration.
- Load, failure-injection, security, retention, and end-to-end validation.
- Feature flags: `unifiedComposer`, `voiceProcessing`, `voiceAutoSend`, and
  `t3LiveThread`, `t3WorkInspector`, and `t3DirectAudio` (the last remains off until a verified
  T3/provider pair supports it).
- Staged rollout to internal devices, browser beta, one controller SKU, then general availability.

## Definition of done

The initiative is complete when a new user can connect their first T3 environment from the console
with one copied command, then — on a laptop or a phone — choose an environment/thread, type or speak
any normal-language request, add or reuse media in the composer, review processing when desired, and
see one traceable request reach T3. From the same Agent Controller thread, they can watch the live
response and tool activity, answer T3 questions, resolve the correct approval, inspect parallel
subagents, understand when background work is still active, send a follow-up, and interrupt or stop
work without opening T3 Code. A small controller can initiate the same flow through a supported
microphone or phone companion and show actionable aggregate status plus the final result. T3 outages
lead to precise repair instructions, and obsolete environments can be removed without dangling live
dependencies or losing historical explainability.

Saved actions still exist throughout, and nowhere in the product do they look like the only thing a
user is allowed to ask for.

## External constraints verified for this roadmap

- NVIDIA Parakeet TDT 0.6B V2 model card:
  <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2>
- Current T3 Code orchestration attachment contract (image-only `ChatAttachment` union):
  <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts>
- T3 Code RPC and event-sourced orchestration architecture, including `orchestration.subscribeThread`:
  <https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md>
- T3 Code provider task/workflow runtime contract:
  <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts>
- ESP32-S3 Bluetooth/LE Audio support table:
  <https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html>
