import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClerkAuthenticator } from "./clerkAuth.mjs";
import { loadConfig } from "./config.mjs";
import { buildDeviceDisplayState, buildUserDisplayState } from "./displayState.mjs";
import { createEventBroker } from "./events.mjs";
import {
  HttpError,
  optionalString,
  parseJsonBody,
  readJson,
  readRawBody,
  requireString,
  sendBuffer,
  sendError,
  sendJson,
} from "./http.mjs";
import { normalizeIntent } from "./intent.mjs";
import {
  buildDeviceClaimUrl,
  buildDeviceLabelSvg,
  buildFirmwareManifest,
  buildFlashConfig,
  buildNvsSeedCsv,
  claimLabelFilename,
  isNewerVersion,
  normalizeFirmwareRelease,
} from "./manufacturing.mjs";
import { verifyMediaAccessToken } from "./mediaLinks.mjs";
import {
  buildMediaAttachments,
  deleteStoredMedia,
  readStoredMedia,
  storeUploadedMedia,
  transcribeStoredAudio,
} from "./mediaStore.mjs";
import { buildUserObservabilitySummary } from "./observability.mjs";
import {
  checkResourceLimit,
  effectiveTier,
  entitlementsFor,
  listPlans,
  normalizeSubscription,
} from "./billing.mjs";
import { evaluateAlerts, summarizeAlerts } from "./alerts.mjs";
import { buildBetaReadiness } from "./betaReadiness.mjs";
import { describeStoredImage } from "./vision.mjs";
import { classifyNetworkLocation } from "./networkTrust.mjs";
import { buildOnboardingReadiness, normalizeOnboarding } from "./onboarding.mjs";
import { evaluateIntentPolicy } from "./policy.mjs";
import {
  isKnownDeviceProfile,
  listDeviceProfiles,
  normalizeDeviceProfile,
  validateCustomProfile,
} from "./profiles.mjs";
import { createRateLimiter } from "./rateLimit.mjs";
import { createSnapshotPoller } from "./snapshotPoller.mjs";
import { createStore } from "./store.mjs";
import { assertSecureTransport } from "./transport.mjs";
import {
  TERMINAL_SCOPE,
  environmentHasTerminalScope,
  fetchProviderCatalogue,
  writeTerminalInput,
} from "./t3Ws.mjs";
import {
  buildProviderCatalogue,
  extractHarnesses,
  extractSessionFailures,
  resolveModelSelection,
  usableHarnesses,
  validateModelSelection,
} from "./t3Harness.mjs";
import {
  buildT3Command,
  buildT3ProjectLaunchCommands,
  compressSnapshot,
  dispatchT3Command,
  exchangePairingToken,
  fetchT3Snapshot,
  isEnvironmentTokenExpired,
} from "./t3Client.mjs";

const STANDARD_T3_SCOPES = ["orchestration:read", "orchestration:operate"];
const BILLING_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = join(__dirname, "..", "dist", "web");

