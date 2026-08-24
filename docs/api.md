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

Request transcription for an uploaded audio file:

```http
POST /v1/media/media_.../transcribe
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{}
```

When `TRANSCRIPTION_PROVIDER=mock`, this returns a deterministic development transcript and marks the media as `processing.transcriptionStatus: "ready"` with `transcriptSource: "mock"`. If no provider is configured, the route returns `409` and marks the media as `unavailable`.

Reference the `media.id` from an audio or camera prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "camera_prompt",
    "mediaUploadId": "media_...",
    "prompt": "Use this image as context for the current task."
  }
}
```

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
    "mediaUploadId": "media_..."
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
    "mediaUploadId": "media_...",
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

The React application can register or claim devices, rotate device secrets, revoke devices, pair T3 environments, upload media, send prompts, approve or reject high-risk commands, request status, stop sessions, and review audit activity.

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
    "threadId": "thread_...",
    "defaultPrompt": "Continue the current task, inspect progress, and run relevant tests.",
    "shellCommand": "npm test",
    "menu": ["status", "prompt", "shell", "macro", "media", "stop"]
  }
}
```

Once `environmentId` and `threadId` are configured, device intent requests can omit those fields and the gateway will apply the saved defaults. Status intents only require `environmentId`.

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
