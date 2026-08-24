# Agent Controller API

This is the initial platform API for device management and T3 Code orchestration.

For the ESP32 firmware-facing flow, see [hardware-protocol.md](hardware-protocol.md).

## Gateway Profiles

Owners manage reusable device origins with `GET/POST /v1/gateway-profiles` and
`GET/PUT/DELETE /v1/gateway-profiles/:id`. A profile is
`{id,label,mode:"lan"|"tailnet"|"custom",url}`. URLs are origins only: Tailnet profiles require
HTTPS `.ts.net`, custom profiles require HTTPS, and plaintext LAN profiles require a private,
link-local, localhost, or `.local` host.

`PUT /v1/devices/:id/gateway` with `{profileId}` stages a revisioned switch. The controller reads
`GET /v1/device/gateway`, probes the candidate with its existing device credential, and reports
`POST /v1/device/gateway/switch` with `{revision,profileId,status:"requested"|"applied"|"failed",detail?}`.
Only an exact revision and owned profile can be promoted. Failure retains the active profile;
`POST /v1/devices/:id/gateway/rollback` cancels a pending switch.

Authenticated owners can enable or disable private Tailnet-only Serve with
`POST /v1/settings/remote-access/serve` and `{enabled:boolean}`. Enabling first disables Funnel on
the same port and verifies Tailscale reports `tailnet only`.

Factory operators can upload an immutable binary with
`POST /v1/factory/firmware/releases/upload?version=...&channel=stable&hardwareModel=...` using
`application/octet-stream`. The gateway computes SHA-256 and size, stores the artifact on disk or
private S3/R2, and emits an authenticated device-download URL. Bucket credentials and object keys
are not exposed.

Managed artifact URLs in a device firmware manifest carry short-lived `expires` and `token`
parameters. The HMAC capability is scoped to the artifact SHA-256 and hardware model, allowing
legacy firmware that cannot attach device headers to complete one OTA hop. New firmware should
continue sending device headers. Capabilities are rejected after expiry and cannot be reused for a
different artifact or hardware model.

## Device Profiles

Discover supported device profiles:

```http
GET /v1/device-profiles
```

Profiles define the capabilities the policy engine will allow for a device:

- `agent-controller`: prompts, media prompts, status, approvals, session control, and policy-screened shell input.
- `read-only`: status only.
- `power-controller`: high-trust control profile for signed-in web clients and advanced devices; dangerous shell input still requires approval.

## Platform User Auth

The React application authenticates through Clerk. API clients send a current Clerk session token:

```text
authorization: Bearer CLERK_SESSION_TOKEN
```

Same-origin event streams may authenticate with the Clerk session cookie instead of placing a token in the URL. The gateway synchronizes the verified Clerk user ID, name, and primary email before serving user-owned data.

The legacy development-token route is enabled only when `AUTH_PROVIDER=dev` or `DEMO_MODE=1`. It is disabled in Clerk mode and is not part of the React UI.

Read public browser auth settings:

```bash
curl http://127.0.0.1:8877/v1/auth/config
```

This endpoint exposes the auth provider and Clerk publishable key only. It never returns `CLERK_SECRET_KEY`.

## Initial Onboarding

Authenticated React users are guided through T3 host configuration, environment pairing,
workspace/model selection, a first thread, and a controller or browser-only choice.

Read durable progress and server-derived readiness:

```http
GET /v1/onboarding
authorization: Bearer CLERK_SESSION_TOKEN
```

Persist a partial step update:

```http
PUT /v1/onboarding
authorization: Bearer CLERK_SESSION_TOKEN
content-type: application/json

{
  "status": "in_progress",
  "currentStep": "connect",
  "networkMode": "tailscale",
  "networkUrl": "https://machine.tailnet.ts.net",
  "provider": {
    "harness": "openai",
    "instanceId": "codex",
    "model": "gpt-5.4"
  },
  "workspace": {
    "path": "/work/agent-controller",
    "title": "Agent Controller"
  }
}
```

Nested provider, workspace, and device values merge with prior progress. Completion returns
HTTP 409 until the server can prove every requirement: reachable owned environment, selected
project/provider/model, a matching accepted `thread.launch` command for those exact selections, and either browser-only
operation or a non-revoked controller configured to that environment and thread. Registered
development controllers also require `device.credentialConfirmed: true`.

See [onboarding-flow.md](onboarding-flow.md) for the activation definition and recovery behavior.

## Rate Limits

The gateway applies fixed-window limits after authentication:

- Auth/dev token creation: keyed by client IP.
- Factory routes: keyed by client IP.
- User reads/writes: keyed by platform user ID.
- Device heartbeat/read/write routes: keyed by device ID.

Defaults:

```text
RATE_LIMIT_WINDOW_MS=60000
AUTH_RATE_LIMIT=30
FACTORY_WRITE_RATE_LIMIT=30
USER_READ_RATE_LIMIT=240
USER_WRITE_RATE_LIMIT=60
DEVICE_HEARTBEAT_RATE_LIMIT=120
DEVICE_READ_RATE_LIMIT=120
DEVICE_WRITE_RATE_LIMIT=30
```

When a limit is exceeded, the API returns:

```http
HTTP/1.1 429 Too Many Requests
x-ratelimit-limit: 30
x-ratelimit-remaining: 0
x-ratelimit-reset: 2026-06-14T21:00:00.000Z
retry-after: 42
```

```json
{
  "error": {
    "message": "Rate limit exceeded.",
    "details": {
      "scope": "device:write",
      "limit": 30,
      "remaining": 0,
      "resetAt": "2026-06-14T21:00:00.000Z"
    }
  }
}
```

## Device Registration

Development shortcut:

```http
POST /v1/devices
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Desk controller",
  "profile": "agent-controller"
}
```

Response includes a one-time device secret:

```json
{
  "device": {
    "id": "dev_...",
    "userId": "user_dev",
    "label": "Desk controller",
    "profile": "agent-controller"
  },
  "secret": "..."
}
```

Commercial factory flow:

```http
POST /v1/factory/devices
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "label": "Controller batch A",
  "profile": "agent-controller"
}
```

Response:

```json
{
  "device": {
    "id": "dev_...",
    "userId": null,
    "claimed": false
  },
  "secret": "FLASH_THIS_TO_DEVICE",
  "claimCode": "ABCDE-23456"
}
```

If `DEMO_MODE=1` and no `FACTORY_TOKEN` is configured, the factory endpoint is open for local development only.