export function createApp({
  store = null,
  config = loadConfig(),
  rateLimiter = createRateLimiter(),
  clerkAuth = createClerkAuthenticator(config),
} = {}) {
  store ??= createStore({}, { t3TokenEncryptionKey: config.t3TokenEncryptionKey });
  const events = createEventBroker();
  // The memory and file stores hand back a full snapshot; the Convex store can only name the
  // user whose data changed. Both end up as a state.changed event for that user.
  store.subscribe((change) => {
    if (change && Array.isArray(change.users)) {
      events.broadcastStateChange(change);
      return;
    }
    if (change?.userId) events.broadcastUserChange(change.userId, { action: change.action ?? null });
  });
  const snapshotPoller = createSnapshotPoller({
    store,
    events,
    ...(config.snapshotPollIntervalMs ? { intervalMs: config.snapshotPollIntervalMs } : {}),
  });

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && isWebStaticRoute(url.pathname)) {
        return await serveWebStatic(res, url.pathname);
      }

      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        return sendBuffer(res, 204, Buffer.alloc(0), { "content-type": "image/x-icon" });
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, service: "agent-controller", demoMode: config.demoMode });
      }

      if (req.method === "GET" && url.pathname === "/v1/auth/config") {
        return sendJson(res, 200, {
          authProvider: config.authProvider,
          demoMode: config.demoMode,
          developmentTokens: {
            enabled: isDevTokenCreationEnabled(config),
          },
          clerk: {
            enabled: config.authProvider === "clerk" && Boolean(config.clerkPublishableKey),
            publishableKey: config.authProvider === "clerk" ? config.clerkPublishableKey : null,
          },
        });
      }

      // Profile editor (roadmap Phase 8). Built-ins are code; custom profiles are user-scoped.
      if (req.method === "POST" && url.pathname === "/v1/device-profiles") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const candidate = validateCustomProfile({
          id: optionalString(body.profileId) ?? optionalString(body.id),
          label: optionalString(body.label),
          description: optionalString(body.description),
          capabilities: body.capabilities,
        });
        if (!candidate.valid) throw new HttpError(400, candidate.reason);
        if (isKnownDeviceProfile(candidate.profile.id)) {
          throw new HttpError(409, `"${candidate.profile.id}" is a built-in profile id.`);
        }
        const created = await store.createDeviceProfile({
          userId: user.id,
          profileId: candidate.profile.id,
          label: candidate.profile.label,
          description: candidate.profile.description,
          capabilities: candidate.profile.capabilities,
        });
        if (!created) throw new HttpError(409, `Profile "${candidate.profile.id}" already exists.`);
        return sendJson(res, 201, { profile: toPublicProfile(created) });
      }

      const deviceProfileMatch2 = url.pathname.match(/^\/v1\/device-profiles\/([^/]+)$/u);
      if (req.method === "PUT" && deviceProfileMatch2) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const profileId = deviceProfileMatch2[1];
        if (isKnownDeviceProfile(profileId)) {
          throw new HttpError(403, "Built-in profiles cannot be edited.");
        }
        const body = await readJson(req);
        if (body.capabilities !== undefined) {
          const candidate = validateCustomProfile({ id: profileId, capabilities: body.capabilities });
          if (!candidate.valid) throw new HttpError(400, candidate.reason);
        }
        const updated = await store.updateDeviceProfileDefinition({
          userId: user.id,
          profileId,
          ...(body.label !== undefined ? { label: requireString(body.label, "label") } : {}),
          ...(body.description !== undefined ? { description: String(body.description) } : {}),
          ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
        });
        if (!updated) throw new HttpError(404, "Device profile not found.");
        return sendJson(res, 200, { profile: toPublicProfile(updated) });
      }

      if (req.method === "DELETE" && deviceProfileMatch2) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const profileId = deviceProfileMatch2[1];
        if (isKnownDeviceProfile(profileId)) {
          throw new HttpError(403, "Built-in profiles cannot be deleted.");
        }
        const devices = await store.listDevices(user.id);
        const inUse = devices.filter((device) => device.profile === profileId && !device.revokedAt);
        if (inUse.length > 0) {
          throw new HttpError(409, "This profile is still assigned to a device.", {
            deviceIds: inUse.map((device) => device.id),
          });
        }
        const deleted = await store.deleteDeviceProfile({ userId: user.id, profileId });
        if (!deleted) throw new HttpError(404, "Device profile not found.");
        return sendJson(res, 200, { profile: toPublicProfile(deleted) });
      }

      if (req.method === "GET" && url.pathname === "/v1/device-profiles") {
        const builtins = listDeviceProfiles().map((profile) => ({ ...profile, builtin: true }));
        // Stays public for the unauthenticated onboarding step; credentials additionally reveal
        // the caller's own custom profiles.
        let custom = [];
        try {
          const user = await authenticateUser(req, store, config, null, clerkAuth);
          custom = (await store.listUserDeviceProfiles?.(user.id) ?? []).map(toPublicProfile);
        } catch {
          custom = [];
        }
        return sendJson(res, 200, { profiles: [...builtins, ...custom] });
      }

      if (req.method === "POST" && url.pathname === "/v1/users/dev") {
        if (!isDevTokenCreationEnabled(config)) {
          throw new HttpError(403, "Development token creation is disabled.");
        }
        await enforceRateLimit(req, res, rateLimiter, config, {
          scope: "auth",
          actorId: clientKey(req),
          limit: config.rateLimits?.auth,
        });
        const body = await readJson(req);
        const user = await store.ensureUser({
          userId: optionalString(body.userId) ?? "user_dev",
          email: optionalString(body.email) ?? "dev@example.local",
        });
        const apiToken = await store.createUserToken({
          userId: user.id,
          label: optionalString(body.tokenLabel) ?? "Development token",
        });
        return sendJson(res, 201, { user, apiToken });
      }

      if (req.method === "POST" && url.pathname === "/v1/factory/devices") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const body = await readJson(req);
        const profile = requireDeviceProfile(body.profile);
        const result = await store.preprovisionDevice({
          label: requireString(body.label, "label"),
          profile,
        });
        const gatewayBaseUrl = optionalString(body.gatewayBaseUrl)
          ?? config.publicBaseUrl
          ?? requestBaseUrl(req);
        // Claim codes are stored hashed, so this response is the only point at which a scannable
        // label can be produced for this device. The device secret is likewise returned once, which
        // is why the NVS seed has to be built here too rather than reconstructed later.
        return sendJson(res, 201, {
          ...result,
          ...claimLabelFor(result, { gatewayBaseUrl }),
          nvsSeedFilename: `${result.device.id}.nvs.csv`,
          nvsSeed: buildNvsSeedCsv({
            deviceId: result.device.id,
            deviceSecret: result.secret,
            gatewayBaseUrl,
            claimCode: result.claimCode,
            claimCodeExpiresAt: result.device.claimCodeExpiresAt,
          }),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/factory/batches") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const body = await readJson(req);
        const count = requireCount(body.count);
        const labelPrefix = optionalString(body.labelPrefix) ?? "Agent Controller";
        const profile = requireDeviceProfile(body.profile);
        const gatewayBaseUrl = optionalString(body.gatewayBaseUrl)
          ?? config.publicBaseUrl
          ?? requestBaseUrl(req);
        const hardwareModel = optionalString(body.hardwareModel) ?? config.defaultHardwareModel;
        const firmwareVersion = optionalString(body.firmwareVersion) ?? "0.1.0";
        const devices = [];
        for (let index = 0; index < count; index += 1) {
          const label = count === 1 ? labelPrefix : `${labelPrefix} ${String(index + 1).padStart(3, "0")}`;
          const result = await store.preprovisionDevice({ label, profile });
          devices.push({
            ...result,
            ...claimLabelFor(result, { gatewayBaseUrl }),
            // The NVS seed is the production path: one signed image per batch, identity varied
            // by a small data partition. The header stays for bench builds.
            nvsSeedFilename: `${result.device.id}.nvs.csv`,
            nvsSeed: buildNvsSeedCsv({
              deviceId: result.device.id,
              deviceSecret: result.secret,
              gatewayBaseUrl,
              claimCode: result.claimCode,
              claimCodeExpiresAt: result.device.claimCodeExpiresAt,
            }),
            flashConfigFilename: `${result.device.id}.controller_config.h`,
            flashConfig: buildFlashConfig({
              gatewayBaseUrl,
              deviceId: result.device.id,
              deviceSecret: result.secret,
              environmentId: optionalString(body.environmentId) ?? "env_replace_me",
              threadId: optionalString(body.threadId) ?? "thread_replace_me",
              defaultPrompt: optionalString(body.defaultPrompt)
                ?? "Continue the current task, inspect progress, and run relevant tests.",
              shellCommand: optionalString(body.shellCommand) ?? "npm test",
              hardwareModel,
              firmwareVersion,
              enableOtaApply: body.enableOtaApply === true,
              requireOtaSignature: body.requireOtaSignature === true,
              otaManifestVerifyKey: optionalString(body.otaManifestVerifyKey) ?? "",
            }),
          });
        }
        return sendJson(res, 201, {
          batch: {
            count,
            profile,
            gatewayBaseUrl,
            hardwareModel,
            firmwareVersion,
            enableOtaApply: body.enableOtaApply === true,
            requireOtaSignature: body.requireOtaSignature === true,
          },
          devices,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/factory/firmware/releases") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const signingKey = requireOtaSigningKey(config);
        const body = await readJson(req);
        const input = parseFirmwareRelease(body);
        const release = await store.createFirmwareRelease(input);
        return sendJson(res, 201, {
          release,
          manifest: buildFirmwareManifest(release, signingKey),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/factory/firmware/releases") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const hardwareModel = optionalString(url.searchParams.get("hardwareModel"));
        return sendJson(res, 200, {
          releases: await store.listFirmwareReleases({ hardwareModel }),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/devices") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        await assertWithinPlan(store, user.id, "devices", config);
        const profile = await requireOwnedDeviceProfile(store, user.id, body.profile);
        assertSecureTransport(req, config, "Device secret delivery");
        const result = await store.createDevice({
          userId: user.id,
          label: requireString(body.label, "label"),
          profile,
        });
        return sendJson(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/devices/claim") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        await assertWithinPlan(store, user.id, "devices", config);
        assertSecureTransport(req, config, "Device secret delivery");
        const device = await store.claimDevice({
          userId: user.id,
          claimCode: requireString(body.claimCode, "claimCode"),
          label: optionalString(body.label),
        });
        if (!device) throw new HttpError(404, "Claim code is invalid, expired, or already used.");
        return sendJson(res, 200, { device });
      }

      const deviceActionMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(revoke|rotate-secret|transfer-reset)$/u);
      if (req.method === "POST" && deviceActionMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const [, deviceId, action] = deviceActionMatch;
        if (action === "revoke") {
          const device = await store.revokeDevice({ userId: user.id, deviceId });
          if (!device) throw new HttpError(404, "Device not found.");
          return sendJson(res, 200, { device });
        }
        if (action === "transfer-reset") {
          const body = await readJson(req);
          assertSecureTransport(req, config, "Device secret delivery");
          const result = await store.resetDeviceForTransfer({
            userId: user.id,
            deviceId,
            label: optionalString(body.label),
          });
          if (!result) throw new HttpError(404, "Device not found or revoked.");
          return sendJson(res, 200, result);
        }
        assertSecureTransport(req, config, "Device secret delivery");
        const result = await store.rotateDeviceSecret({ userId: user.id, deviceId });
        if (!result) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, result);
      }

      // Permanently removes a revoked device from the inventory. Revocation first is deliberate:
      // it kills the credential, so the record can go without leaving hardware in the field that
      // still authenticates against a device the owner can no longer see.
      const deviceDeleteMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/u);
      if (req.method === "DELETE" && deviceDeleteMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const result = await store.deleteDevice({ userId: user.id, deviceId: deviceDeleteMatch[1] });
        if (!result) throw new HttpError(404, "Device not found.");
        if (result.reason === "not_revoked") {
          throw new HttpError(409, "Revoke the device before deleting it.");
        }
        return sendJson(res, 200, { device: result.device, deleted: true });
      }

      const deviceConfigMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/config$/u);
      if (deviceConfigMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceConfigMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: device.id, config: device.config });
      }

      if (deviceConfigMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const environmentId = optionalString(body.environmentId);
        if (environmentId && !(await store.getEnvironmentForUser(user.id, environmentId))) {
          throw new HttpError(404, "Environment not found.");
        }
        const device = await store.updateDeviceConfig({
          userId: user.id,
          deviceId: deviceConfigMatch[1],
          config: body,
        });
        if (!device) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: device.id, config: device.config, device });
      }

      const deviceProfileMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/profile$/u);
      if (deviceProfileMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const profile = await requireOwnedDeviceProfile(store, user.id, body.profile);
        const device = await store.updateDeviceProfile({
          userId: user.id,
          deviceId: deviceProfileMatch[1],
          profile,
        });
        if (!device) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, { device });
      }

      if (req.method === "GET" && url.pathname === "/v1/devices") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { devices: await store.listDevices(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/t3/environments") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        if (!optionalString(body.id)) await assertWithinPlan(store, user.id, "environments", config);
        const baseUrl = requireString(body.baseUrl, "baseUrl");
        const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
          ? body.scopes.map((scope) => requireString(scope, "scope"))
          : STANDARD_T3_SCOPES;
        const tokenResponse = optionalString(body.accessToken)
          ? null
          : await exchangePairingToken({
            baseUrl,
            pairingToken: requireString(body.pairingToken, "pairingToken"),
            scopes,
          });
        const accessToken = optionalString(body.accessToken) ?? tokenResponse.access_token;
        const accessTokenExpiresAt = tokenResponse
          ? tokenExpiresAt(tokenResponse)
          : optionalString(body.accessTokenExpiresAt);
        const environment = await store.upsertEnvironment({
          userId: user.id,
          label: optionalString(body.label) ?? "T3 Code",
          baseUrl,
          accessToken,
          accessTokenExpiresAt,
          scopes,
          status: "paired",
        });
        return sendJson(res, 201, { environment });
      }

      if (req.method === "GET" && url.pathname === "/v1/t3/environments") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { environments: await store.listEnvironments(user.id) });
      }

      const environmentMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)$/u);
      if (environmentMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const current = await store.getEnvironmentForUser(user.id, environmentMatch[1]);
        if (!current) throw new HttpError(404, "Environment not found.");
        const body = await readJson(req);
        const baseUrl = optionalString(body.baseUrl) ?? current.baseUrl;
        const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
          ? body.scopes.map((scope) => requireString(scope, "scope"))
          : current.scopes;
        const tokenResponse = optionalString(body.pairingToken)
          ? await exchangePairingToken({
            baseUrl,
            pairingToken: requireString(body.pairingToken, "pairingToken"),
            scopes,
          })
          : null;
        const accessToken = optionalString(body.accessToken)
          ?? tokenResponse?.access_token
          ?? current.accessToken;
        const accessTokenExpiresAt = tokenResponse
          ? tokenExpiresAt(tokenResponse)
          : (Object.hasOwn(body, "accessTokenExpiresAt")
            ? optionalString(body.accessTokenExpiresAt)
            : current.accessTokenExpiresAt);
        const environment = await store.upsertEnvironment({
          id: current.id,
          userId: user.id,
          label: optionalString(body.label) ?? current.label,
          baseUrl,
          accessToken,
          accessTokenExpiresAt,
          scopes,
          status: "paired",
          health: current.health,
          createdAt: current.createdAt,
        });
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, { environment });
      }

      if (environmentMatch && req.method === "DELETE") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const environment = await store.deleteEnvironment({ userId: user.id, environmentId: environmentMatch[1] });
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, { environment });
      }

      const environmentCheckMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/check$/u);
      if (req.method === "POST" && environmentCheckMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentCheckMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, await checkEnvironmentHealth({ store, userId: user.id, environment }));
      }

      const environmentSnapshotMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/snapshot$/u);
      if (req.method === "GET" && environmentSnapshotMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentSnapshotMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        try {
          assertEnvironmentTokenActive(environment);
          const snapshot = await fetchT3Snapshot({ ...environment, timeoutMs: 5000 });
          const screen = compressSnapshot(snapshot);
          const checkedAt = new Date().toISOString();
          const updated = await store.updateEnvironmentHealth({
            userId: user.id,
            environmentId: environment.id,
            status: "reachable",
            health: {
              lastCheckedAt: checkedAt,
              lastReachableAt: checkedAt,
              lastError: null,
              snapshot: screen,
            },
          });
          const harnesses = extractHarnesses(snapshot, { catalogue: environment.providerCatalogue });
          return sendJson(res, 200, {
            environment: updated,
            snapshot,
            screen,
            harnesses,
            modelSelection: resolveModelSelection({ harnesses }),
            // T3 accepts a dispatch and only then rejects a bad model, so a failing session is
            // the only place that failure is visible.
            sessionFailures: extractSessionFailures(snapshot),
          });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          const message = error?.message || "T3 snapshot is unavailable.";
          const checkedAt = new Date().toISOString();
          const updated = await store.updateEnvironmentHealth({
            userId: user.id,
            environmentId: environment.id,
            status: "unreachable",
            health: {
              lastCheckedAt: checkedAt,
              lastError: message,
            },
          });
          throw new HttpError(502, "T3 snapshot is unavailable.", { environment: updated, cause: message });
        }
      }

      // The T3 orchestration API carries no provider catalogue, so the host registers it here.
      // scripts/setup-t3.mjs runs on the T3 machine and reads <base-dir>/caches/*.json.
      const environmentCatalogueMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/catalogue$/u);
      if (req.method === "PUT" && environmentCatalogueMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const entries = Array.isArray(body.instances) ? body.instances : body.providers;
        if (!Array.isArray(entries)) {
          throw new HttpError(400, "instances must be an array of T3 provider status records.");
        }
        const catalogue = buildProviderCatalogue(entries, {
          source: optionalString(body.source) ?? "setup-script",
        });
        if (catalogue.instances.length === 0) {
          throw new HttpError(400, "No usable provider instances were supplied.");
        }
        const environment = await store.updateEnvironmentCatalogue({
          userId: user.id,
          environmentId: environmentCatalogueMatch[1],
          catalogue,
        });
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, { environment, catalogue });
      }

      if (req.method === "GET" && environmentCatalogueMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentCatalogueMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, { catalogue: environment.providerCatalogue ?? null });
      }

      // The agent harnesses and models this environment can actually launch, read live from T3
      // rather than from a hardcoded table.
      const environmentHarnessMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/harnesses$/u);
      if (req.method === "GET" && environmentHarnessMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentHarnessMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        let snapshot;
        try {
          snapshot = await fetchT3Snapshot({ ...environment, timeoutMs: 5000 });
        } catch (error) {
          throw new HttpError(502, "T3 snapshot is unavailable.", { cause: errorMessage(error) });
        }
        // Prefer the catalogue read live from T3 over the socket; fall back to one registered by
        // the setup script, then to whatever the snapshot revealed.
        let catalogue = null;
        let catalogueSource = environment.providerCatalogue ? "registered" : "snapshot-only";
        try {
          const providers = await fetchProviderCatalogue(environment, { timeoutMs: 8000 });
          catalogue = buildProviderCatalogue(providers, { source: "t3-websocket" });
          catalogueSource = "live";
        } catch {
          catalogue = environment.providerCatalogue ?? null;
        }
        const harnesses = extractHarnesses(snapshot, { catalogue });
        return sendJson(res, 200, {
          harnesses,
          usable: usableHarnesses(harnesses).map((harness) => harness.instanceId),
          modelSelection: resolveModelSelection({ harnesses }),
          sessionFailures: extractSessionFailures(snapshot),
          catalogueSource,
        });
      }

      const environmentThreadsMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/threads$/u);
      if (req.method === "POST" && environmentThreadsMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentThreadsMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        const body = await readJson(req);
        const projectId = requireString(body.projectId, "projectId");
        const text = optionalString(body.text) ?? "Open this project and report that the session is ready.";
        const snapshot = await fetchT3Snapshot({ ...environment, timeoutMs: 5000 });
        const project = snapshot.projects?.find((candidate) => candidate.id === projectId);
        if (!project) throw new HttpError(404, "T3 project not found.");
        const modelSelection = normalizeT3ModelSelection(body.modelSelection)
          ?? normalizeT3ModelSelection(project.defaultModelSelection);
        if (!modelSelection) {
          throw new HttpError(409, "Select a provider instance and model before launching this project.");
        }
        // T3 accepts the dispatch and only then has the provider reject an unknown model, which
        // leaves the command stuck looking successful. Refuse the bad pair before it is sent.
        const harnesses = extractHarnesses(snapshot, { catalogue: environment.providerCatalogue });
        const invalid = validateModelSelection(modelSelection, harnesses);
        if (invalid) {
          throw new HttpError(422, invalid.reason, {
            modelSelection,
            ...(invalid.known ? { known: invalid.known } : {}),
            catalogueSource: environment.providerCatalogue ? "registered" : "snapshot-only",
          });
        }
        const startedAt = Date.now();
        const launch = buildT3ProjectLaunchCommands({
          project,
          text,
          modelSelection,
          runtimeMode: normalizeT3RuntimeMode(body.runtimeMode),
          interactionMode: normalizeT3InteractionMode(body.interactionMode),
        });
        const dispatchStartedAt = Date.now();
        let result;
        try {
          const createResult = await dispatchT3Command(environment, launch.createThread);
          const turnResult = await dispatchT3Command(environment, launch.startTurn);
          result = { createThread: createResult, startTurn: turnResult };
        } catch (error) {
          const command = await store.createCommand({
            userId: user.id,
            deviceId: null,
            environmentId: environment.id,
            threadId: launch.threadId,
            intent: { type: "agent_prompt", text },
            normalized: { type: "thread.launch", ...launch },
            status: "failed",
            risk: "medium",
            result: t3FailureResult(error),
            metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true }),
          });
          throw new HttpError(502, "T3 project launch failed.", {
            command,
            cause: errorMessage(error),
          });
        }
        const command = await store.createCommand({
          userId: user.id,
          deviceId: null,
          environmentId: environment.id,
          threadId: launch.threadId,
          intent: { type: "agent_prompt", text },
          normalized: { type: "thread.launch", ...launch },
          status: "dispatched",
          risk: "medium",
          result,
          metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
        });
        return sendJson(res, 202, {
          project,
          threadId: launch.threadId,
          modelSelection,
          command,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/audit") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { events: await store.listAuditLogs(user.id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/commands") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { commands: await store.listCommands(user.id) });
      }

      const commandEventsMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/events$/u);
      if (req.method === "GET" && commandEventsMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const commandId = commandEventsMatch[1];
        const command = await store.getCommandForUser(user.id, commandId);
        if (!command) throw new HttpError(404, "Command not found.");
        return sendJson(res, 200, {
          command,
          events: await store.listCommandEvents({ userId: user.id, commandId }),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/macros") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { macros: await store.listMacros(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/macros") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const input = normalizeMacroInput(body);
        if (input.environmentId && !(await store.getEnvironmentForUser(user.id, input.environmentId))) {
          throw new HttpError(404, "Environment not found.");
        }
        const macro = await store.createMacro({ userId: user.id, ...input });
        return sendJson(res, 201, { macro });
      }

      if (req.method === "GET" && url.pathname === "/v1/support/diagnostics") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, await buildSupportDiagnosticsBundle({ store, user }));
      }

      if (req.method === "GET" && url.pathname === "/v1/observability/beta-readiness") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const [devices, commands] = await Promise.all([
          store.listDevices(user.id),
          store.listCommands(user.id),
        ]);
        return sendJson(res, 200, buildBetaReadiness({ devices, commands }));
      }

      if (req.method === "GET" && url.pathname === "/v1/observability/alerts") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const summary = await buildUserObservabilitySummary(store, user.id);
        const alerts = evaluateAlerts(summary, config.alertThresholds);
        return sendJson(res, 200, {
          generatedAt: summary.generatedAt,
          alerts,
          summary: summarizeAlerts(alerts),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/observability/summary") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const summary = await buildUserObservabilitySummary(store, user.id);
        const alerts = evaluateAlerts(summary, config.alertThresholds);
        return sendJson(res, 200, { summary, alerts, alertSummary: summarizeAlerts(alerts) });
      }

      if (req.method === "GET" && url.pathname === "/v1/billing/plans") {
        return sendJson(res, 200, { plans: listPlans() });
      }

      if (req.method === "GET" && url.pathname === "/v1/billing/subscription") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const subscription = await store.getUserSubscription?.(user.id);
        return sendJson(res, 200, {
          subscription: subscription ?? null,
          entitlements: entitlementsFor(subscription),
          usage: await currentUsage(store, user.id),
        });
      }

      // Providers call this with their own signature; there is no platform session involved.
      if (req.method === "POST" && url.pathname === "/v1/billing/webhook") {
        await enforceRateLimit(req, res, rateLimiter, config, {
          scope: "billing:webhook",
          actorId: clientKey(req),
          limit: config.rateLimits?.factoryWrite,
        });
        const raw = await readRawBody(req);
        verifyBillingSignature(req, raw, config);
        const event = parseJsonBody(raw);
        const userId = requireString(event.userId, "userId");
        const updated = await store.updateUserSubscription?.({
          userId,
          ...normalizeSubscription(event.subscription ?? event),
        });
        if (!updated) throw new HttpError(404, "Unknown billing subject.");
        return sendJson(res, 200, { subscription: updated });
      }

      if (req.method === "GET" && url.pathname === "/v1/settings/privacy") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { privacy: await store.getUserPrivacySettings(user.id) });
      }

      if (req.method === "PUT" && url.pathname === "/v1/settings/privacy") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const privacy = await store.updateUserPrivacySettings({
          userId: user.id,
          privacy: normalizePrivacySettingsInput(body),
        });
        return sendJson(res, 200, { privacy });
      }

      if (req.method === "GET" && url.pathname === "/v1/onboarding") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const onboarding = await store.getUserOnboarding(user.id);
        return sendJson(res, 200, await onboardingResponse(store, user.id, onboarding));
      }

      if (req.method === "PUT" && url.pathname === "/v1/onboarding") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const current = await store.getUserOnboarding(user.id);
        const candidate = normalizeOnboarding(body, current);
        if (candidate.environmentId
          && !(await store.getEnvironmentForUser(user.id, candidate.environmentId))) {
          throw new HttpError(404, "Onboarding environment not found.");
        }
        if (candidate.device.deviceId
          && !(await store.getDeviceForUser(user.id, candidate.device.deviceId))) {
          throw new HttpError(404, "Onboarding device not found.");
        }
        const candidateResponse = await onboardingResponse(store, user.id, candidate);
        if (candidate.status === "completed" && !candidateResponse.readiness.ready) {
          throw new HttpError(409, "Complete every required onboarding step first.", {
            readiness: candidateResponse.readiness,
          });
        }
        const onboarding = await store.updateUserOnboarding({
          userId: user.id,
          onboarding: candidate,
        });
        return sendJson(res, 200, await onboardingResponse(store, user.id, onboarding));
      }

      const commandActionMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/(approve|reject)$/u);
      if (req.method === "POST" && commandActionMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const [, commandId, action] = commandActionMatch;
        const output = action === "approve"
          ? await approveCommand({ store, userId: user.id, commandId })
          : await rejectCommand({ store, userId: user.id, commandId });
        return sendJson(res, action === "approve" ? 202 : 200, output);
      }

      const macroActionMatch = url.pathname.match(/^\/v1\/macros\/([^/]+)(?:\/(run))?$/u);
      if (macroActionMatch && req.method === "DELETE" && !macroActionMatch[2]) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const macro = await store.deleteMacro({ userId: user.id, macroId: macroActionMatch[1] });
        if (!macro) throw new HttpError(404, "Macro not found.");
        return sendJson(res, 200, { macro });
      }

      if (macroActionMatch && req.method === "POST" && macroActionMatch[2] === "run") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const macro = await store.getMacroForUser(user.id, macroActionMatch[1]);
        if (!macro) throw new HttpError(404, "Macro not found.");
        const environmentId = requireString(
          optionalString(body.environmentId) ?? optionalString(macro.environmentId),
          "environmentId",
        );
        const environment = await store.getEnvironmentForUser(user.id, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const output = await submitIntent({
          store,
          environment,
          body: {
            environmentId,
            threadId: optionalString(body.threadId) ?? optionalString(macro.threadId),
            intent: macro.intent,
          },
          actor: { type: "user", id: user.id, userId: user.id, profile: "power-controller" },
          config,
          baseUrl: requestBaseUrl(req),
          policyContext: {
            user,
            networkLocation: classifyNetworkLocation(req, config),
            ...(config.billingEnforced
              ? { subscriptionTier: effectiveTier(await store.getUserSubscription?.(user.id)) }
              : {}),
          },
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, {
          macro,
          ...output,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/display") {
        const user = await authenticateUser(req, store, config, url, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { display: await buildUserDisplayState(store, user.id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/events") {
        const user = await authenticateUser(req, store, config, url, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        snapshotPoller.trackUser(user.id);
        return events.connect({ userId: user.id, res });
      }

      if (req.method === "GET" && url.pathname === "/v1/media") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { media: await store.listMediaUploads(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/media") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const media = await storeUploadedMedia({
          store,
          config,
          actor: { type: "user", id: user.id, userId: user.id },
          payload: body,
        });
        return sendJson(res, 201, { media });
      }

      // Signed, short-lived, single-media access so a paired T3 environment can fetch
      // attachment bytes without holding a platform session.
      const mediaContentMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/content$/u);
      if (req.method === "GET" && mediaContentMatch) {
        await enforceRateLimit(req, res, rateLimiter, config, {
          scope: "media-content",
          actorId: clientKey(req),
          limit: config.rateLimits?.deviceRead,
        });
        const claim = verifyMediaAccessToken({
          token: url.searchParams.get("token"),
          secret: config.mediaSigningKey,
        });
        if (!claim || claim.mediaId !== mediaContentMatch[1]) {
          throw new HttpError(403, "Invalid or expired media access token.");
        }
        const media = await store.getMediaForUser(claim.userId, claim.mediaId);
        if (!media) throw new HttpError(404, "Media upload not found.");
        const buffer = await readStoredMedia(media, config);
        return sendBuffer(res, 200, buffer, {
          "content-type": media.contentType,
          "cache-control": "private, no-store",
          "x-media-id": media.id,
          "x-media-sha256": media.sha256,
        });
      }

      const mediaTranscriptMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/transcript$/u);
      if (req.method === "PUT" && mediaTranscriptMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const media = await store.updateMediaTranscript({
          userId: user.id,
          mediaId: mediaTranscriptMatch[1],
          transcript: requireString(body.transcript, "transcript"),
        });
        if (!media) throw new HttpError(404, "Audio media upload not found.");
        return sendJson(res, 200, { media });
      }

      // Roadmap Phase 6's camera flow: upload -> OCR/vision -> prompt -> dispatch.
      const mediaDescribeMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/describe$/u);
      if (req.method === "POST" && mediaDescribeMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        return sendJson(res, 200, await describeStoredImage({
          store,
          config,
          userId: user.id,
          mediaId: mediaDescribeMatch[1],
        }));
      }

      const mediaTranscribeMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/transcribe$/u);
      if (req.method === "POST" && mediaTranscribeMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const result = await transcribeStoredAudio({
          store,
          config,
          userId: user.id,
          mediaId: mediaTranscribeMatch[1],
        });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/media/purge-expired") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        return sendJson(res, 200, await purgeExpiredMedia({ store, userId: user.id, config }));
      }

      const mediaMatch = url.pathname.match(/^\/v1\/media\/([^/]+)$/u);
      if (req.method === "GET" && mediaMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const media = await store.getMediaForUser(user.id, mediaMatch[1]);
        if (!media) throw new HttpError(404, "Media upload not found.");
        const buffer = await readStoredMedia(media, config);
        return sendBuffer(res, 200, buffer, {
          "content-type": media.contentType,
          "x-media-id": media.id,
          "x-media-sha256": media.sha256,
        });
      }

      if (req.method === "DELETE" && mediaMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const media = await store.getMediaForUser(user.id, mediaMatch[1]);
        if (!media) throw new HttpError(404, "Media upload not found.");
        await deleteStoredMedia(media, config);
        const deleted = await store.deleteMediaUpload({ userId: user.id, mediaId: media.id });
        return sendJson(res, 200, { media: deleted });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/heartbeat") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceHeartbeat(req, res, rateLimiter, config, device);
        snapshotPoller.trackUser(device.userId);
        const body = await readJson(req);
        const updatedDevice = await store.recordDeviceHeartbeat({
          deviceId: device.id,
          status: body.status ?? body,
        });
        return sendJson(res, 200, { ok: true, device: updatedDevice ?? device });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/setup-code") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        if (device.claimed || device.userId) {
          return sendJson(res, 200, {
            device,
            setup: {
              claimed: true,
              claimCode: null,
              instructions: "Device is already claimed.",
            },
          });
        }
        const body = await readJson(req).catch(() => ({}));
        const setup = await store.ensureUnclaimedDeviceClaimCode({
          deviceId: device.id,
          rotate: body?.rotate === true,
        });
        if (!setup) throw new HttpError(409, "Device cannot create a setup code.");
        // The existing code is still valid and its plaintext is unrecoverable by design, so the
        // device is told to keep showing the copy it cached. 200, not 201 — nothing was created.
        if (!setup.rotated) {
          return sendJson(res, 200, {
            device: setup.device,
            setup: {
              claimed: false,
              claimCode: null,
              rotated: false,
              claimCodeExpiresAt: setup.claimCodeExpiresAt ?? null,
              instructions: "The existing setup code is still valid. Display the cached code, or retry with {\"rotate\": true} to replace it.",
            },
            claimCode: null,
            claimCodeExpiresAt: setup.claimCodeExpiresAt ?? null,
          });
        }
        const label = claimLabelFor(setup, {
          gatewayBaseUrl: config.publicBaseUrl ?? requestBaseUrl(req),
        });
        return sendJson(res, 201, {
          device: setup.device,
          setup: {
            claimed: false,
            claimCode: setup.claimCode,
            rotated: true,
            claimCodeExpiresAt: setup.claimCodeExpiresAt ?? null,
            claimUrl: label.claimUrl ?? null,
            instructions: "Sign in to the Agent Controller dashboard and claim this device with the displayed code.",
          },
          claimCode: setup.claimCode,
          claimCodeExpiresAt: setup.claimCodeExpiresAt ?? null,
          ...label,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/display") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, {
          display: await buildDeviceDisplayState(store, device, {
            environmentId: optionalString(url.searchParams.get("environmentId"))
              ?? optionalString(device.config?.environmentId)
              ?? null,
          }),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/config") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, { deviceId: device.id, config: device.config });
      }

      // Threads the device may switch to. Deliberately scoped to the environment the
      // owner bound in device.config: the owner keeps the meaningful boundary, and the
      // hardware gets to pick within it. compressSnapshot() throws thread identity away
      // for the display payload, so this returns the real ids the device needs.
      if (req.method === "GET" && url.pathname === "/v1/device/threads") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const environment = await boundDeviceEnvironment(store, device);
        const snapshot = await fetchT3Snapshot(environment);
        return sendJson(res, 200, {
          environmentId: environment.id,
          threadId: device.config?.threadId ?? null,
          threads: deviceSelectableThreads(snapshot),
        });
      }

      // The one piece of its own config a device may write. Anything else stays
      // owner-only: this cannot repoint the device at another environment, change its
      // profile, or widen its menu.
      if (req.method === "POST" && url.pathname === "/v1/device/config/thread") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const threadId = requireString(body.threadId, "threadId");
        const environment = await boundDeviceEnvironment(store, device);
        const snapshot = await fetchT3Snapshot(environment);
        const threads = deviceSelectableThreads(snapshot);
        // Validated against the live snapshot, so a device cannot invent a thread id
        // or reach one belonging to a different environment.
        if (!threads.some((thread) => thread.id === threadId)) {
          throw new HttpError(404, "Thread not found in the bound environment.");
        }
        const updated = await store.updateDeviceConfig({
          userId: device.userId,
          deviceId: device.id,
          config: { threadId },
          actorType: "device",
          actorId: device.id,
        });
        if (!updated) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: updated.id, config: updated.config });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/firmware") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const signingKey = requireOtaSigningKey(config);
        const currentVersion = optionalString(url.searchParams.get("version")) ?? "0.0.0";
        const hardwareModel = optionalString(url.searchParams.get("hardware"))
          ?? optionalString(req.headers["x-hardware-model"])
          ?? config.defaultHardwareModel;
        const release = await store.getLatestFirmwareRelease({ hardwareModel });
        if (!release) {
          return sendJson(res, 200, {
            updateAvailable: false,
            currentVersion,
            hardwareModel,
            reason: "no_release",
          });
        }
        if (!isNewerVersion(release.version, currentVersion)) {
          return sendJson(res, 200, {
            updateAvailable: false,
            currentVersion,
            hardwareModel,
            latestVersion: release.version,
            reason: "current",
          });
        }
        return sendJson(res, 200, {
          updateAvailable: true,
          currentVersion,
          hardwareModel,
          manifest: buildFirmwareManifest(release, signingKey),
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/events") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return events.connect({ userId: device.userId, res });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/approvals") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const commands = await store.listCommands(device.userId);
        return sendJson(res, 200, {
          commands: commands.filter((command) => command.status === "approval_required"),
        });
      }

      const deviceApprovalMatch = url.pathname.match(/^\/v1\/device\/approvals\/([^/]+)\/(approve|reject)$/u);
      if (req.method === "POST" && deviceApprovalMatch) {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const [, commandId, action] = deviceApprovalMatch;
        const output = action === "approve"
          ? await approveCommand({ store, userId: device.userId, commandId })
          : await rejectCommand({ store, userId: device.userId, commandId });
        return sendJson(res, action === "approve" ? 202 : 200, output);
      }

      if (req.method === "GET" && url.pathname === "/v1/device/macros") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, { macros: await store.listMacros(device.userId) });
      }

      const deviceMacroRunMatch = url.pathname.match(/^\/v1\/device\/macros\/([^/]+)\/run$/u);
      if (req.method === "POST" && deviceMacroRunMatch) {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const macro = await store.getMacroForUser(device.userId, deviceMacroRunMatch[1]);
        if (!macro) throw new HttpError(404, "Macro not found.");
        const environmentId = requireString(
          optionalString(body.environmentId)
            ?? optionalString(macro.environmentId)
            ?? optionalString(device.config?.environmentId),
          "environmentId",
        );
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const output = await submitIntent({
          store,
          environment,
          body: {
            environmentId,
            threadId: optionalString(body.threadId)
              ?? optionalString(macro.threadId)
              ?? optionalString(device.config?.threadId),
            intent: macro.intent,
          },
          actor: { type: "device", id: device.id, userId: device.userId, profile: device.profile },
          config,
          baseUrl: requestBaseUrl(req),
          policyContext: { networkLocation: classifyNetworkLocation(req, config) },
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, {
          macro,
          ...output,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/media") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const media = await storeUploadedMedia({
          store,
          config,
          actor: { type: "device", id: device.id, userId: device.userId },
          payload: body,
        });
        return sendJson(res, 201, { media });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/state") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const environmentId = requireString(url.searchParams.get("environmentId"), "environmentId");
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        const snapshot = await fetchT3Snapshot(environment);
        return sendJson(res, 200, { device, environmentId, screen: compressSnapshot(snapshot) });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/intents") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const environmentId = requireString(
          optionalString(body.environmentId) ?? optionalString(device.config?.environmentId),
          "environmentId",
        );
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");

        return sendJson(
          res,
          200,
          await submitIntent({
            store,
            environment,
            body: {
              ...body,
              environmentId,
              threadId: optionalString(body.threadId) ?? optionalString(device.config?.threadId),
            },
            actor: { type: "device", id: device.id, userId: device.userId, profile: device.profile },
            config,
            baseUrl: requestBaseUrl(req),
            policyContext: { networkLocation: classifyNetworkLocation(req, config) },
          }),
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/intents") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const environmentId = requireString(body.environmentId, "environmentId");
        const environment = await store.getEnvironmentForUser(user.id, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const output = await submitIntent({
          store,
          environment,
          body,
          actor: { type: "user", id: user.id, userId: user.id, profile: "power-controller" },
          config,
          baseUrl: requestBaseUrl(req),
          policyContext: {
            user,
            networkLocation: classifyNetworkLocation(req, config),
            ...(config.billingEnforced
              ? { subscriptionTier: effectiveTier(await store.getUserSubscription?.(user.id)) }
              : {}),
          },
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, output);
      }

      throw new HttpError(404, "Route not found.");
    } catch (error) {
      // HttpError carries its own message to the client. Anything else becomes an
      // opaque 500, so without this the server side of a fault leaves no trace at all.
      if (!(error instanceof HttpError)) {
        console.error(`[500] ${req.method} ${req.url}`, error);
      }
      sendError(res, error);
    }
  }

  return {
    store,
    events,
    snapshotPoller,
    server: createServer((req, res) => void handle(req, res)),
  };
}

