# Production Security And OTA Rollback

Covers roadmap Phase 4 (minimum production security) and the Phase 12 OTA pipeline.

Each item below is split into the part the code enforces and the part a human must perform. The
human half is deliberately not automated: burning eFuses is irreversible, and a mistake bricks the
board permanently.

## TLS only

Enforced by the gateway. Set:

```text
REQUIRE_TLS=1
```

With this set, the gateway refuses to **issue or accept a device credential** over plaintext. That
covers device registration, claiming, secret rotation, transfer reset, factory provisioning, and
every device-authenticated request.

Loopback is exempt so the simulator and local flashing keep working — but only when no proxy
forwarded the request. Once `x-forwarded-proto` is present the real client is elsewhere, so its
scheme decides, and a loopback socket grants no exemption. Terminate TLS at a proxy that sets
`x-forwarded-proto` correctly, or serve HTTPS directly.

Requests that carry no credential (health, the plan catalogue, static assets) are unaffected.

## OTA with rollback

Rollback needs three things. The first two are code and are in place:

1. **A dual-app partition table** — `partitions_ota.csv`. A single-app layout cannot roll back at
   all, which is why `ENABLE_OTA_APPLY` defaults to `0` without it.
2. **Self-confirmation after boot** — `confirmFirmwareIfPendingVerify()` in `src/main.cpp`. The
   bootloader marks a newly flashed image `PENDING_VERIFY`; the firmware confirms it only after a
   **successful gateway heartbeat**. An image that boots but cannot reach the gateway is rolled
   back on the next reset instead of stranding the controller.
3. **Bootloader rollback enabled** — requires a bootloader actually built with
   `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`. The macro visible to an Arduino application is not
   proof of the prebuilt bootloader's behavior. On the CrowPanel hardware the distributed
   Arduino-ESP32 bootloader marked the first OTA boot `VALID`, so firmware also persists a boot
   attempt counter and returns to the other OTA slot after a pre-heartbeat restart. That fallback
   covers images that reach `DeviceStore::begin()`; a custom ESP-IDF bootloader is still required
   to recover failures earlier than application setup.

Build with OTA apply and signature enforcement on:

```bash
pio run -e crowpanel-esp32-213-epaper-secure
```

Publish signed release metadata from the gateway with `OTA_SIGNING_KEY` set:

```bash
npm run firmware:publish
```

### Rollback test — do this before shipping

Not automatable, and Phase 12 is not complete without it:

1. Flash a known-good build and let it heartbeat successfully.
2. Build a drill image with `AGENT_CONTROLLER_OTA_ROLLBACK_DRILL=1`; it restarts before networking.
3. Let the device apply it.
4. Confirm the device selects the previous slot on its second boot, heartbeats again, and reports
   `rolled_back`. A bootloader-level drill must separately use an image that fails before setup.

Until both application-level and custom-bootloader drills pass on real hardware, do not represent
early-boot rollback as production-complete.

## Secure boot and flash encryption

The roadmap says "where practical". These are **eFuse operations and are irreversible**. The build
configuration is provided; the key ceremony is not, and must not be scripted casually.

Before enabling, decide and write down:

- Where the signing key lives (an HSM or offline media — never the repository, never CI logs).
- Who can sign a release, and how that authority is revoked.
- Whether you can still service a returned unit once JTAG and UART download are restricted.
- Your recovery story for a unit that fails signature verification in the field.

Only then follow Espressif's ESP32-S3 secure boot v2 and flash encryption procedures. Enable flash
encryption in **release** mode for production units; development mode leaves the device
re-flashable and is not a production posture.

A unit with secure boot burned cannot run an unsigned image, including your own debug builds. Keep
a separate unfused development unit.

## What the gateway already enforces

- Per-device credentials, stored only as SHA-256 hashes and compared with `timingSafeEqual`
- Secret rotation, transfer reset, and revocation, all audited
- T3 access tokens sealed with AES-256-GCM at rest
- Signed firmware release manifests (`OTA_SIGNING_KEY`)
- Firmware version tracking per device
- Rate limits per user, device, and factory client
- Redaction of secrets, claim codes, transcripts, and vision descriptions from support bundles