Batch-create factory devices and flash artifacts:

```http
POST /v1/factory/batches
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "count": 10,
  "labelPrefix": "Agent Controller",
  "profile": "agent-controller",
  "gatewayBaseUrl": "https://gateway.example.com",
  "hardwareModel": "e213-esp32-s3r8",
  "firmwareVersion": "0.1.0",
  "enableOtaApply": false,
  "requireOtaSignature": false,
  "otaManifestVerifyKey": ""
}
```

There are no `wifiSsid`/`wifiPassword` fields: the factory cannot know the customer's network, so
Wi-Fi is entered by the owner through the on-device SoftAP portal.

The response includes, per device, a one-time `secret`, the customer `claimCode`, an `nvsSeed` CSV,
and generated `controller_config.h` content. Save those artifacts immediately; secrets are not
recoverable later.

`nvsSeed` is the production artefact — feed it to `nvs_partition_gen.py` and write the resulting
image at the NVS partition offset, so a line flashes one signed application image per batch and
varies only a small data partition:

```bash
python nvs_partition_gen.py generate dev_x.nvs.csv dev_x.nvs.bin 0x5000
esptool.py write_flash 0x9000 dev_x.nvs.bin
```

It carries `dev_id`, `dev_secret`, `gw_url`, `claim_code`, and `claim_exp`. The claim code is
included deliberately: the gateway will not reissue a still-live code's plaintext, so a unit that
did not leave the line holding its own code could never display one — the screen would read "no
code" while the printed label carried the real thing.
`enableOtaApply` controls whether generated firmware configs only report available updates or automatically download and apply them. The current signature prototype uses HMAC; do not ship one shared HMAC key broadly in production hardware.

Claim a pre-provisioned device:

```http
POST /v1/devices/claim
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "claimCode": "ABCDE-23456",
  "label": "Desk controller"
}
```

Rotate a claimed device secret:

```http
POST /v1/devices/dev_.../rotate-secret
authorization: Bearer PLATFORM_TOKEN
```

Reset a claimed device for resale, support replacement, or account transfer:

```http
POST /v1/devices/dev_.../transfer-reset
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Refurbished desk controller"
}
```

The response includes a new one-time `secret` and customer `claimCode`. The device is unclaimed, removed from the previous owner's inventory, its runtime config/status are reset, and the previous hardware secret stops working immediately. Save the new secret and claim code immediately; they are not recoverable later.

Revoke a claimed device:

```http
POST /v1/devices/dev_.../revoke
authorization: Bearer PLATFORM_TOKEN
```

Permanently remove a revoked device from the inventory:

```http
DELETE /v1/devices/dev_...
authorization: Bearer PLATFORM_TOKEN
```

Only a revoked device can be deleted; an active one returns `409`. Revocation kills the credential
first, so the record can go without leaving hardware in the field that still authenticates against a
device the owner can no longer see. Commands and audit entries reference the device by id and are
kept — deleting the controller does not erase the record of what it did.

Every device payload carries an `actions` block saying which of these the gateway will currently
accept, so clients do not have to re-derive it from `revokedAt`:

```json
{
  "actions": {
    "rotateSecret": false,
    "transferReset": false,
    "updateConfig": false,
    "updateProfile": false,
    "revoke": false,
    "delete": true
  }
}
```

An older gateway omits the block; treat a missing field as permitted and let the request fail.

Update a claimed device's policy profile:

```http
PUT /v1/devices/dev_.../profile
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "profile": "read-only"
}
```

Unknown profiles are rejected. Profile changes affect the next device or web intent immediately.

Configure a claimed device's runtime defaults:

```http
PUT /v1/devices/dev_.../config
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "defaultPrompt": "Continue the current task, inspect progress, and run relevant tests.",
  "shellCommand": "npm test",
  "menu": ["status", "prompt", "shell", "macro", "media", "stop"]
}
```

Read a device config from the platform:

```http
GET /v1/devices/dev_.../config
authorization: Bearer PLATFORM_TOKEN
```

## Device Authentication

Device endpoints require:

```text
x-device-id: dev_...
x-device-secret: ...
```

Unclaimed devices can heartbeat and request a setup code, but cannot access display, media, events, or T3 control endpoints until claimed.

Fetch the setup code for an authenticated unclaimed device. The code is **stable**: while the
existing one is unexpired this returns `200` with `setup.rotated: false` and `setup.claimCode: null`,
so a device polling after its first `403` cannot invalidate the code printed at manufacture. Pass
`{"rotate": true}` to deliberately replace it, which answers `201` with the new plaintext.

```http
POST /v1/device/setup-code
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{ "rotate": false }
```

Response:

```json
{
  "device": {
    "id": "dev_...",
    "claimed": false
  },
  "setup": {
    "claimed": false,
    "rotated": true,
    "claimCode": "ABCDE-23456",
    "claimCodeExpiresAt": "2026-09-06T09:48:18.923Z",
    "instructions": "Sign in to the Agent Controller dashboard and claim this device with the displayed code."
  },
  "claimCode": "ABCDE-23456",
  "claimCodeExpiresAt": "2026-09-06T09:48:18.923Z"
}
```

This route is intended for the physical controller's setup screen. Codes expire 30 days from issue,
and an expired code is refused at claim time (`404`) rather than treated as unknown. Only a rotation
retires a previously printed or displayed code.

`POST /v1/devices/claim` answers `404` with "Claim code is invalid, expired, or already used." for
all three cases; the `/claim?device=…&code=…` deep link surfaces that as an explicit dead end with a
route to manual entry.

Heartbeat can include lightweight diagnostics. The gateway stores the latest values on the device record and exposes them in `/v1/devices` and `/v1/device/display`:

```http
POST /v1/device/heartbeat
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{
  "firmwareVersion": "0.1.7",
  "hardwareModel": "e213-esp32-s3r8",
  "ipAddress": "192.168.4.20",
  "wifiRssi": -61,
  "freeHeap": 184320,
  "uptimeMs": 120000,
  "batteryMv": 4100,
  "batteryPercent": 87
}
```

Device responses include computed presence metadata. A device is `online` when its latest activity, either `lastSeenAt` or `status.lastHeartbeatAt`, is within 90 seconds:

```json
{
  "presence": {
    "state": "online",
    "online": true,
    "lastSeenAt": "2026-06-16T19:00:00.000Z",
    "lastHeartbeatAt": "2026-06-16T19:00:00.000Z",
    "latestActivityAt": "2026-06-16T19:00:00.000Z",
    "ageMs": 250,
    "staleAfterMs": 90000
  }
}
```

## Device Media Upload

Devices can upload short audio clips or still images before sending a prompt.

```http
POST /v1/device/media
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{
  "kind": "audio",
  "contentType": "audio/webm",
  "dataBase64": "BASE64_BYTES",
  "originalName": "prompt.webm",
  "transcript": "Optional transcript from phone, browser, device, or a transcription worker."
}
```

Supported content types:

```text
audio/wav
audio/mpeg
audio/mp4
audio/webm
audio/ogg
image/jpeg
image/png
image/webp
```

The response returns a `media.id`. Audio uploads may include `transcript`; image uploads ignore it. Media metadata includes `processing.transcriptionStatus`:

```text
pending
processing
ready
failed
unavailable
not_applicable
```

### Media names

Owner-facing media reads (`GET /v1/media`, and the single record returned by `POST /v1/media`,
`PUT /v1/media/:id/transcript`, `POST /v1/media/:id/transcribe`, `DELETE /v1/media/:id`) carry a
derived `displayName` and a structured `origin` alongside the `originalName` the client uploaded:

```json
{
  "id": "media_...",
  "originalName": "controller.wav",
  "displayName": "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32",
  "origin": {
    "source": "device",
    "deviceId": "dev_...",
    "deviceLabel": "Hosyond Touch screen",
    "environmentId": "env_...",
    "threadId": "thread_voice",
    "threadTitle": "Verify Workspace",
    "capturedAt": "2026-08-24T19:32:05.104Z"
  }
}
```

Both fields are computed on read and never stored, so a renamed device or a retitled thread is
reflected immediately and clips uploaded before this existed are named too. `originalName` is never
overwritten, and it remains the filename the agent sees on an attachment. Segments are dropped when
unknown: a console upload has no device (`Console · diagram.png · 24 Aug 19:32`), a device with
no bound thread has no destination, and a thread whose title T3 cannot supply is named by a short
form of its id (`Thread 4f2a1c`). See `src/mediaNaming.mjs`.

The signed-in owner can update an audio transcript later:

```http
PUT /v1/media/media_.../transcript
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "transcript": "Updated transcript text."
}
```

### Transcription jobs

Transcription is a durable background job, not something the request waits on. Enqueue one:

```http
POST /v1/media/media_.../transcribe
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{}
```

Answers `202` with `{ "job": {...}, "media": {...} }`. The job is picked up by the gateway's media
job worker, which survives a restart: an in-flight job is held by a lease and, once that lease
lapses, any worker may resume it from the evidence already stored. Enqueueing twice while a job is
unfinished returns the same job rather than starting a second one.

If no provider is configured the route still refuses synchronously with `409` and marks the media
`unavailable` — queueing work that would fail identically on every attempt only hides the error.

Stages:

```text
queued -> transcribing -> normalizing -> review_required | ready -> dispatching -> dispatched
                                                                                   failed
```

`dispatched` means the finished transcript has been written onto the media record, which is what an
`audio_prompt` reads. `dispatched` and `failed` are terminal and are never re-claimed.

The job keeps transcript **versions**, not one overwritten string:

| Field | Meaning |
|---|---|
| `rawTranscript` | Exactly what the ASR provider returned, whitespace included. Immutable once written. |
| `normalizedTranscript` | Punctuation and spacing cleanup. Immutable once written. |
| `userEditedTranscript` | The reviewed value, when a person corrected it. Writable. |

Plus `provider`, `model`, `language`, `attempts` / `maxAttempts`, `lastError`, `failureKind`
(`retryable` or `terminal`), a `timings` map, and the lease fields. The last version present wins:
user-edited, else normalized, else raw.

A retryable failure (timeout, 429, 5xx, unreadable bytes) returns the job to `queued` and costs one
attempt; a terminal one (no provider, missing key, 4xx, empty result) fails immediately rather than
spending the budget on an answer that will not change.

Read jobs:

```http
GET /v1/media/jobs?mediaId=media_...&stage=queued
GET /v1/media/jobs/mjob_...
authorization: Bearer PLATFORM_TOKEN
```

With `TRANSCRIPTION_REVIEW_REQUIRED=1` a finished transcript parks at `review_required` instead of
being applied. Accepting or correcting it records the reviewed version and re-arms dispatch:

```http
POST /v1/media/jobs/mjob_.../transcript
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "transcript": "Deploy the staging branch."
}
```

Refused with `409` unless the job is at `review_required`, `ready` or `dispatched`.

Stage changes are pushed on `/v1/events` as `media.job`, carrying the `milestone` below alongside
the stage so a console and a controller never disagree about where a capture got to. Worker settings:
`TRANSCRIPTION_WORKER_ENABLED`, `TRANSCRIPTION_WORKER_INTERVAL_MS`, `TRANSCRIPTION_BATCH_SIZE`,
`TRANSCRIPTION_LEASE_MS`, `TRANSCRIPTION_MAX_ATTEMPTS`, `TRANSCRIPTION_LANGUAGE`.

Reading a job also returns a computed `transcriptChange`:

```json
{
  "changed": true,
  "contentPreserved": true,
  "rawLength": 56,
  "normalizedLength": 52,
  "firstDivergenceIndex": null
}
```

Cleanup may move spacing, punctuation and case and nothing else. `contentPreserved` compares the
letters and digits of the two versions with everything else stripped out; when it is `false`
something rewrote what the speaker said, so the job parks at `review_required` whatever
`TRANSCRIPTION_REVIEW_REQUIRED` says and the change is shown as a diff rather than dispatched as a
command. `rawTranscript` is kept verbatim either way.

### The parakeet sidecar

`TRANSCRIPTION_PROVIDER=parakeet` talks to a small local ASR service running
`nvidia/parakeet-tdt-0.6b-v2`. The gateway never imports Python and never blocks its event loop on
inference: it POSTs the clip over HTTP and waits on a socket, exactly as it does for a hosted API.
CPU inference is the supported default and a GPU is only an accelerator, which is why the timeout
defaults to minutes and concurrency to one.