async function onboardingResponse(store, userId, onboarding) {
  const [environments, devices, commands] = await Promise.all([
    store.listEnvironments(userId),
    store.listDevices(userId),
    store.listCommands(userId),
  ]);
  const readiness = buildOnboardingReadiness({
    onboarding,
    environments,
    devices,
    commands,
  });
  return {
    onboarding,
    readiness: {
      checks: readiness.checks,
      ready: readiness.ready,
      environment: readiness.environment,
      device: readiness.device,
    },
  };
}

async function submitIntent({
  store,
  environment,
  body,
  actor,
  config = loadConfig(),
  baseUrl = null,
  policyContext = {},
}) {
  const startedAt = Date.now();
  const intent = await normalizeIntent(body.intent ?? {}, {
    store,
    userId: actor.userId,
  });
  const policy = evaluateIntentPolicy({
    device: { profile: await resolveActorProfile(store, actor.userId, actor.profile) },
    intent,
    environment,
    // A configured global window is the floor; per-user and per-environment windows are read
    // by the engine directly off the records below.
    ...(config.policyAllowedHours ? { allowedHours: config.policyAllowedHours } : {}),
    ...policyContext,
  });
  const threadIdOrNull = optionalString(body.threadId) ?? null;
  if (!policy.allowed) {
    if (policy.requiresApproval) {
      const threadId = requireString(body.threadId, "threadId");
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId,
        intent,
        normalized: null,
        status: "approval_required",
        risk: policy.risk,
        result: policyResult(policy),
        metrics: commandMetrics({ startedAt }),
      });
      return { command, policy };
    }

    const command = await store.createCommand({
      userId: actor.userId,
      deviceId: actor.type === "device" ? actor.id : null,
      environmentId: environment.id,
      threadId: threadIdOrNull,
      intent,
      normalized: null,
      status: "blocked",
      risk: policy.risk,
      result: policyResult(policy),
      metrics: commandMetrics({ startedAt, failure: true }),
    });
    throw new HttpError(403, "Intent blocked by policy.", { command, policy });
  }

  if (intent.type === "status") {
    if (isEnvironmentTokenExpired(environment)) {
      const command = await createTokenExpiredCommand({ store, actor, environment, threadId: threadIdOrNull, intent, risk: policy.risk, startedAt });
      throw new HttpError(409, "T3 access token has expired. Re-pair this environment.", { command });
    }
    const dispatchStartedAt = Date.now();
    let snapshot;
    try {
      snapshot = await fetchT3Snapshot(environment);
    } catch (error) {
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId: threadIdOrNull,
        intent,
        normalized: { type: "snapshot" },
        status: "failed",
        risk: policy.risk,
        result: t3FailureResult(error),
        metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true }),
      });
      throw new HttpError(502, "T3 status snapshot failed.", { command, cause: errorMessage(error) });
    }
    const command = await store.createCommand({
      userId: actor.userId,
      deviceId: actor.type === "device" ? actor.id : null,
      environmentId: environment.id,
      threadId: threadIdOrNull,
      intent,
      normalized: { type: "snapshot" },
      status: "completed",
      risk: policy.risk,
      result: compressSnapshot(snapshot),
      metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
    });
    return { command, screen: command.result };
  }

  const threadId = requireString(body.threadId, "threadId");
  if (isEnvironmentTokenExpired(environment)) {
    const command = await createTokenExpiredCommand({ store, actor, environment, threadId, intent, risk: policy.risk, startedAt });
    throw new HttpError(409, "T3 access token has expired. Re-pair this environment.", { command });
  }
  // Terminal input does not go through orchestration dispatch: T3 exposes it only over the
  // socket API, and only when the environment was paired with the terminal:operate scope.
  if (intent.type === "terminal_input") {
    if (!environmentHasTerminalScope(environment)) {
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId,
        intent,
        normalized: null,
        status: "blocked",
        risk: policy.risk,
        result: { reason: `This environment was not paired with the ${TERMINAL_SCOPE} scope.` },
        metrics: commandMetrics({ startedAt, failure: true }),
      });
      throw new HttpError(403, `This environment was not paired with the ${TERMINAL_SCOPE} scope.`, { command });
    }

    const dispatchStartedAt = Date.now();
    try {
      const result = await writeTerminalInput(environment, {
        threadId,
        terminalId: intent.terminalId,
        data: intent.data,
        cwd: intent.cwd,
      });
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId,
        intent,
        normalized: { type: "terminal.write", threadId, terminalId: intent.terminalId },
        status: "dispatched",
        risk: policy.risk,
        result: result ?? { accepted: true },
        metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
      });
      return { command };
    } catch (error) {
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId,
        intent,
        normalized: { type: "terminal.write", threadId, terminalId: intent.terminalId },
        status: "failed",
        risk: policy.risk,
        result: t3FailureResult(error),
        metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true }),
      });
      throw new HttpError(502, "T3 terminal write failed.", { command, cause: errorMessage(error) });
    }
  }

  const mediaUploadIds = collectMediaUploadIds(intent, body);
  const attachments = await buildMediaAttachments({
    store,
    userId: actor.userId,
    mediaUploadIds,
    config,
    baseUrl: config.publicBaseUrl ?? baseUrl,
  });
  // Phase 11 measures audio-to-prompt dispatch, which spans upload -> dispatch. Only the upload
  // timestamp makes that computable, so it rides along on the command.
  const mediaCapturedAt = await earliestMediaCreatedAt(store, actor.userId, mediaUploadIds);
  const t3Command = buildT3Command({ intent, threadId, attachments });
  const dispatchStartedAt = Date.now();
  let result;
  try {
    result = await dispatchT3Command(environment, t3Command);
  } catch (error) {
    const command = await store.createCommand({
      userId: actor.userId,
      deviceId: actor.type === "device" ? actor.id : null,
      environmentId: environment.id,
      threadId,
      intent,
      normalized: storableT3Command(t3Command),
      status: "failed",
      risk: policy.risk,
      result: t3FailureResult(error),
      metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true, mediaCapturedAt }),
    });
    throw new HttpError(502, "T3 dispatch failed.", { command, cause: errorMessage(error) });
  }
  const command = await store.createCommand({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    environmentId: environment.id,
    threadId,
    intent,
    normalized: storableT3Command(t3Command),
    status: "dispatched",
    risk: policy.risk,
    result,
    metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true, mediaCapturedAt }),
  });
  return { command };
}

