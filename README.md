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
- React, Vite, and Tailwind operations console with route-level workspaces for control, fleet, environments, media, activity, and settings.

## Run

```bash
npm install
npm start
```

`npm start` builds the React client and starts the gateway at:

```text
http://127.0.0.1:3996
```

Open the dashboard at:

```text
http://127.0.0.1:3996/
```

For frontend development with hot reload, run the gateway and Vite in separate terminals:

```bash
npm run dev:server
npm run dev:app
```

Vite listens on `http://127.0.0.1:5173` and proxies gateway requests to port `3996`. Use `npm run build`, `npm run typecheck:web`, and `npm test` before shipping.

To persist local platform state:

```bash
DATA_FILE=.data/agent-controller.json npm start
```

## Remote Access

Use private Tailscale Serve for stable HTTPS access from your Tailnet:

```bash
npm run setup:tunnel -- --mode serve --write-env
```

Use Tailscale Funnel only when the gateway must be reachable from the public internet:

```bash
npm run setup:tunnel -- --mode funnel --write-env
```

Restart Agent Controller after the command updates `.env`. The Settings workspace includes the same guided setup and disable commands. See [docs/remote-access.md](docs/remote-access.md) for the gateway-versus-T3 distinction, Clerk requirements, LAN hardware guidance, and troubleshooting.

## Create A Device

```bash
node scripts/simulate-device.mjs
```

## ESP32 Firmware

The first hardware scaffold is in:

```text
firmware/CrowPanel-ESP32-2.13-E-paper
```

It connects over WiFi, authenticates with the device ID/secret, polls compact display state, renders to a 2.13 inch e-ink display, reads an EC11 rotary encoder, and sends menu intents.
Runtime defaults for the T3 environment, thread, prompt, and menu can be managed from the gateway after the device is claimed.

```bash
cd firmware/CrowPanel-ESP32-2.13-E-paper
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

For a managed artifact, set `FIRMWARE_FILE` instead of the URL, digest, and size. The gateway
computes integrity metadata and stores the immutable binary on disk or in configured private S3/R2:

```bash
AGENT_CONTROLLER_URL=https://gateway.example.com \
FACTORY_TOKEN=replace-with-factory-secret \
FIRMWARE_FILE=.pio/build/secure/firmware.bin \
FIRMWARE_VERSION=0.2.0 \
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

The React dashboard uses Clerk exclusively for platform user authentication. Link a Clerk application and pull its development keys:

```bash
clerk auth login
clerk init --app YOUR_CLERK_APP_ID
clerk doctor
```

The Clerk CLI writes the secret and Vite publishable key to the gitignored `.env.local`. Gateway configuration stays in `.env`:

```text
AUTH_PROVIDER=clerk
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:3996,https://gateway.example.com
STORAGE_PROVIDER=convex
CONVEX_URL=https://your-deployment.convex.cloud
```

The browser obtains fresh Clerk session tokens for API requests and uses the same-origin Clerk session cookie for live events. Tokens are never persisted in `localStorage`. The gateway verifies every session with `@clerk/backend` and synchronizes the verified Clerk ID, name, and primary email into the platform store.

After the first Clerk sign-in, the React app opens a resumable six-step setup workbench. It
configures the T3 host and network path, pairs and verifies the environment, selects a live
project/provider/model, launches the first proof thread, and either configures a controller or
records an explicit browser-only choice. Progress is user-scoped in the configured store, and
the server refuses completion unless the operational evidence is present. The detailed flow is
documented in [docs/onboarding-flow.md](docs/onboarding-flow.md).

`POST /v1/users/dev` remains available only in explicit legacy/test mode. It is disabled in Clerk mode and is not exposed in the React dashboard.

Convex schema/functions are scaffolded under `convex/`, including `gatewayStore:*` functions for the Node Store API. The gateway bridge in `src/convexStore.mjs` generates secrets locally, stores only hashes in Convex, encrypts T3 access tokens before storage, and authenticates store calls with `GATEWAY_CONVEX_SECRET`. See [docs/auth-storage.md](docs/auth-storage.md) for deployment validation steps.

Run the Convex-backed HTTP smoke flow after `npx convex dev --once --env-file .env` has deployed the functions:

```bash
npm run smoke:convex
```

For local audio transcription development, set:

```text
TRANSCRIPTION_PROVIDER=mock
```

The mock provider produces deterministic transcripts for smoke tests. Production deployments should replace it with a real transcription worker/provider.

## Register A T3 Environment

For guided local setup, run:

```bash
npm run setup:t3
```

The setup checks for T3 Code and installs the current `t3` CLI when needed. It then walks through provider harness selection, provider authentication, local/LAN/Tailscale/custom connectivity, optional project registration, T3 launch, and gateway pairing.

Harness selection is not restricted to OpenAI. The built-in choices are automatic detection, Codex/OpenAI, Claude Code, Cursor, OpenCode, Grok, and a custom T3 provider instance. OpenAI/Codex is only the choice used by the current Mac test.

Pairing also registers the host's **agent harness catalogue** with the gateway. T3's orchestration
HTTP API does not expose which harnesses and models exist, so the setup script reads T3's own
provider caches from the base directory and uploads them. That is what lets the dashboard show real
harness and model dropdowns instead of free-text fields, and lets the gateway reject a model T3 does
not offer before it is dispatched.

Without this step the dashboard can only list harnesses and models already in use by an existing
project or thread.

Project registration is a convenience, not a requirement. Choose `--skip-project` to start T3 without adding one, then manage projects later in the T3 Code app or with `t3 project`.

Example for the local Tacs test:

```bash
npm run setup:t3 -- \
  --yes \
  --project /Users/example/Documents/Claude/Projects/Tacs \
  --provider openai \
  --tunnel local \
  --gateway-url http://127.0.0.1:3996 \
  --gateway-dev-user user_t3_e2e \
  --initial-prompt "Report that the remote session is ready."
```

For Tailnet access, use `--tunnel tailscale`. The script verifies or installs Tailscale, requires the user to finish Tailnet sign-in, and launches T3 with `--tailscale-serve`, following T3 Code's [remote access guidance](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md).

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
- Selecting any T3 project/provider instance/model and launching its first thread.
- Uploading, deleting, and retention-managing image/audio media from phone or laptop.
- Sending text, media, shell, status, and stop intents.
- Saving and running prompt or shell macros.
- Running saved macros from claimed hardware.
- Approving or rejecting pending commands from claimed hardware.
- Approving or rejecting high-risk shell commands before dispatch.
- Downloading a redacted support diagnostics bundle.
- Viewing live display state, devices, environments, media, and audit activity.

## Test

Run the full gate (client build, frontend typecheck, frontend tests, server tests):

```bash
npm test
```

Run one layer at a time:

```bash
npm run test:server
```

```bash
npm run test:app
```

Run a single server test file or a single test by name:

```bash
node --test test/policy.test.mjs
```

```bash
node --test --test-name-pattern="claim" test/app.test.mjs
```

Do not run a bare `node --test` from the repository root. Node's default discovery also picks up the
frontend `src/**/*.test.ts` files, which need the jsdom environment and setup that only
`npm run test:app` provides.

## Local Mock T3

For local development without a real T3 Code instance:

```bash
node scripts/mock-t3.mjs
```

See [docs/api.md](docs/api.md) for endpoint examples and the local end-to-end flow.