| Variable | Default | Meaning |
|---|---|---|
| `PARAKEET_URL` | `http://127.0.0.1:8977/v1/transcribe` | The sidecar endpoint. |
| `PARAKEET_MODEL` | `nvidia/parakeet-tdt-0.6b-v2` | Checkpoint the sidecar should load. |
| `PARAKEET_API_KEY` | unset | Only needed when the sidecar sits behind an authenticated hop. |
| `PARAKEET_TIMEOUT_MS` | `120000` | A long clip on CPU takes far more than a hosted API would. |
| `PARAKEET_MAX_CLIP_SECONDS` | `120` | Clip ceiling; inference cost scales with audio length. |
| `PARAKEET_LANGUAGE` | `PARAKEET_LANGUAGE` → `TRANSCRIPTION_LANGUAGE` → `en` | Declared on every request, never detected. |
| `PARAKEET_CONCURRENCY` | `1` | How many clips may be inside the sidecar at once. |
| `PARAKEET_ACCEPTED_CONTENT_TYPES` | `audio/wav,audio/webm,audio/ogg,audio/mp4` | Containers the sidecar's decoder can open. |
| `PARAKEET_MODEL_DIR` | `.data/models/parakeet-tdt-0.6b-v2-onnx` | Read by the fetch script and the sidecar, not by the gateway. |
| `PARAKEET_MODEL_PRECISION` | `int8` | `int8` (~630 MB) or `fp32` (~2.5 GB). Sidecar-side only. |

**Running it.** The sidecar ships in this repo as `scripts/parakeet-sidecar.py`, and the weights are
fetched by `scripts/fetch-parakeet-model.mjs`:

```bash
uv venv --python 3.12 .venv-parakeet
uv pip install --python .venv-parakeet/bin/python onnx-asr onnxruntime
npm run parakeet:fetch          # ~630 MB into PARAKEET_MODEL_DIR, digest-verified, resumable
npm run parakeet:sidecar        # loads the model, then listens on 127.0.0.1:8977
```

Then set `TRANSCRIPTION_PROVIDER=parakeet` and restart the gateway. `GET /healthz` on the sidecar
reports the loaded checkpoint, precision and model directory; `npm run parakeet:fetch -- --check`
re-verifies the weights on disk without downloading anything.

The runtime is **onnxruntime via onnx-asr, not nemo_toolkit**. NVIDIA publishes the checkpoint as a
2.4 GB `.nemo` archive only NeMo can open, and NeMo pulls in PyTorch, Lightning and Hydra to run
600M parameters of CPU inference; `istupakov/parakeet-tdt-0.6b-v2-onnx` is that same checkpoint
exported to ONNX, and its int8 export runs under onnxruntime with numpy as the only other
dependency. Measured on an M-series CPU Mac, a 4.6 s clip transcribes in ~1.2 s — a `realtimeFactor`
around `0.26`.

The download is CC-BY-4.0 and ungated, so no Hugging Face token is involved. **The weights are never
committed**: they live under `.data/`, and the sidecar's virtualenv under `.venv-parakeet/`, both
gitignored.

**Containers.** Browser capture arrives as WebM/Opus (Chrome, Firefox) or MP4/AAC (Safari); a
controller uploads 16 kHz mono WAV, which needs no decoding at all. Anything outside the accepted
list is refused by the adapter, with the list in the message, rather than posted and returned as an
opaque 4xx. A WAV's length is read from its own header, so an over-long clip is refused before any
inference is paid for; a compressed container's length is enforced by the sidecar, which is why
`max_clip_seconds` is sent with every request.

**Language.** v2 is an English model. Pointing it at another language does not produce that
language, it produces confident English-shaped nonsense — so a language the configured checkpoint
cannot speak is refused as the configuration error it is. Another language means a different
`PARAKEET_MODEL`, not this one trying harder.

**The request** is `multipart/form-data` with `model`, `language`, `max_clip_seconds`, the `file`,
and `sample_rate` / `channels` when they are already known from a WAV header. A successful response
is JSON:

```json
{
  "text": "Deploy the staging branch.",
  "model": "nvidia/parakeet-tdt-0.6b-v2",
  "language": "en",
  "duration_seconds": 4.0,
  "timings": { "decode_ms": 24, "inference_ms": 2000 }
}
```

`camelCase` and `snake_case` keys are both read. A non-2xx quotes the sidecar's own `error`,
`detail` or `message` back in `lastError`; `408`, `425`, `429` and `5xx` are retryable, everything
else is terminal. A timeout or an unreachable sidecar is retryable, because a restart looks
identical to an outage.

**Timings.** A finished job's `timings` map carries `queueWaitMs` (row queued to worker pickup),
`gateWaitMs` (waiting for a sidecar slot), `decodeMs` and `inferenceMs` (reported by the sidecar),
`providerMs` (the round trip), `normalizeMs`, and `totalMs`. When the sidecar reports the clip
length, `realtimeFactor` is seconds of compute per second of audio — above `1.0` the box cannot
keep up with speech in real time, which is the number that decides whether a GPU is worth adding.

The audio itself is never consumed: a transcript is a derived artefact and `GET /v1/media/media_...`
keeps returning the original bytes for as long as retention allows.