// Records why a command was blocked or held, not just that it was, so the activity log and
// support bundles can explain the decision.
async function currentUsage(store, userId) {
  const [devices, environments, macros] = await Promise.all([
    store.listDevices(userId),
    store.listEnvironments(userId),
    store.listMacros(userId),
  ]);
  return {
    devices: devices?.length ?? 0,
    environments: environments?.length ?? 0,
    macros: macros?.length ?? 0,
  };
}

async function assertWithinPlan(store, userId, resource, config) {
  if (!config?.billingEnforced) return;
  const [subscription, usage] = await Promise.all([
    store.getUserSubscription?.(userId),
    currentUsage(store, userId),
  ]);
  const check = checkResourceLimit(subscription, resource, usage[resource] ?? 0);
  if (!check.allowed) {
    throw new HttpError(402, check.reason, {
      resource,
      limit: check.limit,
      current: check.current,
      tier: effectiveTier(subscription),
      entitlements: entitlementsFor(subscription),
    });
  }
}

// Providers sign the raw body with a shared secret. Without a configured secret the endpoint is
// refused outright rather than silently accepting unauthenticated subscription changes.
function verifyBillingSignature(req, raw, config) {
  const secret = config.billingWebhookSecret;
  if (!secret) {
    throw new HttpError(503, "Billing webhooks are not configured.");
  }

  const timestamp = optionalString(req.headers["x-billing-timestamp"]);
  const signature = optionalString(req.headers["x-billing-signature"]);
  if (!timestamp || !signature) {
    throw new HttpError(401, "Missing billing webhook signature.");
  }

  const ageMs = Math.abs(Date.now() - Number.parseInt(timestamp, 10));
  if (!Number.isFinite(ageMs) || ageMs > BILLING_WEBHOOK_TOLERANCE_MS) {
    throw new HttpError(401, "Billing webhook timestamp is outside the accepted window.");
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(raw)
    .digest("hex");
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new HttpError(401, "Invalid billing webhook signature.");
  }
}

