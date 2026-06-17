# Agent Controller

Cloud control plane for remote controller hardware, phone/web clients, and T3 Code environments.

The current implementation is the first vertical slice:

- User-scoped device registration.
- Factory pre-provisioning with claim codes.
- Per-device credentials.
- Device claim, secret rotation, and revocation.
- Device-generated setup codes for customer onboarding.
- Device-authenticated heartbeat, diagnostics, state, and intent endpoints.
- Discoverable device policy profiles with owner-managed profile updates.
- T3 Code environment registration and reachability checks.
- T3 Code snapshot, session selection, and orchestration dispatch integration.
- Policy checks and user approval gates for prompt, media, session control, and shell input.
- Per-command status timelines for support and owner visibility.
- User-scoped observability summary for device presence, T3 health, command latency/failures, and media processing.
- Redacted support diagnostics export.
- Device media upload storage for audio/image captures, transcription state, audio transcripts, retention settings, and purge.
- Simulated device registration script.
- ESP32 firmware scaffold for the hardware controller.
- Factory batch provisioning and signed firmware update metadata.
- Per-user, per-device, and factory rate limits.
- Clerk auth and Convex storage integration.

## Run

```bash
node src/server.mjs
```

The service listens on:

```text
http://127.0.0.1:3996
```

Open the dashboard at:

```text
http://127.0.0.1:3996/
```

To persist local platform state:

```bash
DATA_FILE=.data/agent-controller.json node src/server.mjs
```

## Create A Device

```bash
node scripts/simulate-device.mjs
```

## ESP32 Firmware

The first hardware scaffold is in:

```text
firmware/esp32-controller
```

It connects over WiFi, authenticates with the device ID/secret, polls compact display state, renders to a 2.13 inch e-ink display, reads an EC11 rotary encoder, and sends menu intents.
Runtime defaults for the T3 environment, thread, prompt, and menu can be managed from the gateway after the device is claimed.

```bash
cd firmware/esp32-controller
cp include/controller_config.example.h include/controller_config.h
pio run
```

See [docs/hardware-protocol.md](docs/hardware-protocol.md) for provisioning, claim, display, media, and intent details.

## Manufacturing

Create factory devices and per-device `controller_config.h` files:

```bash
AGENT_CONTROLLER_URL=http://127.0.0.1:3996 \
FACTORY_TOKEN=replace-with-factory-secret \
COUNT=10 \
LABEL_PREFIX="Agent Controller" \
PUBLIC_GATEWAY_URL=https://gateway.example.com \
ENABLE_OTA_APPLY=0 \
npm run manufacture:batch
```

Publish a signed firmware release manifest:

```bash
AGENT_CONTROLLER_URL=http://127.0.0.1:3996 \
FACTORY_TOKEN=replace-with-factory-secret \
FIRMWARE_VERSION=0.2.0 \
FIRMWARE_URL=https://cdn.example.com/firmware/agent-controller-0.2.0.bin \
FIRMWARE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
FIRMWARE_SIZE_BYTES=901385 \
npm run firmware:publish
```

Set `OTA_SIGNING_KEY` on the gateway before publishing production firmware metadata.
Generated firmware configs default to `ENABLE_OTA_APPLY=0`; enable OTA application only after testing the partition table and rollback process on real hardware.

## Rate Limits

The gateway applies fixed-window in-memory limits per user, device, and factory client. Defaults are configured in `.env.example`:

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

HTTP `429` responses include `x-ratelimit-*` and `retry-after` headers. For multi-process deployments, replace the in-memory limiter with a shared store such as Redis.

## Clerk And Convex

The gateway can use Clerk bearer sessions for platform user authentication:

```text
AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=sk_test_replace
CLERK_PUBLISHABLE_KEY=pk_test_replace
CLERK_AUTHORIZED_PARTIES=https://gateway.example.com
```

When Clerk is enabled, the built-in dashboard exposes a Clerk sign-in panel and uses `session.getToken()` as the bearer token for gateway API calls. Development platform tokens remain available for local testing.
`POST /v1/users/dev` is disabled automatically in Clerk mode unless `ENABLE_DEV_TOKENS=1` is explicitly set. Leave that unset in production.

Convex schema/functions are scaffolded under `convex/`, including `gatewayStore:*` functions for the Node Store API. The gateway bridge in `src/convexStore.mjs` generates secrets locally, stores only hashes in Convex, encrypts T3 access tokens before storage, and authenticates store calls with `GATEWAY_CONVEX_SECRET`. See [docs/auth-storage.md](docs/auth-storage.md) for deployment validation steps.

Run the Convex-backed HTTP smoke flow after `npx convex dev --once` has configured `.env.local`:

```bash
npm run smoke:convex
```

For local audio transcription development, set:

```text
TRANSCRIPTION_PROVIDER=mock
```

The mock provider produces deterministic transcripts for smoke tests. Production deployments should replace it with a real transcription worker/provider.

## Register A T3 Environment

Use either a T3 pairing token:

```bash
curl -X POST http://127.0.0.1:3996/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{
    "label": "Mac T3 Code",
    "baseUrl": "https://your-mac.tailnet.ts.net",
    "pairingToken": "T3_PAIRING_TOKEN"
  }'
```

Or, for local development only, provide an existing access token:

```bash
curl -X POST http://127.0.0.1:3996/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{
    "label": "Mac T3 Code",
    "baseUrl": "https://your-mac.tailnet.ts.net",
    "accessToken": "T3_ACCESS_TOKEN",
    "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
  }'
```

When a pairing token exchange returns `expires_in`, the gateway stores `accessTokenExpiresAt` automatically. Manual access-token registration can include the same field; omit it only when the token has no known expiry. Expired T3 credentials return `token_expired` health and block snapshot/dispatch calls until the environment is re-paired or updated.

## Send A Device Prompt

```bash
curl -X POST http://127.0.0.1:3996/v1/device/intents \
  -H 'content-type: application/json' \
  -H 'x-device-id: DEVICE_ID' \
  -H 'x-device-secret: DEVICE_SECRET' \
  -d '{
    "environmentId": "ENVIRONMENT_ID",
    "threadId": "THREAD_ID",
    "intent": {
      "type": "agent_prompt",
      "text": "Continue the implementation and run tests."
    }
  }'
```

## Web Dashboard

The built-in dashboard supports:

- Creating a local platform token.
- Registering development devices, claiming factory devices, updating profiles, rotating secrets, transfer-resetting devices, and revoking devices.
- Pairing, updating, unpairing, reachability-checking, and browsing T3 Code sessions.
- Uploading, deleting, and retention-managing image/audio media from phone or laptop.
- Sending text, media, shell, status, and stop intents.
- Saving and running prompt or shell macros.
- Running saved macros from claimed hardware.
- Approving or rejecting pending commands from claimed hardware.
- Approving or rejecting high-risk shell commands before dispatch.
- Downloading a redacted support diagnostics bundle.
- Viewing live display state, devices, environments, media, and audit activity.

## Test

```bash
node --test
```

## Local Mock T3

For local development without a real T3 Code instance:

```bash
node scripts/mock-t3.mjs
```

See [docs/api.md](docs/api.md) for endpoint examples and the local end-to-end flow.