Reference the `media.id` from an audio or camera prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "camera_prompt",
    "mediaUploadIds": ["media_...", "media_..."],
    "prompt": "Use these images as context for the current task."
  }
}
```

`mediaUploadIds` is an ordered list and the agent receives the attachments in that order. A single
`mediaUploadId` stays accepted as an alias for a one-item list, which is what protocol-v1 firmware
sends. Every id must belong to the caller (404 otherwise), every referenced upload must be a
supported kind (415 otherwise), and at most 8 may be attached to one turn (400 otherwise).

For `audio_prompt`, the gateway uses `intent.transcript` first. If it is omitted, the gateway uses the stored transcript on the referenced audio media. If no transcript is ready yet, the prompt is dispatched as media context so the command remains auditable.

User clients can list and retrieve media:

```http
GET /v1/media
authorization: Bearer PLATFORM_TOKEN
```

```http
GET /v1/media/media_...
authorization: Bearer PLATFORM_TOKEN
```

```http
DELETE /v1/media/media_...
authorization: Bearer PLATFORM_TOKEN
```

Deleting media removes the stored file bytes and hides the upload from future media lists. Existing command audit records keep redacted metadata only.

Media responses include `expiresAt`. New uploads use the user's privacy retention setting. `expiresAt: null` means the capture is kept until manual deletion.

### The device voice loop

Audio uploaded by a device is queued for transcription automatically — nothing has to ask for it.
The response carries the one identifier the controller needs:

```json
{
  "media": { "id": "media_...", "kind": "audio", "processing": { "transcriptionStatus": "processing" } },
  "job": {
    "jobId": "mjob_...",
    "mediaId": "media_...",
    "milestone": "transcribing",
    "label": "Transcribing",
    "done": false,
    "ok": true,
    "transcript": null,
    "autoSend": false,
    "commandId": null,
    "updatedAt": "2026-02-01T10:15:00.000Z"
  }
}
```

`job` is `null` when the upload was an image, or when no transcription provider is configured — the
upload still succeeds and the media is marked `unavailable`. The capture pins the `environmentId`
and `threadId` the controller was pointed at (from the body, else from the device config), so a
delayed transcript reaches the thread the owner was talking to rather than whichever one is
selected by the time the worker runs.

Poll one endpoint:

```http
GET /v1/device/media/jobs/mjob_...
x-device-id: dev_...
x-device-secret: ...
```

Answers `404` unless the job was recorded by *this* device. Two controllers on one account are two
microphones in two rooms, and the transcript is in the response.

The reply is the projection above and nothing else — stages, leases, attempt counts, provider names
and timings stay on the owner-facing `/v1/media/jobs/:id`. Milestones:

| Milestone | Meaning |
|---|---|
| `recorded` | Device-local. Capture finished, upload not started. |
| `uploading` | Device-local. Bytes in flight. |
| `transcribing` | Queued or being transcribed. |
| `review` | Waiting on a person: review was configured, cleanup altered the wording, or policy asked for approval. |
| `ready` | Transcript is on the media record and waiting. Auto-send is off. |
| `sent` | Dispatched to the agent; `commandId` names the command. |
| `failed` | Transcription failed, or the send was refused. `error` says which. |

`done` is true for every milestone that stops the polling; `ok` is false only for `failed`.

### Auto-send

A finished transcript **waits** by default. Sending it on is a per-device grant the owner issues:

```http
PUT /v1/devices/dev_.../voice-auto-send
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{ "enabled": true }
```

Answers `{ "device": {...}, "voiceAutoSend": { "enabled": true, "enabledBy": "user_...", "enabledAt": "..." } }`.
`GET` on the same path reads it. Turning it off clears `enabledBy`/`enabledAt` rather than leaving a
name on a permission nobody holds. There is deliberately no account-wide switch: auto-send is a
trust decision about one microphone in one room, and a controller claimed later must not inherit it.

Owner realm only — a device cannot widen its own licence to act on what it hears.

The grant, the device, and the **policy** are all read at the moment of dispatch, never at enqueue.
A capture that sat in the queue while the owner tightened the device profile, revoked the device, or
turned auto-send back off is judged by the newer rules. When auto-send is on, the transcript goes
out through the ordinary device intent path (`normalizeIntent` → `evaluateIntentPolicy` →
`thread.turn.start`) with the recording attached, producing a normal command on the timeline
credited to the device that recorded it.

A refusal is not a transcription failure. The transcript is written to the media record either way;
only the send is declined, and the job records that separately:

| Field | Meaning |
|---|---|
| `dispatchStatus` | `null` (never attempted), `sent`, `approval_required`, `blocked` (policy), `failed`. |
| `dispatchError` | Why the send did not go. Distinct from `lastError`, which is why transcription did not. |
| `commandId` | The command the transcript became, when one was created. |
| `autoSend` | The decision the worker actually acted on. |

## Privacy Settings

```http
GET /v1/settings/privacy
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "privacy": {
    "mediaRetentionDays": 30
  }
}
```

```http
PUT /v1/settings/privacy
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "mediaRetentionDays": 7
}
```

Use `null` for manual deletion only:

```json
{
  "mediaRetentionDays": null
}
```

## T3 Code Compatibility

Read the current supported-release policy and the latest saved compatibility result for every
paired T3 environment:

```http
GET /v1/settings/t3-compatibility
authorization: Bearer PLATFORM_TOKEN
```

Run a fresh, read-only check against every paired environment:

```http
POST /v1/settings/t3-compatibility
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{}
```

Pass `environmentId` to check one environment. The gateway reads
`/.well-known/t3/environment`, validates the orchestration snapshot contract, compares the
reported server version with the latest `t3` package release, and persists the result in
environment health. A later check records `versionChanged` and raises `breakingRisk` when a
changed version is outside the certified range or a required read-only contract fails.

The response includes the installed, latest, minimum-supported, maximum-tested, and recommended
versions; individual contract checks; compatibility findings; and a fleet summary. Compatibility
results also feed `/v1/observability/alerts` so potentially breaking T3 changes appear as critical
environment alerts.

Purge expired media bytes and metadata:

```http
POST /v1/media/purge-expired
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

## Register T3 Environment

The guided host setup is available through `npm run setup:t3`. Adding an initial project is optional; users can instead manage projects directly in T3 Code or with `t3 project`.

Launch the first thread for a project that is already registered in T3:

```http
POST /v1/t3/environments/:environmentId/threads
Authorization: Bearer PLATFORM_TOKEN
Content-Type: application/json

{
  "projectId": "project_id",
  "text": "Inspect this project and report that the session is ready.",
  "modelSelection": {
    "instanceId": "codex",
    "model": "gpt-5.4"
  },
  "runtimeMode": "approval-required",
  "interactionMode": "default",
  "mediaUploadIds": ["media_id"]
}
```

`mediaUploadIds` (or a single `mediaUploadId`) attaches already-uploaded media to the first turn, on the same terms as `POST /v1/intents`: every id must belong to the caller (404 otherwise), and at most 8 may be attached (400 otherwise).

`modelSelection` is optional when the T3 project has a default. Provider instance IDs are not restricted to built-ins, so user-defined T3 provider instances are supported. The gateway dispatches `thread.create` followed by `thread.turn.start` because T3's HTTP orchestration endpoint requires the thread to exist before accepting the first turn.

### Console-first pairing (connect sessions)

`POST /v1/t3/environments` requires the browser to hold a credential the T3 host produced, which
means the user must copy a token between two machines. Connect sessions invert that: the console
mints a short-lived, single-use enrollment code while the user is signed in, shows one command to run
on the host, and polls until the pairing lands.

```http
POST /v1/t3/connect-sessions
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Mac T3 Code",
  "accessMode": "tailscale",
  "environmentId": "env_..."
}
```