// Produces the scannable claim artefacts for a freshly provisioned device. Only callable where the
// plaintext claim code still exists, since the store keeps just its hash.
function claimLabelFor(result, { gatewayBaseUrl }) {
  const deviceId = result?.device?.id;
  const claimCode = result?.claimCode;
  if (!deviceId || !claimCode || !gatewayBaseUrl) return {};

  const input = {
    gatewayBaseUrl,
    deviceId,
    claimCode,
    label: result.device.label ?? "",
  };
  try {
    return {
      claimUrl: buildDeviceClaimUrl(input),
      claimLabelFilename: claimLabelFilename(deviceId),
      claimLabelSvg: buildDeviceLabelSvg(input),
    };
  } catch {
    // A label is a convenience; never fail provisioning because one could not be rendered.
    return {};
  }
}

// Stored profiles key their slug as `profileId`; the policy engine and the API expect `id`.
function toPublicProfile(profile) {
  return {
    id: profile.profileId,
    label: profile.label,
    description: profile.description,
    capabilities: [...profile.capabilities],
    builtin: false,
    createdAt: profile.createdAt ?? null,
    updatedAt: profile.updatedAt ?? null,
  };
}

/**
 * Resolves a device's profile reference for policy evaluation. A custom profile must be looked up
 * per user and handed to the engine as an object, or it would silently fall back to read-only.
 */