`accessMode` is `local`, `tailscale`, or `online` (anything else falls back to `local`) and only
decides which `--tunnel` the returned command carries. `environmentId` is optional and marks the
session as a **re-pair**: redeeming updates that environment in place rather than creating a row. A
first pairing is checked against the plan's environment allowance; a re-pair is not.

The response carries the code once — the gateway stores only its SHA-256 hash and cannot show it
again:

```json
{
  "session": { "id": "cxn_...", "status": "pending", "expiresAt": "..." },
  "code": "ABCDE-FGHIJ",
  "gatewayUrl": "https://gateway.example",
  "command": "npm run setup:t3 -- --gateway-url 'https://gateway.example' --connect-code 'ABCDE-FGHIJ' --tunnel 'tailscale'"
}
```

Poll while the user is on the other machine:

```http
GET /v1/t3/connect-sessions/cxn_...
authorization: Bearer PLATFORM_TOKEN
```

Returns `{ "session": ..., "environment": ... }`. `session.status` is `pending`, `redeeming`,
`completed`, `failed`, or `expired`; `environment` is populated only once the status is `completed`,
and never includes the stored access token. A session belonging to another user answers 404.

The T3 host redeems the code. This route takes **no** platform credential — the code is the
credential — and is rate limited per client address (`CONNECT_REDEEM_RATE_LIMIT`, default 20/window):

```http
POST /v1/t3/connect-sessions/redeem
content-type: application/json
```

```json
{
  "code": "ABCDE-FGHIJ",
  "baseUrl": "https://mac.tailnet.ts.net",
  "pairingToken": "...",
  "instances": [{ "instanceId": "anthropic", "status": "ready", "models": [] }]
}
```

`instances` is the provider catalogue read from `<base-dir>/caches/*.json`; it rides along because
the script has no platform token to `PUT /v1/t3/environments/:id/catalogue` with. `accessToken` may
replace `pairingToken` for local development. On success the gateway exchanges the token, upserts the
environment, registers the catalogue, health-checks the host, and returns
`{ session, environment, screen, failure, catalogue }` with HTTP 201.

A code is single use and lives 15 minutes. A replayed or unknown code returns 404; an expired one
returns 410 so the host can tell the user to mint a fresh code rather than hunt for a typo. Request
validation happens **before** the code is consumed, so a malformed body leaves the code usable. If
the exchange itself fails, the session is marked `failed` with the reason, which is what the polling
console renders.

`scripts/setup-t3.mjs` drives this with `--connect-code`; `--gateway-token` / `--gateway-dev-user`
remain for the manual path. Launching a first thread (`--initial-prompt`) still needs a platform
token, because a connect code deliberately does not grant the platform realm.

### Manual pairing

```http
POST /v1/t3/environments
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Mac T3 Code",
  "baseUrl": "https://mac.tailnet.ts.net",
  "pairingToken": "..."
}
```

Development can provide an existing T3 access token:

```json
{
  "label": "Mac T3 Code",
  "baseUrl": "https://mac.tailnet.ts.net",
  "accessToken": "...",
  "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
}
```

The gateway encrypts stored T3 access tokens when `T3_TOKEN_ENCRYPTION_KEY` is configured. Convex-backed deployments fall back to `GATEWAY_CONVEX_SECRET` if no dedicated token encryption key is set, but production deployments should use a separate key.

When T3 token exchange returns `expires_in`, the gateway stores an `accessTokenExpiresAt` timestamp automatically. Manual access-token registration can include `accessTokenExpiresAt`; omitted means the gateway has no known expiry for that token. Expired T3 credentials set environment health to `token_expired` and return HTTP 409 for snapshot, dispatch, and approval dispatch until the environment is re-paired or updated.

Update a paired environment:

```http
PUT /v1/t3/environments/env_...
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "MacBook Pro T3 Code",
  "baseUrl": "https://macbook.tailnet.ts.net",
  "accessToken": "...",
  "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
}
```

You can also send a new `pairingToken` instead of `accessToken`. Omitted fields keep their current values, including `accessTokenExpiresAt`.

Preview what still points at an environment before removing it:

```http
GET /v1/t3/environments/env_.../dependencies
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "environmentId": "env_...",
  "dependencies": {
    "devices": [{ "id": "dev_...", "label": "Desk Controller" }],
    "actions": [{ "id": "action_...", "label": "Ship it" }],
    "macros": [],
    "onboarding": true
  },
  "counts": { "devices": 1, "actions": 1, "macros": 0, "onboarding": 1 }
}
```

Remove an environment:

```http
DELETE /v1/t3/environments/env_...
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "environment": { "id": "env_...", "label": "MacBook Pro T3 Code" },
  "removed": {
    "devices": ["dev_..."],
    "actions": ["action_..."],
    "macros": ["macro_..."],
    "onboarding": true
  },
  "alreadyRemoved": false
}
```

Removal deletes the stored T3 credential and repairs everything that referenced the environment: device runtime configs lose it as their default, the onboarding selection (and its first thread) is cleared, and saved actions and macros that targeted it are **disabled** with `disabledReason: "environment_removed"` rather than left dangling — a fixed-target action without an `environmentId` is a record the API would refuse to create. Saving such an action or macro again re-enables it.

The call is idempotent: repeating it answers `200` with `environment: null`, an empty `removed`, and `alreadyRemoved: true`.

Check whether a paired environment is currently reachable:

```http
POST /v1/t3/environments/env_.../check
authorization: Bearer PLATFORM_TOKEN
```

The gateway calls `/api/orchestration/snapshot` with a timeout and stores compact health on the environment:

```json
{
  "environment": {
    "id": "env_...",
    "status": "reachable",
    "health": {
      "lastCheckedAt": "2026-06-14T23:20:00.000Z",
      "lastReachableAt": "2026-06-14T23:20:00.000Z",
      "lastError": null,
      "snapshot": {
        "title": "T3 Code",
        "state": "reachable",
        "line1": "2 projects",
        "line2": "1 threads"
      }
    }
  }
}
```

Fetch the full T3 snapshot for project/thread selection:

```http
GET /v1/t3/environments/env_.../snapshot
authorization: Bearer PLATFORM_TOKEN
```

The response includes the raw T3 snapshot plus the compact screen summary. The gateway also refreshes the environment health fields:

```json
{
  "environment": {
    "id": "env_...",
    "status": "reachable"
  },
  "snapshot": {
    "projects": [{ "id": "project_...", "title": "Agent Controller" }],
    "threads": [{ "id": "thread_...", "title": "Implementation" }]
  },
  "screen": {
    "title": "T3 Code",
    "state": "reachable",
    "line1": "1 projects",
    "line2": "1 threads"
  }
}
```

## Firmware Releases

Publish firmware metadata:

```http
POST /v1/factory/firmware/releases
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "version": "0.2.0",
  "hardwareModel": "e213-esp32-s3r8",
  "url": "https://cdn.example.com/firmware/agent-controller-0.2.0.bin",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sizeBytes": 901385,
  "mandatory": false,
  "releaseNotes": "Adds runtime config polling."
}
```

The response includes a signed manifest. The signature is an HMAC-SHA256 over canonical manifest fields using `OTA_SIGNING_KEY`.

List firmware releases:

```http
GET /v1/factory/firmware/releases?hardwareModel=e213-esp32-s3r8
authorization: Bearer FACTORY_TOKEN
```

Remove a withdrawn or temporary release so devices cannot keep retrying an unavailable artifact:

```http
DELETE /v1/factory/firmware/releases/fw_...
authorization: Bearer FACTORY_TOKEN
```

## Device Intent

```http
POST /v1/device/intents
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

Prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "agent_prompt",
    "text": "Continue the implementation and run tests."
  }
}
```

Status:

```json
{
  "environmentId": "env_...",
  "intent": {
    "type": "status"
  }
}
```

Audio transcript:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "audio_prompt",
    "transcript": "Check the current implementation and continue."
  }
}
```

Audio prompt using a stored media transcript:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "audio_prompt",
    "mediaUploadIds": ["media_..."]
  }
}
```

Camera prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "camera_prompt",
    "mediaUploadIds": ["media_..."],
    "prompt": "Use this image as context for the current coding task."
  }
}
```

Shell input:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "shell_input",
    "command": "npm test"
  }
}
```

Shell input is converted into an approval-required agent prompt. Direct terminal write is intentionally not implemented in this slice. High-risk shell input, such as destructive file operations, is stored as an `approval_required` command and must be approved by a signed-in user before dispatch.

## Command Approvals

List commands, including pending approvals:

```http
GET /v1/commands
authorization: Bearer PLATFORM_TOKEN
```

Inspect a command's status timeline:

```http
GET /v1/commands/cmd_.../events
authorization: Bearer PLATFORM_TOKEN
```

The timeline records command creation and status transitions such as `approval_required`, `blocked`, `dispatched`, `failed`, and `rejected`, including actor type, previous status, risk, result metadata, and command metrics.

Command responses include a `metrics` object:

```json
{
  "acknowledgementDurationMs": 148,
  "dispatchDurationMs": 93,
  "completedAt": "2026-06-16T19:00:00.000Z",
  "failureAt": null
}
```

If T3 dispatch or status snapshot retrieval fails, the gateway stores a command with status `failed`, returns HTTP 502, and includes the failed command in the error details. This gives support and dashboards a durable record of failed dispatches instead of losing them as transient request errors.

Approve a pending command:

```http
POST /v1/commands/cmd_.../approve
authorization: Bearer PLATFORM_TOKEN
```

Reject a pending command:

```http
POST /v1/commands/cmd_.../reject
authorization: Bearer PLATFORM_TOKEN
```

Only commands with status `approval_required` can be approved or rejected. Approving dispatches the stored normalized intent to the paired T3 Code environment; rejecting records the decision without dispatching to T3.

## Observability Summary

Fetch a user-scoped reliability summary for dashboards and support triage:

```http
GET /v1/observability/summary
authorization: Bearer PLATFORM_TOKEN
```

The summary rolls up device presence, firmware versions, low battery devices, T3 environment health and token expiry, command status/latency metrics, and media processing failures:

```json
{
  "summary": {
    "devices": {
      "total": 2,
      "online": 1,
      "offline": 1,
      "lowBatteryDevices": 1
    },
    "environments": {
      "reachable": 1,
      "unreachable": 0,
      "tokenExpired": 0,
      "tokenExpiringSoon": 1
    },
    "commands": {
      "failed": 1,
      "acknowledgement": {
        "medianMs": 148,
        "p95Ms": 300
      }
    },
    "media": {
      "failedProcessing": 0,
      "pendingProcessing": 1
    }
  }
}
```

## Support Diagnostics

Export a redacted support bundle for the current account:

```http
GET /v1/support/diagnostics
authorization: Bearer PLATFORM_TOKEN
```

The bundle includes current display state, observability summary, devices, T3 environments and health, media metadata, saved macro metadata, recent commands, and recent audit events. It does not include device secrets, API token hashes, T3 access tokens, media file paths, or media bytes. Prompt text, shell commands, transcripts, media prompts, and macro prompt text are replaced with length and SHA-256 metadata.

## Web / Phone Intent

User-authenticated clients can send the same normalized intent model without device credentials:

```http
POST /v1/intents
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "agent_prompt",
    "text": "Continue from the dashboard."
  }
}
```

## Saved Macros

Macros are user-owned saved intent templates. They can store a default T3 environment and thread, or use the values supplied at run time.

```http
GET /v1/macros
authorization: Bearer PLATFORM_TOKEN
```

```http
POST /v1/macros
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Run tests",
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "shell_input",
    "command": "npm test"
  }
}
```

Run a saved macro through the same policy and approval pipeline as normal intents:

```http
POST /v1/macros/macro_.../run
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "environmentId": "env_override_optional",
  "threadId": "thread_override_optional"
}
```

Delete a saved macro:

```http
DELETE /v1/macros/macro_...
authorization: Bearer PLATFORM_TOKEN
```

User-authenticated clients can also upload media directly:

```http
POST /v1/media
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "kind": "image",
  "contentType": "image/png",
  "dataBase64": "BASE64_BYTES"
}
```

## Application

The React/Vite application is the primary UI and is served from:

```text
http://127.0.0.1:3996/
```

The React application can register or claim devices, rotate device secrets, revoke devices, pair or
dependency-preview/remove T3 environments, upload media, send prompts with ordered stored-media
attachments, approve or reject high-risk Agent Controller commands, request status, stop sessions,
and review audit activity. Dispatch is not yet a complete live T3 conversation: provider approvals,
structured questions, streamed tool activity, subagents, and parallel tasks are not exposed through
the current API/UI. That work is tracked in
[roadmap/IMPLEMENTATION-STATUS.md](../roadmap/IMPLEMENTATION-STATUS.md).