async function resolveActorProfile(store, userId, profileId) {
  if (typeof profileId !== "string" || isKnownDeviceProfile(profileId)) return profileId;
  const custom = await store.getUserDeviceProfile?.(userId, profileId);
  return custom ? { id: custom.profileId, capabilities: custom.capabilities } : profileId;
}

function policyResult(policy) {
  return {
    reason: policy.reason,
    ...(policy.dimension ? { dimension: policy.dimension } : {}),
    ...(policy.matchedRule ? { matchedRule: policy.matchedRule } : {}),
  };
}

async function earliestMediaCreatedAt(store, userId, mediaUploadIds) {
  let earliest = null;
  for (const mediaId of mediaUploadIds ?? []) {
    const media = await store.getMediaForUser(userId, mediaId);
    const createdAt = Date.parse(media?.createdAt ?? "");
    if (!Number.isFinite(createdAt)) continue;
    if (earliest === null || createdAt < earliest) earliest = createdAt;
  }
  return earliest;
}

function collectMediaUploadIds(intent, body) {
  const candidates = [
    intent?.mediaUploadId,
    intent?.media?.mediaUploadId,
    body?.mediaUploadId,
    ...(Array.isArray(body?.mediaUploadIds) ? body.mediaUploadIds : []),
  ];
  return candidates.filter((id) => typeof id === "string" && id.length > 0);
}

// The dispatched command is persisted and later surfaced in audit and support exports.
// Inline media bytes and the signed callback URL are stripped so neither media content
// nor a live access token is retained in the command record.
function storableT3Command(command) {
  const attachments = command?.message?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return command;
  return {
    ...command,
    message: {
      ...command.message,
      attachments: attachments.map(({ dataBase64, url, ...rest }) => ({
        ...rest,
        ...(dataBase64 ? { inlined: true } : {}),
        ...(url ? { urlIssued: true } : {}),
      })),
    },
  };
}

async function checkEnvironmentHealth({ store, userId, environment }) {
  const checkedAt = new Date().toISOString();
  if (isEnvironmentTokenExpired(environment)) {
    const updated = await store.updateEnvironmentHealth({
      userId,
      environmentId: environment.id,
      status: "token_expired",
      health: {
        lastCheckedAt: checkedAt,
        lastError: "T3 access token has expired. Re-pair this environment.",
      },
    });
    return { environment: updated, error: updated?.health?.lastError };
  }
  try {
    const snapshot = await fetchT3Snapshot({ ...environment, timeoutMs: 5000 });
    const screen = compressSnapshot(snapshot);
    const updated = await store.updateEnvironmentHealth({
      userId,
      environmentId: environment.id,
      status: "reachable",
      health: {
        lastCheckedAt: checkedAt,
        lastReachableAt: checkedAt,
        lastError: null,
        snapshot: screen,
      },
    });
    return { environment: updated, screen };
  } catch (error) {
    const updated = await store.updateEnvironmentHealth({
      userId,
      environmentId: environment.id,
      status: "unreachable",
      health: {
        lastCheckedAt: checkedAt,
        lastError: error?.message || "T3 environment is unreachable.",
      },
    });
    return { environment: updated, error: updated?.health?.lastError ?? "T3 environment is unreachable." };
  }
}