## Display State And Events

User clients can fetch compact display state:

```http
GET /v1/display
authorization: Bearer PLATFORM_TOKEN
```

Devices can fetch display state using device credentials:

```http
GET /v1/device/display
x-device-id: dev_...
x-device-secret: ...
```

Display `counts` include `onlineDevices` and `offlineDevices`, derived from the same server-side device presence calculation.

Devices can fetch gateway-managed runtime config:

```http
GET /v1/device/config
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "deviceId": "dev_...",
  "config": {
    "environmentId": "env_...",
    "projectId": null,
    "threadId": "thread_...",
    "defaultPrompt": "Continue the current task, inspect progress, and run relevant tests.",
    "shellCommand": "npm test",
    "menu": ["status", "prompt", "shell", "macro", "media", "stop"]
  }
}
```

Once `environmentId` and `threadId` are configured, device intent requests can omit those fields and the gateway will apply the saved defaults. Status intents only require `environmentId`.

### Device environment, project and thread selection

A controller browses three levels, each scoped by the one above it. The full wire format
and the firmware-side flow live in [hardware-protocol.md](hardware-protocol.md#environment-project-and-thread-api);
this is the endpoint summary.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/device/environments` | The claiming owner's environments, with the bound one flagged |
| POST | `/v1/device/config/environment` | Bind the device to one of them |
| GET | `/v1/device/projects` | Projects in the bound environment, from the T3 snapshot |
| POST | `/v1/device/config/project` | Set the active project |
| GET | `/v1/device/threads` | Threads in the bound environment, narrowed to the active project |
| POST | `/v1/device/config/thread` | Set the active thread |

All six are device realm (`x-device-id` + `x-device-secret`) and require a claimed device.

```http
GET /v1/device/environments
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "environmentId": "env_bound",
  "environments": [
    { "id": "env_bound", "label": "Workshop mac", "status": "ready", "tokenExpired": false, "selected": true },
    { "id": "env_spare", "label": "Spare T3", "status": "ready", "tokenExpired": false, "selected": false }
  ]
}
```

Only the claiming owner's environments are listed, and only these five fields — `baseUrl`, scopes
and anything token-bearing never cross into the device realm. This route answers `200` with no
environment bound, because a device that has none is exactly the one that needs the list.

```http
POST /v1/device/config/environment
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "environmentId": "env_spare" }
```

`environmentId` is resolved through the owner's own scope, so another account's id is a `404`;
a blank or missing one is a `400`. Changing to a different environment clears `projectId` and
`threadId`, which only meant anything inside the environment being left. Re-binding the same
environment keeps both.

```http
GET /v1/device/projects
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "environmentId": "env_bound",
  "projectId": "proj_beta",
  "projects": [
    { "id": "proj_alpha", "title": "Alpha folder", "threadCount": 2, "selected": false },
    { "id": "proj_beta", "title": "Beta folder", "threadCount": 1, "selected": true }
  ]
}
```

```http
POST /v1/device/config/project
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "projectId": "proj_alpha" }
```

The id is validated against the live snapshot of the bound environment, so an unknown or foreign
project is a `404`. Selecting a project that does not contain the current thread clears
`threadId`; a thread already inside it is untouched. Both project endpoints return `409` when no
environment is bound and `502` with `details.code: "t3_unreachable"` when the bound T3 host cannot
be reached — the same contract the thread endpoints use.

`projectId` is `null` by default and means "the whole environment", so `GET /v1/device/threads`
keeps returning every thread for firmware that predates project selection. Once a project is set,
both the thread listing and `POST /v1/device/config/thread` are narrowed to it, and a thread with
no `projectId` in the snapshot is excluded rather than guessed at.

The owner-facing `PUT /v1/devices/:id/config` accepts `projectId` alongside `environmentId` and
`threadId`. Deleting an environment clears the `projectId` of every device bound to it.

Devices can list and run saved macros for the claimed account:

```http
GET /v1/device/macros
x-device-id: dev_...
x-device-secret: ...
```

```http
POST /v1/device/macros/macro_.../run
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{}
```

Devices can list and act on pending approval-required commands:

```http
GET /v1/device/approvals
x-device-id: dev_...
x-device-secret: ...
```

```http
POST /v1/device/approvals/cmd_.../approve
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```http
POST /v1/device/approvals/cmd_.../reject
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

Devices can poll firmware update metadata:

```http
GET /v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8
x-device-id: dev_...
x-device-secret: ...
```

If a newer release exists:

```json
{
  "updateAvailable": true,
  "currentVersion": "0.1.0",
  "hardwareModel": "e213-esp32-s3r8",
  "manifest": {
    "version": "0.2.0",
    "hardwareModel": "e213-esp32-s3r8",
    "url": "https://cdn.example.com/firmware/agent-controller-0.2.0.bin",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": 901385,
    "mandatory": false,
    "releaseNotes": "Adds runtime config polling.",
    "createdAt": "2026-06-14T21:00:00.000Z",
    "signature": "..."
  }
}
```

The current firmware scaffold can download and apply update images when `ENABLE_OTA_APPLY=1`. It checks the downloaded image size and SHA-256 before committing the OTA partition. If `REQUIRE_OTA_SIGNATURE=1`, it also validates the manifest HMAC against `OTA_MANIFEST_VERIFY_KEY`.

User clients can subscribe to state changes with Server-Sent Events:

```text
GET /v1/events?token=PLATFORM_TOKEN
```

Devices can subscribe with query credentials when headers are not convenient:

```text
GET /v1/device/events?deviceId=dev_...&deviceSecret=...
```

The event stream emits:

```text
connected
heartbeat
state.changed
```

## Local End-To-End Demo

Terminal 1:

```bash
node scripts/mock-t3.mjs
```

Terminal 2:

```bash
PORT=8877 DATA_FILE=.data/dev.json node src/server.mjs
```

Terminal 3:

```bash
AGENT_CONTROLLER_URL=http://127.0.0.1:8877 node scripts/simulate-device.mjs
```

Or run the automated local smoke flow:

```bash
AGENT_CONTROLLER_URL=http://127.0.0.1:8877 node scripts/smoke-local.mjs
```

Then register the mock T3 environment:

```bash
curl -X POST http://127.0.0.1:8877/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{"label":"Mock T3","baseUrl":"http://127.0.0.1:3999","pairingToken":"dev"}'
```