async function purgeExpiredMedia({ store, userId, config = null, now = new Date().toISOString() }) {
  const expired = await store.listExpiredMediaUploads({ userId, now });
  const purged = [];
  for (const media of expired) {
    await deleteStoredMedia(media, config);
    const deleted = await store.deleteMediaUpload({
      userId,
      mediaId: media.id,
      reason: "retention_expired",
    });
    if (deleted) purged.push(deleted);
  }
  return { purged, count: purged.length, checkedAt: now };
}

function normalizePrivacySettingsInput(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Privacy settings body is required.");
  if (!Object.hasOwn(body, "mediaRetentionDays")) {
    throw new HttpError(400, "mediaRetentionDays is required.");
  }
  if (body.mediaRetentionDays === null) return { mediaRetentionDays: null };
  const days = Number(body.mediaRetentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400, "mediaRetentionDays must be an integer from 1 to 365, or null.");
  }
  return { mediaRetentionDays: days };
}

function normalizeMacroInput(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Macro body is required.");
  const intent = body.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new HttpError(400, "intent must be an object.");
  }
  return {
    label: requireString(body.label, "label"),
    environmentId: optionalString(body.environmentId),
    threadId: optionalString(body.threadId),
    intent,
  };
}

async function buildSupportDiagnosticsBundle({ store, user }) {
  const [
    devices,
    environments,
    media,
    macros,
    commands,
    audit,
    display,
    observability,
  ] = await Promise.all([
    store.listDevices(user.id),
    store.listEnvironments(user.id),
    store.listMediaUploads(user.id),
    store.listMacros(user.id),
    store.listCommands(user.id),
    store.listAuditLogs(user.id),
    buildUserDisplayState(store, user.id),
    buildUserObservabilitySummary(store, user.id),
  ]);
  const recentCommands = commands.slice(-50).map(redactCommandForSupport);
  const recentAudit = audit.slice(-100).map(redactAuditForSupport);

  return {
    generatedAt: new Date().toISOString(),
    bundleVersion: 1,
    redaction: {
      rawPromptText: "redacted with length and sha256",
      rawShellCommands: "redacted with length and sha256",
      secrets: "not included",
      mediaBytes: "not included",
    },
    user: {
      id: user.id,
      email: user.email ?? null,
    },
    counts: {
      devices: devices.length,
      environments: environments.length,
      media: media.length,
      macros: macros.length,
      commands: commands.length,
      audit: audit.length,
    },
    display,
    observability,
    devices,
    environments,
    media: media.map(redactMediaForSupport),
    macros: macros.map(redactMacroForSupport),
    recentCommands,
    recentAudit,
  };
}

function redactMacroForSupport(macro) {
  return {
    ...macro,
    intent: redactIntent(macro.intent),
  };
}

function redactMediaForSupport(media) {
  return {
    ...media,
    transcript: typeof media.transcript === "string" && media.transcript.length > 0
      ? redactText(media.transcript)
      : media.transcript ?? null,
    // A vision description is user content, exactly like a transcript.
    description: typeof media.description === "string" && media.description.length > 0
      ? redactText(media.description)
      : media.description ?? null,
  };
}

function redactCommandForSupport(command) {
  return {
    ...command,
    intent: redactIntent(command.intent),
    normalized: redactT3Command(command.normalized),
    result: redactSupportValue(command.result),
  };
}

function redactAuditForSupport(event) {
  return {
    ...event,
    metadata: redactSupportValue(event.metadata),
  };
}

function redactIntent(intent) {
  if (!intent || typeof intent !== "object") return intent;
  const output = {};
  for (const [key, value] of Object.entries(intent)) {
    if (["text", "command", "transcript", "description", "prompt"].includes(key) && typeof value === "string") {
      output[key] = redactText(value);
    } else {
      output[key] = redactSupportValue(value);
    }
  }
  return output;
}

function redactT3Command(command) {
  if (!command || typeof command !== "object") return command;
  const output = redactSupportValue(command);
  if (output?.message?.text && typeof output.message.text === "string") {
    output.message.text = redactText(output.message.text);
  }
  return output;
}

function redactSupportValue(value) {
  if (Array.isArray(value)) return value.map(redactSupportValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      output[key] = "[redacted]";
    } else if (["text", "command", "transcript", "description", "prompt"].includes(key) && typeof entry === "string") {
      output[key] = redactText(entry);
    } else {
      output[key] = redactSupportValue(entry);
    }
  }
  return output;
}

function isSecretLikeKey(key) {
  // claimUrl and claimLabelSvg both embed the plaintext claim code, which is a credential.
  return /(secret|token|authorization|password|accessToken|tokenHash|secretHash|claimCode|claimUrl|claimLabelSvg|storagePath)/iu.test(key);
}

function redactText(value) {
  return {
    redacted: true,
    length: value.length,
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

async function approveCommand({ store, userId, commandId }) {
  const startedAt = Date.now();
  const command = await store.getCommandForUser(userId, commandId);
  if (!command) throw new HttpError(404, "Command not found.");
  if (command.status !== "approval_required") {
    throw new HttpError(409, "Command is not waiting for approval.", {
      command,
      status: command.status,
    });
  }
  const environment = await store.getEnvironmentForUser(userId, command.environmentId);
  if (!environment) throw new HttpError(404, "Environment not found.");
  assertEnvironmentTokenActive(environment);
  const threadId = requireString(command.threadId, "threadId");

  // Terminal input is the one approved intent that does not go through orchestration dispatch.
  if (command.intent?.type === "terminal_input") {
    if (!environmentHasTerminalScope(environment)) {
      throw new HttpError(403, `This environment was not paired with the ${TERMINAL_SCOPE} scope.`, { command });
    }
    const terminalStartedAt = Date.now();
    try {
      const result = await writeTerminalInput(environment, {
        threadId,
        terminalId: command.intent.terminalId,
        data: command.intent.data,
        cwd: command.intent.cwd,
      });
      return await store.updateCommand({
        userId,
        commandId,
        status: "dispatched",
        normalized: { type: "terminal.write", threadId, terminalId: command.intent.terminalId },
        result: result ?? { accepted: true },
        metrics: commandMetrics({
          startedAt,
          dispatchStartedAt: terminalStartedAt,
          completed: true,
          existing: command.metrics,
        }),
      });
    } catch (error) {
      const updated = await store.updateCommand({
        userId,
        commandId,
        status: "failed",
        result: t3FailureResult(error),
        metrics: commandMetrics({
          startedAt,
          dispatchStartedAt: terminalStartedAt,
          failure: true,
          existing: command.metrics,
        }),
      });
      throw new HttpError(502, "T3 terminal write failed.", { command: updated, cause: errorMessage(error) });
    }
  }

  const t3Command = buildT3Command({ intent: command.intent, threadId });
  const dispatchStartedAt = Date.now();
  let result;
  try {
    result = await dispatchT3Command(environment, t3Command);
  } catch (error) {
    const updated = await store.updateCommand({
      userId,
      commandId,
      status: "failed",
      normalized: storableT3Command(t3Command),
      result: t3FailureResult(error),
      metrics: commandMetrics({
        startedAt,
        dispatchStartedAt,
        failure: true,
        existing: command.metrics,
      }),
    });
    throw new HttpError(502, "T3 approval dispatch failed.", { command: updated, cause: errorMessage(error) });
  }
  const updated = await store.updateCommand({
    userId,
    commandId,
    status: "dispatched",
    normalized: storableT3Command(t3Command),
    result,
    metrics: commandMetrics({
      startedAt,
      dispatchStartedAt,
      completed: true,
      existing: command.metrics,
    }),
  });
  return { command: updated };
}

async function createTokenExpiredCommand({ store, actor, environment, threadId, intent, risk, startedAt = Date.now() }) {
  return await store.createCommand({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    environmentId: environment.id,
    threadId,
    intent,
    normalized: null,
    status: "blocked",
    risk,
    result: { reason: "T3 access token has expired. Re-pair this environment." },
    metrics: commandMetrics({ startedAt, failure: true }),
  });
}

async function rejectCommand({ store, userId, commandId }) {
  const command = await store.getCommandForUser(userId, commandId);
  if (!command) throw new HttpError(404, "Command not found.");
  if (command.status !== "approval_required") {
    throw new HttpError(409, "Command is not waiting for approval.", {
      command,
      status: command.status,
    });
  }
  const updated = await store.updateCommand({
    userId,
    commandId,
    status: "rejected",
    result: { reason: "Rejected by user." },
  });
  return { command: updated };
}

function commandMetrics({
  startedAt,
  dispatchStartedAt = null,
  completed = false,
  failure = false,
  mediaCapturedAt = null,
  existing = {},
} = {}) {
  const now = Date.now();
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    acknowledgementDurationMs: elapsedMs(startedAt, now),
    dispatchDurationMs: dispatchStartedAt ? elapsedMs(dispatchStartedAt, now) : null,
    // Upload -> dispatch, the span Phase 11 budgets at 10s for audio-to-prompt.
    ...(mediaCapturedAt ? { mediaDispatchDurationMs: elapsedMs(mediaCapturedAt, now) } : {}),
    completedAt: completed ? new Date(now).toISOString() : null,
    failureAt: failure ? new Date(now).toISOString() : null,
  };
}

function elapsedMs(startedAt, endedAt = Date.now()) {
  return Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : null;
}

function t3FailureResult(error) {
  return {
    error: "t3_dispatch_failed",
    message: errorMessage(error),
  };
}

function errorMessage(error) {
  return error?.message || "T3 request failed.";
}

async function authenticateUser(req, store, config, url = null, clerkAuth = null) {
  if (config.authProvider === "clerk") {
    if (!clerkAuth) throw new HttpError(503, "Clerk authentication is not configured.");
    const clerkUser = await clerkAuth(req);
    if (!clerkUser) throw new HttpError(401, "Invalid or expired Clerk session.");
    return await store.ensureUser({
      userId: clerkUser.id,
      ...(clerkUser.email ? { email: clerkUser.email } : {}),
      ...(clerkUser.name ? { name: clerkUser.name } : {}),
    });
  }

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    const user = await store.authenticateUserToken(token);
    if (user) return user;
    if (clerkAuth) {
      const clerkUser = await clerkAuth(req);
      if (clerkUser) {
        return await store.ensureUser({
          userId: clerkUser.id,
          ...(clerkUser.email ? { email: clerkUser.email } : {}),
          ...(clerkUser.name ? { name: clerkUser.name } : {}),
        });
      }
    }
    throw new HttpError(401, "Invalid platform token.");
  }

  const queryToken = url?.searchParams.get("token");
  if (queryToken) {
    const user = await store.authenticateUserToken(queryToken);
    if (!user) throw new HttpError(401, "Invalid platform token.");
    return user;
  }

  if (config.demoMode) {
    const userId = requireString(req.headers["x-user-id"], "x-user-id header");
    return await store.ensureUser({ userId });
  }

  throw new HttpError(401, "Missing platform bearer token.");
}

function authenticateFactory(req, config) {
  // Factory routes both accept the factory token and return per-device secrets.
  assertSecureTransport(req, config, "Factory provisioning");
  if (!config.factoryToken && config.demoMode) return;
  const auth = req.headers.authorization;
  if (config.factoryToken && auth === `Bearer ${config.factoryToken}`) return;
  throw new HttpError(401, "Missing or invalid factory token.");
}

function requireCount(value) {
  const count = Number.parseInt(String(value ?? "1"), 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new HttpError(400, "count must be an integer between 1 and 100.");
  }
  return count;
}

function requireDeviceProfile(value) {
  const profile = normalizeDeviceProfile(optionalString(value));
  if (!isKnownDeviceProfile(profile)) {
    throw new HttpError(400, `Unsupported device profile: ${profile}.`);
  }
  return profile;
}

/** Like requireDeviceProfile, but also accepts one of the caller's own custom profiles. */
async function requireOwnedDeviceProfile(store, userId, value) {
  const profile = normalizeDeviceProfile(optionalString(value));
  if (isKnownDeviceProfile(profile)) return profile;
  const custom = await store.getUserDeviceProfile?.(userId, profile);
  if (!custom) throw new HttpError(400, `Unsupported device profile: ${profile}.`);
  return profile;
}

function parseFirmwareRelease(body) {
  try {
    const release = normalizeFirmwareRelease(body);
    if (!Number.isInteger(release.sizeBytes) || release.sizeBytes < 1) {
      throw new Error("sizeBytes must be a positive integer.");
    }
    if (!/^[a-f0-9]{64}$/u.test(release.sha256)) {
      throw new Error("sha256 must be a 64-character hex digest.");
    }
    return release;
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

function requireOtaSigningKey(config) {
  if (config.otaSigningKey) return config.otaSigningKey;
  if (config.demoMode) return "dev-insecure-ota-signing-key";
  throw new HttpError(503, "OTA_SIGNING_KEY is required for firmware manifests.");
}

function requestBaseUrl(req) {
  const proto = optionalString(req.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

async function authenticateDevice(req, store, url = null, config = {}) {
  // A device secret travels on every one of these requests.
  assertSecureTransport(req, config, "Device authentication");
  const deviceId = optionalString(req.headers["x-device-id"])
    ?? optionalString(url?.searchParams.get("deviceId"));
  const deviceSecret = optionalString(req.headers["x-device-secret"])
    ?? optionalString(url?.searchParams.get("deviceSecret"));
  requireString(deviceId, "x-device-id header");
  requireString(deviceSecret, "x-device-secret header");
  const device = await store.authenticateDevice(deviceId, deviceSecret);
  if (!device) throw new HttpError(401, "Invalid device credentials.");
  return device;
}

async function enforceFactoryWrite(req, res, rateLimiter, config) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "factory:write",
    actorId: clientKey(req),
    limit: config.rateLimits?.factoryWrite,
  });
}

async function enforceUserRead(req, res, rateLimiter, config, user) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "user:read",
    actorId: user.id,
    limit: config.rateLimits?.userRead,
  });
}

async function enforceUserWrite(req, res, rateLimiter, config, user) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "user:write",
    actorId: user.id,
    limit: config.rateLimits?.userWrite,
  });
}

async function enforceDeviceHeartbeat(req, res, rateLimiter, config, device) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:heartbeat",
    actorId: device.id,
    limit: config.rateLimits?.deviceHeartbeat,
  });
}

async function enforceDeviceRead(req, res, rateLimiter, config, device) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:read",
    actorId: device.id,
    limit: config.rateLimits?.deviceRead,
  });
}

async function enforceDeviceWrite(req, res, rateLimiter, config, device) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:write",
    actorId: device.id,
    limit: config.rateLimits?.deviceWrite,
  });
}

async function enforceRateLimit(req, res, rateLimiter, config, { scope, actorId, limit }) {
  const windowMs = config.rateLimits?.windowMs ?? 60_000;
  const result = await rateLimiter.check({
    key: `${scope}:${actorId}`,
    limit: limit ?? 0,
    windowMs,
  });
  if (Number.isFinite(result.limit) && result.limit > 0) {
    res.setHeader("x-ratelimit-limit", String(result.limit));
    res.setHeader("x-ratelimit-remaining", String(result.remaining));
    if (result.resetAt) res.setHeader("x-ratelimit-reset", new Date(result.resetAt).toISOString());
  }
  if (!result.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    res.setHeader("retry-after", String(retryAfterSeconds));
    throw new HttpError(429, "Rate limit exceeded.", {
      scope,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: new Date(result.resetAt).toISOString(),
    });
  }
}

function clientKey(req) {
  const forwardedFor = optionalString(req.headers["x-forwarded-for"]);
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function tokenExpiresAt(tokenResponse) {
  const seconds = Number(tokenResponse?.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function assertEnvironmentTokenActive(environment) {
  if (isEnvironmentTokenExpired(environment)) {
    throw new HttpError(409, "T3 access token has expired. Re-pair this environment.", {
      environmentId: environment.id,
      accessTokenExpiresAt: environment.accessTokenExpiresAt,
    });
  }
}

function normalizeT3ModelSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const instanceId = optionalString(value.instanceId);
  const model = optionalString(value.model);
  if (!instanceId || !model) return null;
  const selection = { instanceId, model };
  if (Array.isArray(value.options)) selection.options = value.options;
  return selection;
}

function normalizeT3RuntimeMode(value) {
  return ["approval-required", "auto-accept-edits", "auto", "full-access"].includes(value)
    ? value
    : "approval-required";
}

function normalizeT3InteractionMode(value) {
  return value === "plan" ? "plan" : "default";
}

function isDevTokenCreationEnabled(config) {
  if (typeof config.devTokenCreationEnabled === "boolean") return config.devTokenCreationEnabled;
  return config.authProvider !== "clerk" || config.demoMode === true;
}

function requireClaimedDevice(device) {
  if (!device.userId || !device.claimed) {
    throw new HttpError(403, "Device must be claimed before using this endpoint.");
  }
}

// The environment the owner bound to this device, resolved through the owner's own
// scope. A device with no bound environment has nothing to choose threads within.
async function boundDeviceEnvironment(store, device) {
  const environmentId = optionalString(device.config?.environmentId);
  if (!environmentId) {
    throw new HttpError(409, "Device has no environment configured.");
  }
  const environment = await store.getEnvironmentForUser(device.userId, environmentId);
  if (!environment) throw new HttpError(404, "Environment not found.");
  assertEnvironmentTokenActive(environment);
  return environment;
}

// Compact thread list for a 122x250 panel: id plus a short title, nothing else.
function deviceSelectableThreads(snapshot) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  return threads
    .map((thread) => ({
      id: optionalString(thread?.id) ?? null,
      title: optionalString(thread?.title) ?? optionalString(thread?.name) ?? "Untitled thread",
    }))
    .filter((thread) => thread.id !== null);
}

// sw.js must stay at the root so the service worker's scope covers the whole app.
const WEB_STATIC_FILES = new Set(["/manifest.webmanifest", "/sw.js"]);

// SPA routes that must fall back to index.html. /claim is where a scanned device QR lands.
const WEB_APP_ROUTES = new Set(["/claim"]);

function isWebStaticRoute(pathname) {
  return pathname === "/"
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/icons/")
    || WEB_STATIC_FILES.has(pathname)
    || WEB_APP_ROUTES.has(pathname);
}

async function serveWebStatic(res, pathname) {
  const filename = pathname === "/" || WEB_APP_ROUTES.has(pathname) ? "index.html" : pathname.slice(1);
  const filePath = resolve(WEB_DIST_DIR, filename);
  if (filePath !== resolve(WEB_DIST_DIR, "index.html") && !filePath.startsWith(`${resolve(WEB_DIST_DIR)}${sep}`)) {
    throw new HttpError(404, "Web asset not found.");
  }
  const buffer = await readStaticFile(filePath, "Web asset not found.");
  return sendBuffer(res, 200, buffer, {
    "content-type": contentTypeFor(filePath),
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
}

// A request for a file that is not on disk is a 404, not a crash.
async function readStaticFile(filePath, notFoundMessage) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "ENOTDIR") {
      throw new HttpError(404, notFoundMessage);
    }
    throw error;
  }
}

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json";
    case ".ico":
      return "image/x-icon";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
