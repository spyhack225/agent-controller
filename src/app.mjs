import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";

import { DEFAULT_HARDWARE_BOARD, HARDWARE_BOARDS, describeHardwareBoard } from "./hardware.mjs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClerkAuthenticator } from "./clerkAuth.mjs";
import { loadConfig } from "./config.mjs";
import { buildConnectCommand, normalizeConnectAccessMode } from "./connectSession.mjs";
import { buildDeviceDisplayState, buildUserDisplayState, invalidateDisplayCache } from "./displayState.mjs";
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
import { createId } from "./ids.mjs";
import { normalizeIntent } from "./intent.mjs";
import {
  buildDeviceFollowUpInstruction,
  buildDeviceThreadOutput,
} from "./deviceThreadOutput.mjs";
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
import { deleteFirmwareArtifact, readFirmwareArtifact, storeFirmwareArtifact } from "./firmwareArtifacts.mjs";
import { buildFirmwareArtifactUrl, verifyFirmwareArtifactCapability } from "./firmwareLinks.mjs";
import {
  buildMediaAttachments,
  deleteStoredMedia,
  readStoredMedia,
  storeUploadedMedia,
} from "./mediaStore.mjs";
import { createMediaJobRunner } from "./mediaJobs.mjs";
import {
  buildMediaName,
  lookupThreadTitle,
  markThreadTitlesUnavailable,
  rememberSnapshotThreadTitles,
  threadTitlesAreStale,
} from "./mediaNaming.mjs";
import { mintDeviceThreadTitle, normalizeTitle } from "./threadNaming.mjs";
import { deviceJobStatus, mediaJobEvent, voiceAutoSendEnabled } from "./deviceAudio.mjs";
import {
  createTranscriptionProvider,
  describeTranscriptChange,
  isTranscriptionProviderEnabled,
} from "./transcription.mjs";
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
import {
  actionControlKind,
  actionIntent,
  ENVIRONMENT_REMOVED_REASON,
  hardwareSupportsAction,
  normalizeActionInput,
  normalizeDeviceControlItems,
  SYSTEM_CONTROL_IDS,
} from "./actions.mjs";
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
import { configurePrivateTailscaleServe, inspectRemoteAccess } from "./remoteAccess.mjs";
import { normalizeGatewayProfileInput, publicGatewayProfile } from "./gatewayProfiles.mjs";
import { createSnapshotPoller } from "./snapshotPoller.mjs";
import { createThreadStreamHub } from "./threadStream.mjs";
import { createCommandArbiter } from "./commandArbiter.mjs";
import { createStore, emptyEnvironmentRemoval } from "./store.mjs";
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
  buildT3ThreadCreateCommand,
  compressSnapshot,
  dispatchT3Command,
  exchangePairingToken,
  fetchT3Snapshot,
  fetchT3ThreadDetail,
  isEnvironmentTokenExpired,
} from "./t3Client.mjs";
import { refineThreadStatus } from "./agentVerb.mjs";
import {
  buildT3ReleaseStatus,
  fetchLatestT3Release,
  runT3CompatibilityCheck,
  summarizeT3Compatibility,
  T3_COMPATIBILITY_POLICY,
} from "./t3Compatibility.mjs";
import {
  classifyEnvironmentFailure,
  describeEnvironmentFailure,
  isRetryableEnvironmentFailure,
} from "./environmentFailure.mjs";

const STANDARD_T3_SCOPES = ["orchestration:read", "orchestration:operate"];
const BILLING_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = join(__dirname, "..", "dist", "web");

async function resolveEnvironmentHarnesses(environment, snapshot) {
  let catalogue = environment.providerCatalogue ?? null;
  let catalogueSource = catalogue ? "registered" : "snapshot-only";
  try {
    const providers = await fetchProviderCatalogue(environment, { timeoutMs: 8000 });
    catalogue = buildProviderCatalogue(providers, { source: "t3-websocket" });
    catalogueSource = "live";
  } catch {
    // A registered catalogue is still authoritative when the live socket is unavailable. Without
    // either source, snapshot-derived harnesses remain permissive so custom models keep working.
  }
  return {
    harnesses: extractHarnesses(snapshot, { catalogue }),
    catalogueSource,
  };
}

export function createApp({
  store = null,
  config = loadConfig(),
  rateLimiter = createRateLimiter(),
  clerkAuth = createClerkAuthenticator(config),
  t3CompatibilityRpc = undefined,
  remoteAccessControl = configurePrivateTailscaleServe,
} = {}) {
  store ??= createStore({}, { t3TokenEncryptionKey: config.t3TokenEncryptionKey });
  const events = createEventBroker();
  // The memory and file stores hand back a full snapshot; the Convex store can only name the
  // user whose data changed. Both end up as a state.changed event for that user.
  store.subscribe((change) => {
    if (change && Array.isArray(change.users)) {
      // A full snapshot names no single user, so nothing can be assumed still fresh.
      invalidateDisplayCache();
      events.broadcastStateChange(change);
      return;
    }
    if (change?.userId) {
      invalidateDisplayCache(change.userId);
      events.broadcastUserChange(change.userId, { action: change.action ?? null });
    }
  });
  // One arbiter, two evidence sources. The poller reads T3 on a timer and the thread stream reads
  // it live; without a shared arbiter they would both decide the same dispatched command, and a
  // live failure could be overwritten by a polled reply from the same turn. See
  // src/commandArbiter.mjs.
  const commandArbiter = createCommandArbiter();
  const snapshotPoller = createSnapshotPoller({
    store,
    events,
    arbiter: commandArbiter,
    ...(config.snapshotPollIntervalMs ? { intervalMs: config.snapshotPollIntervalMs } : {}),
  });
  // Constructed here, started from server.mjs — same rule as the poller and the media worker, so
  // no test opens a socket it did not ask for. Tests drive runOnce().
  const threadStreams = createThreadStreamHub({
    store,
    events,
    arbiter: commandArbiter,
    ...(config.threadStreamIntervalMs ? { intervalMs: config.threadStreamIntervalMs } : {}),
    ...(config.threadStreamWatchTtlMs ? { watchTtlMs: config.threadStreamWatchTtlMs } : {}),
  });
  // Constructed here, started from server.mjs. Tests drive runOnce() so nothing depends on a timer.
  const mediaJobRunner = createMediaJobRunner({
    store,
    config,
    events,
    // Closed over the store and config rather than imported by the worker, which has no business
    // knowing what a policy is. Every send is decided here, at the moment it happens.
    dispatchTranscript: ({ job, transcript }) => dispatchVoiceTranscript({ store, config, job, transcript }),
    ...(config.transcriptionWorkerIntervalMs ? { intervalMs: config.transcriptionWorkerIntervalMs } : {}),
    ...(config.transcriptionLeaseMs ? { leaseMs: config.transcriptionLeaseMs } : {}),
    ...(config.transcriptionBatchSize ? { batchSize: config.transcriptionBatchSize } : {}),
  });
  let remoteAccessCache = null;
  let remoteAccessCacheExpiresAt = 0;

  async function remoteAccessStatus(force = false) {
    if (!force && remoteAccessCache && remoteAccessCacheExpiresAt > Date.now()) {
      return remoteAccessCache;
    }
    remoteAccessCache = await inspectRemoteAccess({
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
    });
    remoteAccessCacheExpiresAt = Date.now() + 15_000;
    return remoteAccessCache;
  }

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

      // Unauthenticated on purpose, and it says nothing a probe on the LAN could not already infer
      // from /health. Its job is to let a controller CONFIRM that a candidate address is a gateway
      // — after a UDP discovery reply, or after the owner typed something — before it commits the
      // URL to NVS and reboots into it.
      if (req.method === "GET" && url.pathname === "/v1/hardware/boards") {
        return sendJson(res, 200, { boards: HARDWARE_BOARDS, defaultBoard: DEFAULT_HARDWARE_BOARD });
      }

      if (req.method === "GET" && url.pathname === "/v1/discovery") {
        return sendJson(res, 200, {
          service: "agent-controller",
          name: config.discoveryName ?? hostname(),
          authProvider: config.authProvider,
          claimRequired: true,
        });
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
        // Defaults to the CrowPanel because it is the one board with a firmware validated end to
        // end; an unspecified model should mean the proven one, not an arbitrary one.
        const hardwareModel = optionalString(body.hardwareModel) ?? DEFAULT_HARDWARE_BOARD;
        const result = await store.preprovisionDevice({
          label: requireString(body.label, "label"),
          profile,
          hardwareModel,
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
            hardwareModel,
          }),
          // Whoever is flashing this unit needs to know WHICH image, now that there is one per
          // board. Without it a correct seed still produces a dead device.
          board: describeHardwareBoard(hardwareModel),
        });
      }

      if (url.pathname === "/v1/gateway-profiles" && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { profiles: (await store.listGatewayProfiles(user.id)).map(publicGatewayProfile) });
      }

      if (url.pathname === "/v1/gateway-profiles" && req.method === "POST") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        if ((await store.listGatewayProfiles(user.id)).length >= 5) {
          throw new HttpError(409, "A maximum of five gateway profiles is supported per owner.");
        }
        const input = normalizeGatewayProfileInput(await readJson(req));
        const profile = await store.createGatewayProfile({ userId: user.id, ...input });
        return sendJson(res, 201, { profile: publicGatewayProfile(profile) });
      }

      const gatewayProfileMatch = url.pathname.match(/^\/v1\/gateway-profiles\/([^/]+)$/u);
      if (gatewayProfileMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const profile = await store.getGatewayProfileForUser(user.id, gatewayProfileMatch[1]);
        if (!profile) throw new HttpError(404, "Gateway profile not found.");
        return sendJson(res, 200, { profile: publicGatewayProfile(profile) });
      }
      if (gatewayProfileMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const existing = await store.getGatewayProfileForUser(user.id, gatewayProfileMatch[1]);
        if (!existing) throw new HttpError(404, "Gateway profile not found.");
        const input = normalizeGatewayProfileInput(await readJson(req), existing);
        const profile = await store.updateGatewayProfile({ userId: user.id, profileId: existing.id, ...input });
        if (profile?.conflict) throw new HttpError(409, "Create and stage a new profile before changing an assigned gateway URL.", {
          deviceIds: profile.deviceIds,
        });
        return sendJson(res, 200, { profile: publicGatewayProfile(profile) });
      }
      if (gatewayProfileMatch && req.method === "DELETE") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const result = await store.deleteGatewayProfile({ userId: user.id, profileId: gatewayProfileMatch[1] });
        if (!result) throw new HttpError(404, "Gateway profile not found.");
        if (result.conflict) throw new HttpError(409, "Gateway profile is assigned to a device.", { deviceIds: result.deviceIds });
        return sendJson(res, 200, { profile: publicGatewayProfile(result.profile), deleted: true });
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
          release: sanitizeFirmwareRelease(release),
          manifest: buildFirmwareManifest(release, signingKey),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/factory/firmware/releases/upload") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const signingKey = requireOtaSigningKey(config);
        if (String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
          throw new HttpError(415, "Firmware upload must use application/octet-stream.");
        }
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > config.maxFirmwareBytes) {
          throw new HttpError(413, `Firmware artifact exceeds ${config.maxFirmwareBytes} bytes.`);
        }
        const version = requireString(url.searchParams.get("version"), "version");
        const channel = optionalString(url.searchParams.get("channel")) ?? "stable";
        const hardwareModel = optionalString(url.searchParams.get("hardwareModel")) ?? config.defaultHardwareModel;
        const releaseNotes = optionalString(url.searchParams.get("releaseNotes")) ?? "";
        const mandatory = url.searchParams.get("mandatory") === "1";
        const buffer = await readRawBody(req, config.maxFirmwareBytes);
        const artifact = await storeFirmwareArtifact({ config, buffer, hardwareModel, channel, version });
        let release;
        try {
          const input = parseFirmwareRelease({ version, channel, hardwareModel,
            url: `/v1/device/firmware/artifacts/${artifact.sha256}`, sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes, mandatory, releaseNotes });
          release = await store.createFirmwareRelease({ ...input, artifactKey: artifact.artifactKey,
            artifactProvider: artifact.artifactProvider });
        } catch (error) {
          await deleteFirmwareArtifact(artifact, config).catch(() => {});
          throw error;
        }
        const publicRelease = sanitizeFirmwareRelease(release);
        const manifestRelease = { ...publicRelease, url: new URL(publicRelease.url, requestBaseUrl(req)).toString() };
        return sendJson(res, 201, { release: publicRelease, manifest: buildFirmwareManifest(manifestRelease, signingKey), managedArtifact: true });
      }

      if (req.method === "GET" && url.pathname === "/v1/factory/firmware/releases") {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const hardwareModel = optionalString(url.searchParams.get("hardwareModel"));
        const channel = optionalString(url.searchParams.get("channel"));
        return sendJson(res, 200, {
          releases: await store.listFirmwareReleases({ hardwareModel, channel }),
        });
      }

      const factoryFirmwareReleaseMatch = url.pathname.match(/^\/v1\/factory\/firmware\/releases\/([^/]+)$/u);
      if (req.method === "DELETE" && factoryFirmwareReleaseMatch) {
        authenticateFactory(req, config);
        await enforceFactoryWrite(req, res, rateLimiter, config);
        const release = await store.deleteFirmwareRelease(factoryFirmwareReleaseMatch[1]);
        if (!release) throw new HttpError(404, "Firmware release not found.");
        await deleteFirmwareArtifact(release, config);
        return sendJson(res, 200, { release: sanitizeFirmwareRelease(release), deleted: true });
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
        if (Object.hasOwn(body, "label")) body.label = requireString(body.label, "label");
        if (Object.hasOwn(body, "gatewayAccessMode") && !["local", "tailscale", "online"].includes(body.gatewayAccessMode)) {
          throw new HttpError(400, "gatewayAccessMode must be local, tailscale, or online.");
        }
        if (Object.hasOwn(body, "gatewayUrl") && body.gatewayUrl !== null && body.gatewayUrl !== "") {
          const gatewayUrl = requireString(body.gatewayUrl, "gatewayUrl");
          let parsedGatewayUrl;
          try {
            parsedGatewayUrl = new URL(gatewayUrl);
          } catch {
            throw new HttpError(400, "gatewayUrl must be a valid HTTP or HTTPS URL.");
          }
          if (!["http:", "https:"].includes(parsedGatewayUrl.protocol)) {
            throw new HttpError(400, "gatewayUrl must be a valid HTTP or HTTPS URL.");
          }
          if (body.gatewayAccessMode && body.gatewayAccessMode !== "local" && parsedGatewayUrl.protocol !== "https:") {
            throw new HttpError(400, "Remote gateway URLs must use HTTPS.");
          }
        }
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

      const ownerDeviceGatewayMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/gateway$/u);
      if (ownerDeviceGatewayMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, ownerDeviceGatewayMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, await deviceGatewayResponse(store, device));
      }
      if (ownerDeviceGatewayMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, ownerDeviceGatewayMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const body = await readJson(req);
        const profileId = requireString(body.profileId, "profileId");
        if (!(await store.getGatewayProfileForUser(user.id, profileId))) throw new HttpError(404, "Gateway profile not found.");
        const selection = await store.stageDeviceGatewaySwitch({ userId: user.id, deviceId: device.id, profileId });
        if (!selection) throw new HttpError(409, "Gateway switch could not be staged.");
        return sendJson(res, 200, await deviceGatewayResponse(store, device, selection));
      }

      const ownerGatewayRollbackMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/gateway\/rollback$/u);
      if (ownerGatewayRollbackMatch && req.method === "POST") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, ownerGatewayRollbackMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const selection = await store.rollbackDeviceGatewaySwitch({ userId: user.id, deviceId: device.id });
        return sendJson(res, 200, await deviceGatewayResponse(store, device, selection));
      }

      const deviceControlsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/controls$/u);
      if (deviceControlsMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceControlsMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const stored = await store.getDeviceControls({ userId: user.id, deviceId: device.id });
        return sendJson(res, 200, {
          deviceId: device.id,
          controls: await resolveDeviceControls({ store, device, stored, config }),
          layout: stored,
        });
      }

      if (deviceControlsMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceControlsMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const body = await readJson(req);
        const menuItems = Number(device.status?.limits?.menuItems) || 8;
        const items = normalizeDeviceControlItems(body.controls ?? body.items, { menuItems });
        await validateDeviceControlAssignments({ store, device, items, config });
        const layout = await store.updateDeviceControls({ userId: user.id, deviceId: device.id, items });
        if (!layout) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, {
          deviceId: device.id,
          controls: await resolveDeviceControls({ store, device, stored: layout, config }),
          layout,
        });
      }

      const deviceFirmwarePolicyMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/firmware-policy$/u);
      if (deviceFirmwarePolicyMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceFirmwarePolicyMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const policy = await store.getDeviceFirmwarePolicy({
          userId: user.id,
          deviceId: device.id,
        });
        return sendJson(res, 200, await firmwarePolicyResponse({ store, device, policy, config }));
      }

      if (deviceFirmwarePolicyMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        validateFirmwarePolicyInput(body);
        const device = await store.getDeviceForUser(user.id, deviceFirmwarePolicyMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        const currentPolicy = await store.getDeviceFirmwarePolicy({ userId: user.id, deviceId: device.id });
        const policyInput = {
          ...body,
          ...(body.channel && body.channel !== currentPolicy.channel && !Object.hasOwn(body, "desiredVersion")
            ? { desiredVersion: null }
            : {}),
        };
        if (policyInput.desiredVersion) {
          const releases = await compatibleFirmwareReleases(store, device, {
            ...currentPolicy,
            ...policyInput,
          }, config);
          if (!releases.some((release) => release.version === policyInput.desiredVersion)) {
            throw new HttpError(404, "The desired firmware version is not available for this hardware and channel.");
          }
        }
        const policy = await store.updateDeviceFirmwarePolicy({
          userId: user.id,
          deviceId: device.id,
          policy: policyInput,
        });
        if (!policy) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, await firmwarePolicyResponse({ store, device, policy, config }));
      }

      // The auto-send grant. Owner realm only: a device must never be able to widen its own
      // licence to act on what it hears.
      const deviceVoiceAutoSendMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/voice-auto-send$/u);
      if (deviceVoiceAutoSendMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceVoiceAutoSendMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: device.id, voiceAutoSend: device.voiceAutoSend });
      }

      if (deviceVoiceAutoSendMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        // `null` is a third answer, not a missing one: it withdraws the owner's decision and hands
        // the device back to the default. Omitting the key is still a 400 — an absent field is a
        // malformed request, and guessing which of three states it meant is how a grant gets
        // changed by accident.
        if (typeof body.enabled !== "boolean" && body.enabled !== null) {
          throw new HttpError(400, "enabled must be true, false, or null to restore the default.");
        }
        const device = await store.setDeviceVoiceAutoSend({
          userId: user.id,
          deviceId: deviceVoiceAutoSendMatch[1],
          enabled: body.enabled,
          actorId: user.id,
          actorType: "user",
        });
        if (!device) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, { device, voiceAutoSend: device.voiceAutoSend });
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

      // Console-first pairing. `POST /v1/t3/environments` still exists for the manual-paste
      // fallback; these three exist so the browser never has to be handed a credential at all.
      // See src/connectSession.mjs.
      if (req.method === "POST" && url.pathname === "/v1/t3/connect-sessions") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const environmentId = optionalString(body.environmentId);
        if (environmentId) {
          // Re-pairing. Verified now so the user is not sent to a terminal for a host the gateway
          // will refuse to update fifteen minutes later.
          const existing = await store.getEnvironmentForUser(user.id, environmentId);
          if (!existing) throw new HttpError(404, "Environment not found.");
        } else {
          await assertWithinPlan(store, user.id, "environments", config);
        }
        const accessMode = normalizeConnectAccessMode(body.accessMode);
        const created = await store.createConnectSession({
          userId: user.id,
          label: optionalString(body.label) ?? "T3 Code",
          accessMode,
          environmentId: environmentId ?? null,
        });
        // The gateway names itself rather than trusting the browser's origin, because the command
        // is run on a different machine and has to reach *this* gateway.
        const gatewayUrl = config.publicBaseUrl ?? requestBaseUrl(req);
        return sendJson(res, 201, {
          session: created.session,
          code: created.code,
          gatewayUrl,
          command: buildConnectCommand({ gatewayUrl, code: created.code, accessMode }),
        });
      }

      // Code-authenticated, no platform session: scripts/setup-t3.mjs runs on the T3 host and has
      // no Clerk credential. Registered before the /:id route so the literal path wins.
      if (req.method === "POST" && url.pathname === "/v1/t3/connect-sessions/redeem") {
        await enforceConnectRedeem(req, res, rateLimiter, config);
        const body = await readJson(req);
        // Validated before the code is consumed — a malformed body must not burn the enrollment.
        const code = requireString(body.code, "code");
        const baseUrl = requireString(body.baseUrl, "baseUrl");
        const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
          ? body.scopes.map((scope) => requireString(scope, "scope"))
          : STANDARD_T3_SCOPES;
        if (!optionalString(body.accessToken)) requireString(body.pairingToken, "pairingToken");
        const claimed = await store.claimConnectSession({ code });
        if (!claimed?.session) {
          throw new HttpError(
            claimed?.reason === "expired" ? 410 : 404,
            claimed?.reason === "expired"
              ? "This connect code has expired. Mint a new one from the console."
              : "Connect code is invalid, expired, or already used.",
          );
        }
        const session = claimed.session;
        try {
          if (!session.environmentId) {
            await assertWithinPlan(store, session.userId, "environments", config);
          }
          const tokenResponse = optionalString(body.accessToken)
            ? null
            : await exchangePairingToken({ baseUrl, pairingToken: body.pairingToken, scopes });
          const environment = await store.upsertEnvironment({
            // Re-pairing updates the row the console nominated; a first pairing still falls through
            // to upsertEnvironment's base-URL match, so neither path can add a duplicate host.
            ...(session.environmentId ? { id: session.environmentId } : {}),
            userId: session.userId,
            label: session.label || optionalString(body.label) || "T3 Code",
            baseUrl,
            accessToken: optionalString(body.accessToken) ?? tokenResponse.access_token,
            accessTokenExpiresAt: tokenResponse
              ? tokenExpiresAt(tokenResponse)
              : optionalString(body.accessTokenExpiresAt),
            scopes,
            status: "paired",
          });
          if (!environment) throw new HttpError(404, "Environment not found.");
          // The host is the only place the provider caches exist, and the script has no platform
          // token to PUT them with, so the catalogue rides along with the redemption.
          const catalogue = await registerRedeemedCatalogue({ store, session, environment, body });
          const paired = await store.getEnvironmentForUser(session.userId, environment.id);
          const health = await checkEnvironmentHealth({ store, userId: session.userId, environment: paired });
          const completed = await store.completeConnectSession({
            sessionId: session.id,
            environmentId: environment.id,
            baseUrl: environment.baseUrl,
          });
          return sendJson(res, 201, {
            session: completed,
            environment: health.environment ?? environment,
            screen: health.screen ?? null,
            failure: health.failure ?? null,
            catalogue,
          });
        } catch (error) {
          // The console is watching this session, so a failure has to land on the record rather
          // than only in the terminal the user ran the command in.
          await store.completeConnectSession({
            sessionId: session.id,
            error: error?.message || "Pairing failed.",
          });
          throw error;
        }
      }

      const connectSessionMatch = url.pathname.match(/^\/v1\/t3\/connect-sessions\/([^/]+)$/u);
      if (req.method === "GET" && connectSessionMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const session = await store.getConnectSession({ userId: user.id, sessionId: connectSessionMatch[1] });
        if (!session) throw new HttpError(404, "Connect session not found.");
        // listEnvironments, not getEnvironmentForUser: the latter decrypts and returns the access
        // token, which this polling endpoint must never hand to the browser.
        const environment = session.environmentId && session.status === "completed"
          ? (await store.listEnvironments(user.id)).find((item) => item.id === session.environmentId) ?? null
          : null;
        return sendJson(res, 200, { session, environment });
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

      const environmentCapabilitiesMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/capabilities$/u);
      if (req.method === "GET" && environmentCapabilitiesMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentCapabilitiesMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const scopes = new Set(environment.scopes ?? []);
        return sendJson(res, 200, {
          environmentId: environment.id,
          capabilities: {
            orchestrationRead: scopes.has("orchestration:read"),
            orchestrationOperate: scopes.has("orchestration:operate"),
            terminalDirect: scopes.has(TERMINAL_SCOPE),
            attachments: scopes.has("orchestration:operate"),
            savedActions: "gateway",
            macros: "gateway",
          },
        });
      }

      const environmentDependenciesMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/dependencies$/u);
      if (req.method === "GET" && environmentDependenciesMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentDependenciesMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const dependencies = await collectEnvironmentDependencies(store, user.id, environment.id);
        return sendJson(res, 200, {
          environmentId: environment.id,
          dependencies,
          counts: {
            devices: dependencies.devices.length,
            actions: dependencies.actions.length,
            macros: dependencies.macros.length,
            onboarding: dependencies.onboarding ? 1 : 0,
          },
        });
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
        const result = await store.deleteEnvironment({ userId: user.id, environmentId: environmentMatch[1] });
        // Removal is idempotent: a repeated DELETE reports the same end state rather than 404ing,
        // so a retry (or a second console tab) cannot strand the owner on an error.
        if (!result) {
          return sendJson(res, 200, {
            environment: null,
            removed: emptyEnvironmentRemoval(),
            alreadyRemoved: true,
          });
        }
        return sendJson(res, 200, {
          environment: result.environment,
          removed: result.removed ?? emptyEnvironmentRemoval(),
          alreadyRemoved: false,
        });
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
          const snapshot = await readT3Snapshot({ ...environment, timeoutMs: 5000 });
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
          const reason = classifyEnvironmentFailure(error);
          const checkedAt = new Date().toISOString();
          const updated = await store.updateEnvironmentHealth({
            userId: user.id,
            environmentId: environment.id,
            status: "unreachable",
            health: {
              lastCheckedAt: checkedAt,
              lastError: message,
              failureReason: reason,
            },
          });
          throw new HttpError(502, "T3 snapshot is unavailable.", {
            environment: updated,
            cause: message,
            reason,
            failure: buildEnvironmentFailure({ environment: updated ?? environment, reason, message }),
          });
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
          snapshot = await readT3Snapshot({ ...environment, timeoutMs: 5000 });
        } catch (error) {
          throw new HttpError(502, "T3 snapshot is unavailable.", { cause: errorMessage(error) });
        }
        const { harnesses, catalogueSource } = await resolveEnvironmentHarnesses(environment, snapshot);
        return sendJson(res, 200, {
          harnesses,
          usable: usableHarnesses(harnesses).map((harness) => harness.instanceId),
          modelSelection: resolveModelSelection({ harnesses }),
          sessionFailures: extractSessionFailures(snapshot),
          catalogueSource,
        });
      }

      // A live thread subscription exists only while somebody says they are looking. This is that
      // statement, and it is a LEASE rather than a registration: it expires unless renewed, so a
      // console that crashes or a tab that is closed costs a socket for at most one TTL. The
      // DELETE is the polite early release, not the only way out.
      //
      // Deliberately rate-limited as a read: a watching client renews on a timer, and this neither
      // writes to the store nor reaches T3 — the tick in src/threadStream.mjs does that.
      const threadWatchMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/threads\/([^/]+)\/watch$/u);
      if (req.method === "POST" && threadWatchMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, threadWatchMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        // The snapshot poller still serves this user's environment health and screen, which the
        // thread stream does not cover; watching a thread is also proof of presence.
        snapshotPoller.trackUser(user.id);
        const watch = threadStreams.watch({
          userId: user.id,
          environmentId: environment.id,
          threadId: decodeURIComponent(threadWatchMatch[2]),
        });
        if (!watch) throw new HttpError(400, "A thread id is required.");
        return sendJson(res, 200, { watch });
      }

      if (req.method === "DELETE" && threadWatchMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const released = threadStreams.unwatch({
          userId: user.id,
          environmentId: threadWatchMatch[1],
          threadId: decodeURIComponent(threadWatchMatch[2]),
        });
        return sendJson(res, 200, { released });
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
        const snapshot = await readT3Snapshot({ ...environment, timeoutMs: 5000 });
        const project = snapshot.projects?.find((candidate) => candidate.id === projectId);
        if (!project) throw new HttpError(404, "T3 project not found.");
        const requestedModelSelection = normalizeT3ModelSelection(body.modelSelection);
        const projectDefaultModelSelection = normalizeT3ModelSelection(project.defaultModelSelection);
        const { harnesses, catalogueSource } = await resolveEnvironmentHarnesses(environment, snapshot);
        const invalid = requestedModelSelection
          ? validateModelSelection(requestedModelSelection, harnesses)
          : null;
        let modelSelection = resolveModelSelection({
          harnesses,
          requested: requestedModelSelection,
          projectDefault: projectDefaultModelSelection,
        });
        let modelRecovery = null;
        if (invalid) {
          if (!modelSelection) {
            throw new HttpError(422, invalid.reason, {
              modelSelection: requestedModelSelection,
              ...(invalid.known ? { known: invalid.known } : {}),
              catalogueSource,
            });
          }
          modelRecovery = {
            requested: requestedModelSelection,
            selected: modelSelection,
            reason: invalid.reason,
            catalogueSource,
          };
        }
        if (!modelSelection) {
          throw new HttpError(409, "T3 did not report an available provider model.", {
            catalogueSource,
          });
        }
        const startedAt = Date.now();
        // A first turn carries media on exactly the same terms as a follow-up turn: same
        // ownership, kind and count validation, same signed-link-plus-inline attachment shape.
        const mediaUploadIds = collectMediaUploadIds(null, body);
        const attachments = await buildMediaAttachments({
          store,
          userId: user.id,
          mediaUploadIds,
          config,
          baseUrl: config.publicBaseUrl ?? requestBaseUrl(req),
        });
        const launch = buildT3ProjectLaunchCommands({
          project,
          text,
          modelSelection,
          runtimeMode: normalizeT3RuntimeMode(body.runtimeMode),
          interactionMode: normalizeT3InteractionMode(body.interactionMode),
          attachments,
        });
        const launchIntent = {
          type: "agent_prompt",
          text,
          ...(mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
        };
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
            intent: launchIntent,
            normalized: storableT3Command({
              type: "thread.launch",
              ...launch,
              ...(modelRecovery ? { modelRecovery } : {}),
            }),
            status: "failed",
            risk: "medium",
            result: {
              ...t3FailureResult(error),
              ...(modelRecovery ? { modelRecovery } : {}),
            },
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
          intent: launchIntent,
          normalized: storableT3Command({
            type: "thread.launch",
            ...launch,
            ...(modelRecovery ? { modelRecovery } : {}),
          }),
          status: "dispatched",
          risk: "medium",
          result: {
            ...result,
            ...(modelRecovery ? { modelRecovery } : {}),
          },
          metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
        });
        return sendJson(res, 202, {
          project,
          threadId: launch.threadId,
          modelSelection,
          modelRecovery,
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

      if (req.method === "GET" && url.pathname === "/v1/actions") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const [actions, devices] = await Promise.all([store.listActions(user.id), store.listDevices(user.id)]);
        const deviceIdsByAction = new Map(actions.map((action) => [action.id, []]));
        for (const device of devices) {
          const layout = await store.getDeviceControls({ userId: user.id, deviceId: device.id });
          if (!layout?.explicit) continue;
          for (const item of layout.items) {
            if (item.actionId && deviceIdsByAction.has(item.actionId)) {
              deviceIdsByAction.get(item.actionId).push(device.id);
            }
          }
        }
        return sendJson(res, 200, {
          actions: actions.map((action) => ({
            ...action,
            deviceIds: [...new Set(deviceIdsByAction.get(action.id) ?? [])],
          })),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const input = normalizeActionInput(await readJson(req));
        await validateSavedActionInput(store, user.id, input);
        const action = await store.createAction({ userId: user.id, ...input });
        return sendJson(res, 201, { action });
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

      if (req.method === "GET" && url.pathname === "/v1/settings/remote-access") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, {
          remoteAccess: await remoteAccessStatus(url.searchParams.get("refresh") === "1"),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/settings/remote-access/serve") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean.");
        try {
          await remoteAccessControl({ enabled: body.enabled, gatewayPort: config.port, httpsPort: 443 });
        } catch (error) {
          throw new HttpError(409, errorMessage(error));
        }
        remoteAccessCache = null;
        remoteAccessCacheExpiresAt = 0;
        return sendJson(res, 200, { remoteAccess: await remoteAccessStatus(true) });
      }

      if (req.method === "GET" && url.pathname === "/v1/settings/t3-compatibility") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const environments = await store.listEnvironments(user.id);
        const release = await t3ReleaseStatus();
        const results = environments.map((environment) => environment.health?.compatibility ?? {
          environmentId: environment.id,
          environmentLabel: environment.label,
          checkedAt: null,
          installedVersion: null,
          status: "unchecked",
          compatible: false,
          breakingRisk: false,
          checks: [],
          findings: [],
          recommendation: "Run a compatibility check to read this T3 Code version.",
          recommendedVersion: release.recommendedVersion,
          minimumVersion: release.minimumVersion,
          maximumTestedVersion: release.maximumTestedVersion,
          latestVersion: release.latestVersion,
        });
        return sendJson(res, 200, {
          release,
          results,
          summary: summarizeT3Compatibility(results, release),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/settings/t3-compatibility") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const environmentId = optionalString(body.environmentId);
        const listed = await store.listEnvironments(user.id);
        const targets = environmentId
          ? listed.filter((environment) => environment.id === environmentId)
          : listed;
        if (environmentId && targets.length === 0) throw new HttpError(404, "Environment not found.");

        const release = await t3ReleaseStatus();
        const results = [];
        for (const listedEnvironment of targets) {
          const environment = await store.getEnvironmentForUser(user.id, listedEnvironment.id);
          if (!environment) continue;
          const result = await runT3CompatibilityCheck({
            environment,
            latestVersion: release.latestVersion,
            previous: listedEnvironment.health?.compatibility ?? null,
            rpcImpl: t3CompatibilityRpc,
          });
          await store.updateEnvironmentHealth({
            userId: user.id,
            environmentId: environment.id,
            health: { compatibility: result },
          });
          results.push(result);
        }
        return sendJson(res, 200, {
          release,
          results,
          summary: summarizeT3Compatibility(results, release),
        });
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
        // Only the transition into completed needs operational evidence. Re-saving an already
        // completed setup has to stay possible after a dependency is removed, or the owner is
        // locked out of their own onboarding record.
        if (candidate.status === "completed"
          && current.status !== "completed"
          && !candidateResponse.readiness.ready) {
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
          ? await approveCommand({ store, userId: user.id, commandId, config })
          : await rejectCommand({ store, userId: user.id, commandId });
        return sendJson(res, action === "approve" ? 202 : 200, output);
      }

      const savedActionMatch = url.pathname.match(/^\/v1\/actions\/([^/]+)(?:\/(run))?$/u);
      if (savedActionMatch && req.method === "GET" && !savedActionMatch[2]) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const action = await store.getActionForUser(user.id, savedActionMatch[1]);
        if (!action) throw new HttpError(404, "Action not found.");
        return sendJson(res, 200, { action });
      }

      if (savedActionMatch && req.method === "PUT" && !savedActionMatch[2]) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const existing = await store.getActionForUser(user.id, savedActionMatch[1]);
        if (!existing) throw new HttpError(404, "Action not found.");
        const input = normalizeActionInput(await readJson(req), existing);
        if (["media", "macro"].includes(input.type) && input.type !== existing.type) {
          const referencingMacroIds = await referencingMacroActionIds(store, user.id, existing.id);
          if (referencingMacroIds.length > 0) {
            throw new HttpError(409, "An action used by a macro cannot be changed to media or macro.", { referencingMacroIds });
          }
        }
        await validateSavedActionInput(store, user.id, input, existing.id);
        const action = await store.updateAction({ userId: user.id, actionId: existing.id, ...input });
        return sendJson(res, 200, { action });
      }

      if (savedActionMatch && req.method === "DELETE" && !savedActionMatch[2]) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const referencingMacroIds = await referencingMacroActionIds(store, user.id, savedActionMatch[1]);
        if (referencingMacroIds.length > 0) {
          throw new HttpError(409, "Remove this action from its macros before deleting it.", { referencingMacroIds });
        }
        const result = await store.deleteAction({ userId: user.id, actionId: savedActionMatch[1] });
        if (!result) throw new HttpError(404, "Action not found.");
        return sendJson(res, 200, { ...result, deleted: true });
      }

      if (savedActionMatch && req.method === "POST" && savedActionMatch[2] === "run") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const action = await store.getActionForUser(user.id, savedActionMatch[1]);
        if (!action) throw new HttpError(404, "Action not found.");
        const output = await executeSavedAction({
          store,
          action,
          runtime: body,
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
        return sendJson(res, actionRunStatus(output), { action, ...output });
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
        if (macro.disabled) throw new HttpError(409, disabledRecordMessage("macro", macro));
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
        // Named on the way out, never in storage: see nameMediaRecords().
        return sendJson(res, 200, {
          media: await nameMediaRecords(store, user.id, await store.listMediaUploads(user.id), config),
        });
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
        return sendJson(res, 201, { media: await nameMediaRecord(store, user.id, media, config) });
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
        return sendJson(res, 200, { media: await nameMediaRecord(store, user.id, media, config) });
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

      // Job reads sit above the bare /v1/media/:id match, which would otherwise swallow "jobs".
      if (req.method === "GET" && url.pathname === "/v1/media/jobs") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const jobs = await store.listMediaJobs({
          userId: user.id,
          ...(url.searchParams.get("mediaId") ? { mediaId: url.searchParams.get("mediaId") } : {}),
          ...(url.searchParams.get("stage") ? { stage: url.searchParams.get("stage") } : {}),
        });
        return sendJson(res, 200, { jobs: jobs.map(withTranscriptChange) });
      }

      // The explicit retry path for jobs that failed on the deployment rather than on the audio.
      // A POST an owner makes, and nothing else: no poller tick, no boot hook, no automatic sweep
      // after a config change. See retryConfigurationFailures() for why that matters.
      if (req.method === "POST" && url.pathname === "/v1/media/jobs/retry-configuration") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        return await retryConfigurationFailures({
          store,
          config,
          res,
          userId: user.id,
          jobIds: Array.isArray(body?.jobIds) ? body.jobIds : null,
        });
      }

      const mediaJobMatch = url.pathname.match(/^\/v1\/media\/jobs\/([^/]+)$/u);
      if (req.method === "GET" && mediaJobMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserRead(req, res, rateLimiter, config, user);
        const job = await store.getMediaJobForUser(user.id, mediaJobMatch[1]);
        if (!job) throw new HttpError(404, "Media job not found.");
        return sendJson(res, 200, { job: withTranscriptChange(job) });
      }

      // The review gate. Accepting or correcting a transcript writes a new *version* — the raw ASR
      // output stays exactly as the provider returned it — and re-arms the job for dispatch.
      const mediaJobTranscriptMatch = url.pathname.match(/^\/v1\/media\/jobs\/([^/]+)\/transcript$/u);
      if (req.method === "POST" && mediaJobTranscriptMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const existing = await store.getMediaJobForUser(user.id, mediaJobTranscriptMatch[1]);
        if (!existing) throw new HttpError(404, "Media job not found.");
        if (!["review_required", "ready", "dispatched"].includes(existing.stage)) {
          throw new HttpError(409, `A media job at stage ${existing.stage} cannot be reviewed yet.`);
        }
        const job = await store.updateMediaJob({
          jobId: existing.id,
          userId: user.id,
          userEditedTranscript: requireString(body.transcript, "transcript"),
          stage: "ready",
          lastError: null,
          failureKind: null,
          timings: { reviewedAt: new Date().toISOString() },
        });
        return sendJson(res, 200, { job: withTranscriptChange(job) });
      }

      const mediaTranscribeMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/transcribe$/u);
      if (req.method === "POST" && mediaTranscribeMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        await enforceUserWrite(req, res, rateLimiter, config, user);
        return await enqueueTranscription({
          store,
          config,
          userId: user.id,
          mediaId: mediaTranscribeMatch[1],
          res,
        });
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
        return sendJson(res, 200, { media: await nameMediaRecord(store, user.id, deleted, config) });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/heartbeat") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceHeartbeat(req, res, rateLimiter, config, device);
        snapshotPoller.trackUser(device.userId);
        const body = await readJson(req);
        const updatedDevice = await store.recordDeviceHeartbeat({
          deviceId: device.id,
          status: { ...(body.status ?? body), ...(body.gateway ? { gateway: body.gateway } : {}) },
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
            cache: true,
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
        const gateway = await deviceGatewayResponse(store, device);
        return sendJson(res, 200, {
          deviceId: device.id,
          config: {
            ...device.config,
            gatewayProfiles: gateway.profiles,
            activeGatewayProfileId: gateway.activeProfileId,
            gatewaySelection: gateway,
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/gateway") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, await deviceGatewayResponse(store, device));
      }

      if (req.method === "POST" && url.pathname === "/v1/device/gateway/switch") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const revision = Number(body.revision);
        if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, "revision must be a non-negative integer.");
        const profileId = requireString(body.profileId, "profileId");
        const status = requireString(body.status, "status");
        if (!["requested", "applied", "failed"].includes(status)) {
          throw new HttpError(400, "status must be requested, applied, or failed.");
        }
        const profile = await store.getGatewayProfileForUser(device.userId, profileId);
        if (!profile) throw new HttpError(404, "Gateway profile not found.");
        if (body.activeUrl) {
          let activeOrigin;
          try { activeOrigin = new URL(requireString(body.activeUrl, "activeUrl")).origin; }
          catch { throw new HttpError(400, "activeUrl must be a valid URL."); }
          if (new URL(profile.url).origin !== activeOrigin) {
            throw new HttpError(409, "activeUrl does not match the selected gateway profile.");
          }
        }
        const result = await store.reportDeviceGatewaySwitch({
          userId: device.userId, deviceId: device.id, revision, profileId, status,
          detail: optionalString(body.detail) ?? null,
        });
        if (!result) throw new HttpError(409, "Gateway switch could not be recorded.");
        if (result.conflict) throw new HttpError(409, "Gateway switch revision or pending profile does not match.", {
          gateway: await deviceGatewayResponse(store, device, result.selection),
        });
        return sendJson(res, 200, await deviceGatewayResponse(store, device, result.selection));
      }

      if (req.method === "GET" && url.pathname === "/v1/device/controls") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const stored = await store.getDeviceControls({ userId: device.userId, deviceId: device.id });
        if (!stored?.explicit) throw new HttpError(404, "No protocol-v2 controls layout is assigned.");
        const controls = await resolveDeviceControls({ store, device, stored, config, forFirmware: true });
        return sendJson(res, 200, { revision: stored.revision, controls });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/controls/ack") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const revision = Number(body.revision);
        if (!Number.isInteger(revision) || revision < 1) {
          throw new HttpError(400, "revision must be a positive integer.");
        }
        const stored = await store.getDeviceControls({ userId: device.userId, deviceId: device.id });
        if (!stored?.explicit) throw new HttpError(404, "No protocol-v2 controls layout is assigned.");
        const resolved = await resolveDeviceControls({ store, device, stored, config, forFirmware: true });
        const appliedCount = body.appliedCount === undefined ? null : Number(body.appliedCount);
        if (appliedCount !== null && (!Number.isInteger(appliedCount) || appliedCount < 0)) {
          throw new HttpError(400, "appliedCount must be a non-negative integer.");
        }
        const result = await store.acknowledgeDeviceControls({
          userId: device.userId,
          deviceId: device.id,
          revision,
          status: optionalString(body.status) ?? "applied",
          error: optionalString(body.error),
          appliedCount,
          expectedCount: resolved.length,
        });
        if (result?.reason) {
          throw new HttpError(409, "Controls acknowledgement does not match the current layout.", {
            reason: result.reason,
            currentRevision: result.controls.revision,
            appliedRevision: result.controls.appliedRevision,
          });
        }
        return sendJson(res, 200, { acknowledged: true, revision });
      }

      const deviceSavedActionRunMatch = url.pathname.match(/^\/v1\/device\/actions\/([^/]+)\/run$/u);
      if (req.method === "POST" && deviceSavedActionRunMatch) {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const actionId = deviceSavedActionRunMatch[1];
        const layout = await store.getDeviceControls({ userId: device.userId, deviceId: device.id });
        if (!layout?.explicit) throw new HttpError(403, "This device has no assigned controls layout.");
        const assigned = layout.items.some((item) => item.actionId === actionId)
          || layout.items.some((item) => !item.actionId && item.id === actionId && systemDeviceAction(actionId));
        if (!assigned) {
          throw new HttpError(403, "This action is not assigned to the device.");
        }
        const body = await readJson(req);
        const action = await systemDeviceAction(actionId) ?? await store.getActionForUser(device.userId, actionId);
        if (!action) throw new HttpError(404, "Action not found.");
        if (action.type === "media") {
          const mediaUploadId = requireString(body.mediaUploadId, "mediaUploadId");
          const media = await store.getMediaForUser(device.userId, mediaUploadId);
          if (!media || media.deviceId !== device.id) {
            await store.recordActionRun?.({
              userId: device.userId,
              actionId: action.id,
              actorType: "device",
              actorId: device.id,
              status: "blocked",
              intentType: action.payload.mediaKind === "audio" ? "audio_prompt" : "camera_prompt",
            });
            throw new HttpError(403, "Device media actions may only use media captured by this device.");
          }
          if (media.kind !== action.payload.mediaKind) {
            await store.recordActionRun?.({
              userId: device.userId,
              actionId: action.id,
              actorType: "device",
              actorId: device.id,
              status: "blocked",
              intentType: action.payload.mediaKind === "audio" ? "audio_prompt" : "camera_prompt",
            });
            throw new HttpError(409, `This action requires ${action.payload.mediaKind} media.`);
          }
        }
        // Follow-up recommendations are optional enrichment for actions that start an agent turn.
        // Built-in Status/Stop never produce an assistant response, so resolving the entire Action
        // Library here only adds failure modes to otherwise independent system controls. Likewise,
        // a stale unrelated library entry must not prevent a valid saved action from running.
        let followUpInstruction = null;
        if (!systemDeviceAction(actionId)) {
          try {
            const resolvedControls = await resolveDeviceControls({
              store,
              device,
              stored: layout,
              config,
              forFirmware: true,
            });
            followUpInstruction = buildDeviceFollowUpInstruction(resolvedControls, actionId);
          } catch (error) {
            console.warn(`[follow-ups] skipped for device action ${actionId}: ${errorMessage(error)}`);
          }
        }
        const output = await executeSavedAction({
          store,
          action,
          runtime: {
            environmentId: device.config?.environmentId,
            threadId: device.config?.threadId,
            mediaUploadId: optionalString(body.mediaUploadId),
            __followUpInstruction: followUpInstruction,
          },
          actor: { type: "device", id: device.id, userId: device.userId, profile: device.profile },
          config,
          baseUrl: requestBaseUrl(req),
          policyContext: { networkLocation: classifyNetworkLocation(req, config) },
        });
        return sendJson(res, actionRunStatus(output), {
          actionId,
          responseAfter: actionResponseAfter(output),
          ...output,
        });
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
        const snapshot = await fetchDeviceSnapshot(environment);
        const threads = deviceSelectableThreads(snapshot, device.config?.threadId, device.config?.projectId);
        return sendJson(res, 200, {
          environmentId: environment.id,
          projectId: device.config?.projectId ?? null,
          threadId: device.config?.threadId ?? null,
          threads: await refineSelectedThreadVerb(environment, threads),
        });
      }

      // Creating a thread inside the bound project, from hardware that has no keyboard.
      //
      // Listing and selecting were never enough. A project with no threads left the controller
      // with nothing to point at and no way out except the web console, which is the one place
      // the owner is not standing when they pick the device up.
      //
      // T3 needs no new transport for this: `thread.create` is a member of
      // `ClientOrchestrationCommand`, the payload schema of the same
      // `POST /api/orchestration/dispatch` the gateway already speaks — see the contract citations
      // on `buildT3ThreadCreateCommand()` in `src/t3Client.mjs`.
      if (req.method === "POST" && url.pathname === "/v1/device/threads") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const requestedTitle = normalizeTitle(body.title);
        const environment = await boundDeviceEnvironment(store, device);
        // A thread has to be created *somewhere*. Unlike thread selection, which can fall back to
        // the whole environment, there is no defensible default folder to invent — so the same 409
        // the project routes answer with, rather than a guess.
        const projectId = optionalString(device.config?.projectId);
        if (!projectId) throw new HttpError(409, "Device has no project selected.");

        // Creating a thread writes to the owner's T3 environment, so it is gated like a dispatch
        // rather than like a selection: `read-only` hardware browses, it does not create. Running
        // the full engine rather than a lone capability check means a viewer role, a blocked
        // network and a read-only environment all keep meaning what they mean everywhere else.
        const policy = evaluateIntentPolicy({
          device: { profile: await resolveActorProfile(store, device.userId, device.profile) },
          intent: { type: "thread_create" },
          environment,
          networkLocation: classifyNetworkLocation(req, config),
          ...(config.policyAllowedHours ? { allowedHours: config.policyAllowedHours } : {}),
        });
        if (!policy.allowed) {
          // Deliberately refused rather than parked for approval. A thread that exists only once
          // an owner walks to a browser is a thread the device still cannot select, which is the
          // dead end this route was added to remove — so a policy that will not allow the create
          // says so now, with its reason, instead of leaving the hardware waiting on nothing.
          throw new HttpError(403, "Thread creation blocked by policy.", {
            policy: policyResult(policy),
            ...(policy.requiresApproval ? { requiresApproval: true } : {}),
          });
        }

        const snapshot = await fetchDeviceSnapshot(environment);
        const project = (Array.isArray(snapshot?.projects) ? snapshot.projects : [])
          .find((candidate) => optionalString(candidate?.id) === projectId);
        // Validated against the live snapshot for the same reason selection is: the bound project
        // id is stored state, and a folder deleted in T3 since must not become a create target.
        if (!project) throw new HttpError(404, "Project not found in the bound environment.");

        // `thread.create` requires a model selection, and a bezel has no business choosing one.
        // The project's own default is the owner's answer to that question; snapshot-derived
        // harnesses are the fallback for a project that never set one. Deliberately no live
        // catalogue read — `resolveEnvironmentHarnesses()` opens a WebSocket with an eight-second
        // timeout, which is not something to put in front of a battery-powered controller when the
        // snapshot already in hand answers the question in the overwhelming majority of cases.
        const modelSelection = normalizeT3ModelSelection(project.defaultModelSelection)
          ?? resolveModelSelection({ harnesses: extractHarnesses(snapshot) });
        if (!modelSelection) {
          throw new HttpError(409, "T3 did not report an available provider model.", {
            code: "no_model_selection",
            environmentId: environment.id,
            projectId,
          });
        }

        const threadId = createId("thread");
        const title = mintDeviceThreadTitle({
          environmentId: environment.id,
          device,
          snapshot,
          requestedTitle,
          threadId,
        });
        const createThread = buildT3ThreadCreateCommand({
          project,
          title,
          modelSelection,
          threadId,
        });
        const intent = { type: "thread_create", projectId, title, ...(requestedTitle ? { titleSource: "device" } : { titleSource: "gateway" }) };
        const startedAt = Date.now();
        const dispatchStartedAt = Date.now();
        let result;
        try {
          result = await dispatchT3Command(environment, createThread);
        } catch (error) {
          const command = await store.createCommand({
            userId: device.userId,
            deviceId: device.id,
            environmentId: environment.id,
            threadId,
            intent,
            normalized: storableT3Command(createThread),
            status: "failed",
            risk: policy.risk,
            result: t3FailureResult(error),
            metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true }),
          });
          // The same error contract every other device route that reaches T3 answers with, so the
          // firmware branches on one code rather than four.
          throw new HttpError(502, "T3 environment is unavailable.", {
            code: "t3_unreachable",
            environmentId: environment.id,
            cause: errorMessage(error),
            command,
          });
        }

        // Creating and not selecting would be half the job: the device asked for a thread because
        // it had none, and the only other way to bind one is POST /v1/device/config/thread, which
        // validates against the live snapshot — and T3's dispatch returns as soon as the event is
        // appended, before the projection the snapshot reads from has caught up. That follow-up
        // call can therefore 404 on a thread that certainly exists. Binding here sidesteps a race
        // the firmware has no way to resolve, and matches what the console's project launch does.
        const updated = await store.updateDeviceConfig({
          userId: device.userId,
          deviceId: device.id,
          config: { threadId },
          actorType: "device",
          actorId: device.id,
        });
        if (!updated) throw new HttpError(404, "Device not found.");

        const command = await store.createCommand({
          userId: device.userId,
          deviceId: device.id,
          environmentId: environment.id,
          threadId,
          intent,
          normalized: storableT3Command(createThread),
          status: "completed",
          risk: policy.risk,
          result: result ?? { accepted: true },
          metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
        });

        return sendJson(res, 201, {
          environmentId: environment.id,
          projectId,
          threadId,
          // Shaped exactly like a row from GET /v1/device/threads so the firmware can splice it
          // into the list it already renders instead of re-fetching to learn what it just made.
          thread: { id: threadId, title, status: "idle", selected: true },
          config: updated.config,
          command,
        });
      }

      // The environments the owner holds. Unlike every other device route that reaches T3
      // this one answers with no environment bound — a device that has none is exactly the
      // device that needs the list, so a 409 here would be a locked door with the key inside.
      if (req.method === "GET" && url.pathname === "/v1/device/environments") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        // Scoped to the owner, not to the platform: listEnvironments() is a per-user read,
        // so a device can only ever see what the account that claimed it owns.
        const environments = await store.listEnvironments(device.userId);
        return sendJson(res, 200, {
          environmentId: device.config?.environmentId ?? null,
          environments: deviceSelectableEnvironments(environments, device.config?.environmentId),
        });
      }

      // Projects ("folders") inside the bound environment. 409 with no environment bound,
      // matching the thread routes: there is nothing to enumerate until the boundary exists.
      if (req.method === "GET" && url.pathname === "/v1/device/projects") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const environment = await boundDeviceEnvironment(store, device);
        const snapshot = await fetchDeviceSnapshot(environment);
        return sendJson(res, 200, {
          environmentId: environment.id,
          projectId: device.config?.projectId ?? null,
          projects: deviceSelectableProjects(snapshot, device.config?.projectId),
        });
      }

      // A controller receives only the currently selected thread's display-safe page.
      // It cannot supply an arbitrary thread id, and model-proposed actions are reduced
      // to assigned, enabled opaque ids before they cross the device boundary.
      if (req.method === "GET" && url.pathname === "/v1/device/thread-output") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const threadId = optionalString(device.config?.threadId);
        if (!threadId) throw new HttpError(409, "Device has no thread selected.");
        const pageText = url.searchParams.get("page") ?? "0";
        if (!/^\d+$/u.test(pageText)) throw new HttpError(400, "page must be a non-negative integer.");
        const after = optionalString(url.searchParams.get("after"));
        if (after && !Number.isFinite(Date.parse(after))) throw new HttpError(400, "after must be an ISO timestamp.");
        const environment = await boundDeviceEnvironment(store, device);
        // A controller reading its thread IS a watcher, and it has no way to say so — there is no
        // device-facing watch route and a few square centimetres of screen should not have to
        // manage a lease. Renewing here means the owner's console sees the same thread stream live
        // while the hardware is looking at it, and the subscription lapses on its own once the
        // device stops polling.
        threadStreams.watch({ userId: device.userId, environmentId: environment.id, threadId });
        const snapshot = await fetchDeviceSnapshot(environment);
        const thread = (Array.isArray(snapshot?.threads) ? snapshot.threads : [])
          .find((candidate) => optionalString(candidate?.id) === threadId);
        if (!thread) throw new HttpError(404, "Selected thread was not found in the bound environment.");
        const stored = await store.getDeviceControls({ userId: device.userId, deviceId: device.id });
        const controls = stored?.explicit
          ? await resolveDeviceControls({ store, device, stored, config, forFirmware: true })
          : [];
        return sendJson(res, 200, buildDeviceThreadOutput({
          thread,
          controls,
          page: Number.parseInt(pageText, 10),
          after,
        }));
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
        const snapshot = await fetchDeviceSnapshot(environment);
        const threads = deviceSelectableThreads(snapshot, device.config?.threadId, device.config?.projectId);
        // Validated against the live snapshot, so a device cannot invent a thread id
        // or reach one belonging to a different environment — or, once a project is
        // selected, to a different folder.
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

      // Binding an environment is the one place the hardware may move its own boundary.
      // It is still fenced by ownership: the id has to resolve through the claiming
      // user's own scope, so another account's environment is simply not found.
      if (req.method === "POST" && url.pathname === "/v1/device/config/environment") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const environmentId = requireString(body.environmentId, "environmentId");
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        // An expired token is not a reason to refuse the binding: the device can see the
        // expiry in the listing, and the routes that actually reach T3 already 409 on it.
        // Refusing here would leave a re-paired environment unselectable from the bezel.
        const changed = optionalString(device.config?.environmentId) !== environment.id;
        const updated = await store.updateDeviceConfig({
          userId: device.userId,
          deviceId: device.id,
          // A project and a thread only mean something inside the environment that held
          // them. Carrying them across would point the device at ids the new environment
          // has never heard of, so a real change clears both.
          config: changed
            ? { environmentId: environment.id, projectId: null, threadId: null }
            : { environmentId: environment.id },
          actorType: "device",
          actorId: device.id,
        });
        if (!updated) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: updated.id, config: updated.config });
      }

      // Selecting the folder the device works inside. Same shape as thread selection:
      // validated against the live snapshot of the bound environment, never against an
      // id the hardware supplies on its own authority.
      if (req.method === "POST" && url.pathname === "/v1/device/config/project") {
        const device = await authenticateDevice(req, store, url, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const projectId = requireString(body.projectId, "projectId");
        const environment = await boundDeviceEnvironment(store, device);
        const snapshot = await fetchDeviceSnapshot(environment);
        const projects = deviceSelectableProjects(snapshot, device.config?.projectId);
        if (!projects.some((project) => project.id === projectId)) {
          throw new HttpError(404, "Project not found in the bound environment.");
        }
        // A thread outside the newly chosen folder would survive as a selection the
        // thread list no longer offers — visible nowhere, still driving every dispatch.
        const currentThreadId = optionalString(device.config?.threadId);
        const keepsThread = currentThreadId !== null
          && snapshotThreadProjectId(snapshot, currentThreadId) === projectId;
        const updated = await store.updateDeviceConfig({
          userId: device.userId,
          deviceId: device.id,
          config: keepsThread ? { projectId } : { projectId, threadId: null },
          actorType: "device",
          actorId: device.id,
        });
        if (!updated) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: updated.id, config: updated.config });
      }

      const deviceFirmwareArtifactMatch = url.pathname.match(/^\/v1\/device\/firmware\/artifacts\/([a-f0-9]{64})$/u);
      if (req.method === "GET" && deviceFirmwareArtifactMatch) {
        const headerDeviceId = optionalString(req.headers["x-device-id"]);
        const headerDeviceSecret = optionalString(req.headers["x-device-secret"]);
        if (Boolean(headerDeviceId) !== Boolean(headerDeviceSecret)) {
          throw new HttpError(400, "Both x-device-id and x-device-secret are required for device authentication.");
        }
        let device = null;
        let hardwareModel;
        if (headerDeviceId && headerDeviceSecret) {
          device = await authenticateDevice(req, store, url, config);
          await enforceDeviceRead(req, res, rateLimiter, config, device);
          requireClaimedDevice(device);
          hardwareModel = optionalString(device.status?.hardwareModel) ?? config.defaultHardwareModel;
        } else {
          hardwareModel = requireString(url.searchParams.get("hardware"), "hardware");
        }
        const release = await store.getFirmwareArtifact({ sha256: deviceFirmwareArtifactMatch[1], hardwareModel });
        if (!release) throw new HttpError(404, "Firmware artifact not found for this hardware.");
        if (device) {
          const policy = await store.getDeviceFirmwarePolicy({ userId: device.userId, deviceId: device.id });
          if ((release.channel ?? "stable") !== (policy?.channel ?? "stable")
            && policy?.desiredVersion !== release.version && !release.mandatory) {
            throw new HttpError(403, "Firmware artifact is not allowed by this device's release policy.");
          }
        } else if (!verifyFirmwareArtifactCapability({
          sha256: release.sha256,
          hardwareModel: release.hardwareModel,
          expires: url.searchParams.get("expires"),
          token: url.searchParams.get("token"),
          signingKey: firmwareDownloadSigningKey(config),
          ttlSeconds: config.firmwareDownloadTtlSeconds,
        })) {
          throw new HttpError(403, "Firmware download capability is invalid or expired.");
        }
        const artifact = await readFirmwareArtifact(release, config);
        return sendBuffer(res, 200, artifact, {
          "content-type": "application/octet-stream",
          "cache-control": device ? "private, max-age=31536000, immutable" : "private, no-store",
          "content-disposition": `attachment; filename="agent-controller-${release.version}.bin"`,
          "x-firmware-sha256": release.sha256,
        });
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
        const policy = await store.getDeviceFirmwarePolicy({ userId: device.userId, deviceId: device.id });
        let release = await store.getLatestFirmwareRelease({ hardwareModel, channel: policy?.channel ?? "stable" });
        if (policy?.desiredVersion) {
          const releases = await store.listFirmwareReleases({
            hardwareModel,
            channel: policy.channel ?? "stable",
          });
          release = releases.find((candidate) => candidate.version === policy.desiredVersion) ?? null;
        }
        if (!release) {
          return sendJson(res, 200, {
            updateAvailable: false,
            currentVersion,
            hardwareModel,
            reason: "no_release",
            policy,
          });
        }
        if (!isNewerVersion(release.version, currentVersion)) {
          return sendJson(res, 200, {
            updateAvailable: false,
            currentVersion,
            hardwareModel,
            latestVersion: release.version,
            reason: "current",
            policy,
          });
        }
        // A newer compatible release is visible to controllers that advertise the local-confirm
        // interaction. Older firmware treated every updateAvailable response as permission to
        // write flash, so it must retain the historical false response under manual/notify policy.
        // Explicitly queued, automatic, and mandatory releases keep the unattended install path.
        const supportsLocalConfirmation = Array.isArray(device.status?.features)
          && device.status.features.includes("ota_confirm");
        if (!release.mandatory && !policy?.desiredVersion && policy?.updateMode !== "automatic"
          && !supportsLocalConfirmation) {
          return sendJson(res, 200, {
            updateAvailable: false,
            currentVersion,
            hardwareModel,
            latestVersion: release.version,
            reason: "manual_or_notify",
            policy,
          });
        }
        const installation = release.mandatory || policy?.desiredVersion || policy?.updateMode === "automatic"
          ? "automatic"
          : "confirm";
        return sendJson(res, 200, {
          updateAvailable: true,
          currentVersion,
          hardwareModel,
          installation,
          policy,
          manifest: buildFirmwareManifest({
            ...release,
            url: buildFirmwareArtifactUrl({
              release,
              baseUrl: requestBaseUrl(req),
              signingKey: firmwareDownloadSigningKey(config),
              ttlSeconds: config.firmwareDownloadTtlSeconds,
            }),
          }, signingKey),
        });
      }

      if (req.method === "POST"
        && ["/v1/device/firmware/status", "/v1/device/firmware/report"].includes(url.pathname)) {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const body = await readJson(req);
        const state = requireString(body.state, "state");
        if (![
          "available", "downloading", "installing", "rebooting", "verified", "failed", "rolled_back",
        ].includes(state)) {
          throw new HttpError(400, "Unsupported firmware update state.");
        }
        const currentPolicy = await store.getDeviceFirmwarePolicy({ userId: device.userId, deviceId: device.id });
        const reportedVersion = optionalString(body.version);
        const targetVersion = optionalString(body.targetVersion);
        const fulfilledDesiredVersion = state === "verified"
          && currentPolicy?.desiredVersion
          && [reportedVersion, targetVersion].includes(currentPolicy.desiredVersion);
        const policy = await store.updateDeviceFirmwarePolicy({
          userId: device.userId,
          deviceId: device.id,
          actorType: "device",
          actorId: device.id,
          policy: {
            lastUpdateStatus: state,
            lastUpdateAt: new Date().toISOString(),
            lastUpdateError: state === "failed" ? optionalString(body.detail) ?? "Firmware update failed." : null,
            targetVersion,
            updateProgress: body.progress,
            ...(fulfilledDesiredVersion ? { desiredVersion: null } : {}),
          },
        });
        if (reportedVersion) {
          await store.recordDeviceHeartbeat({
            deviceId: device.id,
            status: { ...device.status, firmwareVersion: reportedVersion },
          });
        }
        return sendJson(res, 200, { accepted: true, policy });
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
          ? await approveCommand({ store, userId: device.userId, commandId, config })
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
        if (macro.disabled) throw new HttpError(409, disabledRecordMessage("macro", macro));
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
        // Audio is queued for transcription here rather than waiting for someone to ask. A
        // controller uploads and moves on, so the one identifier it gets back is the job id: it
        // polls /v1/device/media/jobs/:id and needs nothing else.
        const queued = await enqueueDeviceTranscription({ store, config, events, device, media, body });
        return sendJson(res, 201, { media: queued.media, job: deviceJobStatus(queued.job) });
      }

      // The single status endpoint a controller polls. Deliberately not a view onto the job row:
      // see src/deviceAudio.mjs for what a few square centimetres of screen can actually render.
      const deviceMediaJobMatch = url.pathname.match(/^\/v1\/device\/media\/jobs\/([^/]+)$/u);
      if (req.method === "GET" && deviceMediaJobMatch) {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const job = await store.getMediaJobForUser(device.userId, deviceMediaJobMatch[1]);
        // Scoped to the device that recorded it, not merely to the owner. Two controllers on one
        // account are two microphones in two rooms, and one has no business reading the other's
        // capture — the transcript is in this response.
        if (!job || job.deviceId !== device.id) throw new HttpError(404, "Media job not found.");
        return sendJson(res, 200, { job: deviceJobStatus(job) });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/state") {
        const device = await authenticateDevice(req, store, null, config);
        await enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const environmentId = requireString(url.searchParams.get("environmentId"), "environmentId");
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        const snapshot = await readT3Snapshot(environment);
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
      // A client that gave up and closed its socket is not a server fault, and logging it as one
      // buries real 500s. A controller does exactly this on every request that outlives its own
      // timeout, so on a busy gateway this was the most common "error" in the log — complete with
      // a stack trace pointing into node's http internals, where nothing is wrong.
      const clientVanished = error?.code === "ECONNRESET" || error?.code === "ECONNABORTED"
        || error?.message === "aborted" || res.writableEnded || !res.writable;
      if (clientVanished) {
        // Nothing to answer: the socket is gone. Say so once, quietly, at a level that can be
        // filtered out rather than mistaken for a fault.
        console.warn(`[client-gone] ${req.method} ${req.url}`);
        return;
      }

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
    threadStreams,
    mediaJobRunner,
    server: createServer((req, res) => void handle(req, res)),
  };
}

async function collectEnvironmentDependencies(store, userId, environmentId) {
  const [devices, actions, macros, onboarding] = await Promise.all([
    store.listDevices(userId),
    store.listActions(userId),
    store.listMacros(userId),
    store.getUserOnboarding(userId),
  ]);
  return {
    devices: devices
      .filter((device) => device.config?.environmentId === environmentId)
      .map((device) => ({ id: device.id, label: device.label })),
    actions: actions
      .filter((action) => action.environmentId === environmentId)
      .map((action) => ({ id: action.id, label: action.label })),
    macros: macros
      .filter((macro) => macro.environmentId === environmentId)
      .map((macro) => ({ id: macro.id, label: macro.label })),
    onboarding: onboarding?.environmentId === environmentId,
  };
}

function disabledRecordMessage(kind, record) {
  const cause = record?.disabledReason === ENVIRONMENT_REMOVED_REASON
    ? " because its T3 environment was removed"
    : "";
  return `This ${kind} is disabled${cause}. Save it again with a working target before running it.`;
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

async function validateSavedActionInput(store, userId, input, actionId = null) {
  if (input.environmentId && !(await store.getEnvironmentForUser(userId, input.environmentId))) {
    throw new HttpError(404, "Environment not found.");
  }
  if (input.type !== "macro") return;
  const seen = new Set(actionId ? [actionId] : []);
  for (const step of input.steps) {
    const referenced = await store.getActionForUser(userId, step.actionId);
    if (!referenced) throw new HttpError(404, `Macro step action not found: ${step.actionId}.`);
    await assertMacroStepSupported(store, userId, referenced, new Set());
    if (actionId && await actionReferences(store, userId, referenced, actionId, seen)) {
      throw new HttpError(409, "Macro actions cannot contain a reference cycle.");
    }
  }
}

async function referencingMacroActionIds(store, userId, actionId) {
  return (await store.listActions(userId))
    .filter((action) => action.type === "macro"
      && (action.steps ?? []).some((step) => step.actionId === actionId))
    .map((action) => action.id);
}

async function assertMacroStepSupported(store, userId, action, seen) {
  if (action.type === "media") {
    throw new HttpError(409, "Media actions cannot be used as macro steps because capture requires direct device input.");
  }
  if (action.type === "macro") {
    throw new HttpError(409, "Nested macros are not supported; macro steps must reference prompt or shell actions.");
  }
}

async function actionReferences(store, userId, action, targetId, seen = new Set()) {
  if (action.id === targetId) return true;
  if (action.type !== "macro" || seen.has(action.id)) return false;
  seen.add(action.id);
  for (const step of action.steps ?? []) {
    if (step.actionId === targetId) return true;
    const nested = await store.getActionForUser(userId, step.actionId);
    if (nested && await actionReferences(store, userId, nested, targetId, seen)) return true;
  }
  return false;
}

async function validateDeviceControlAssignments({ store, device, items, config }) {
  for (const item of items) {
    if (!item.actionId) continue;
    const action = await store.getActionForUser(device.userId, item.actionId);
    if (!action) throw new HttpError(404, `Action not found: ${item.actionId}.`);
    const hardware = hardwareSupportsAction(action, device.status);
    if (!hardware.supported) throw new HttpError(409, hardware.reason, { actionId: action.id });
    const availability = await savedActionAvailability({ store, device, action, config });
    if (!availability.enabled && availability.reason?.includes("cannot perform")) {
      throw new HttpError(409, availability.reason, { actionId: action.id });
    }
  }
}

async function resolveDeviceControls({ store, device, stored, config, forFirmware = false }) {
  const labelCharacters = Math.max(1, Math.min(80, Number(device.status?.limits?.labelCharacters) || 18));
  const resolvedLabel = (label) => forFirmware
    ? Array.from(String(label)).slice(0, labelCharacters).join("")
    : String(label);
  const controls = [];
  for (const item of stored.items ?? []) {
    if (!item.actionId) {
      const availability = await systemControlAvailability({ store, device, kind: item.kind, config });
      controls.push({
        id: item.id,
        label: resolvedLabel(item.label),
        kind: item.kind,
        ...(["status", "stop"].includes(item.kind) ? { actionId: SYSTEM_CONTROL_IDS[item.kind] } : {}),
        requiresThread: item.kind === "stop",
        requiresConfirmation: ["stop", "reset"].includes(item.kind),
        enabled: availability.enabled,
        ...(availability.reason ? { reason: availability.reason } : {}),
      });
      continue;
    }
    const action = await store.getActionForUser(device.userId, item.actionId);
    if (!action) {
      controls.push({
        id: item.id,
        label: resolvedLabel(item.label ?? "Unavailable action"),
        kind: "remote_action",
        actionId: item.actionId,
        enabled: false,
        reason: "The saved action was deleted.",
      });
      continue;
    }
    const availability = await savedActionAvailability({ store, device, action, config });
    controls.push({
      id: item.id,
      label: resolvedLabel(item.label ?? action.label),
      kind: actionControlKind(action),
      actionId: action.id,
      ...(action.type === "media" ? { mediaKind: action.payload.mediaKind } : {}),
      // Device-current actions are meaningless until the owner has selected a task. Every saved
      // action receives a local review screen; policy approval remains an independent server step.
      requiresThread: action.targetMode !== "fixed",
      requiresConfirmation: true,
      enabled: availability.enabled,
      ...(availability.reason ? { reason: availability.reason } : {}),
    });
  }
  return controls;
}

async function savedActionAvailability({
  store,
  device,
  action,
  config,
  seen = new Set(),
  inheritedEnvironmentId = null,
  inheritedThreadId = null,
}) {
  if (seen.has(action.id)) return { enabled: false, reason: "This macro contains a reference cycle." };
  if (action.disabled) return { enabled: false, reason: disabledRecordMessage("action", action) };
  const hardware = hardwareSupportsAction(action, device.status);
  if (!hardware.supported) return { enabled: false, reason: hardware.reason };
  const environmentId = action.targetMode === "fixed"
    ? action.environmentId
    : inheritedEnvironmentId ?? device.config?.environmentId;
  if (!environmentId) return { enabled: false, reason: "No T3 environment is selected." };
  const environment = await store.getEnvironmentForUser(device.userId, environmentId);
  if (!environment) return { enabled: false, reason: "The selected T3 environment is unavailable." };
  const threadId = action.targetMode === "fixed"
    ? action.threadId
    : inheritedThreadId ?? device.config?.threadId;
  if (!threadId && action.type !== "macro") return { enabled: false, reason: "No T3 task is selected." };
  if (action.type === "macro") {
    const nextSeen = new Set(seen).add(action.id);
    for (const step of action.steps ?? []) {
      const nested = await store.getActionForUser(device.userId, step.actionId);
      if (!nested) return { enabled: false, reason: `Macro step ${step.actionId} is unavailable.` };
      if (nested.type === "media") {
        return { enabled: false, reason: "Media actions cannot be used as macro steps." };
      }
      if (nested.type === "macro") return { enabled: false, reason: "Nested macros are not supported." };
      const result = await savedActionAvailability({
        store,
        device,
        action: nested,
        config,
        seen: nextSeen,
        inheritedEnvironmentId: environmentId,
        inheritedThreadId: threadId,
      });
      if (!result.enabled) return result;
    }
    return { enabled: true, reason: null };
  }
  const representativeRuntime = action.type === "media" ? { mediaUploadId: "availability-check" } : {};
  const policy = evaluateIntentPolicy({
    device: { profile: await resolveActorProfile(store, device.userId, device.profile) },
    intent: actionIntent(action, representativeRuntime),
    environment,
    ...(config.policyAllowedHours ? { allowedHours: config.policyAllowedHours } : {}),
  });
  if (policy.allowed) return { enabled: true, reason: null };
  if (policy.requiresApproval) return { enabled: true, reason: "Execution requires owner approval." };
  return { enabled: false, reason: policy.reason };
}

async function systemControlAvailability({ store, device, kind, config }) {
  if (kind === "reset") return { enabled: true, reason: null };
  const environmentId = device.config?.environmentId;
  if (!environmentId) return { enabled: false, reason: "No T3 environment is selected." };
  const environment = await store.getEnvironmentForUser(device.userId, environmentId);
  if (!environment) return { enabled: false, reason: "The selected T3 environment is unavailable." };
  if (kind === "stop" && !device.config?.threadId) {
    return { enabled: false, reason: "No T3 task is selected." };
  }
  const intent = kind === "stop"
    ? { type: "session_control", action: "stop" }
    : { type: "status" };
  const policy = evaluateIntentPolicy({
    device: { profile: await resolveActorProfile(store, device.userId, device.profile) },
    intent,
    environment,
    ...(config.policyAllowedHours ? { allowedHours: config.policyAllowedHours } : {}),
  });
  return policy.allowed || policy.requiresApproval
    ? { enabled: true, reason: policy.requiresApproval ? "Execution requires owner approval." : null }
    : { enabled: false, reason: policy.reason };
}

async function executeSavedAction({
  store,
  action,
  runtime,
  actor,
  config,
  baseUrl,
  policyContext,
  stack = [],
}) {
  if (stack.includes(action.id)) throw new HttpError(409, "Macro actions cannot contain a reference cycle.");
  if (action.disabled) throw new HttpError(409, disabledRecordMessage("action", action));
  const environmentId = requireString(
    action.targetMode === "fixed" ? action.environmentId : runtime.environmentId,
    "environmentId",
  );
  const environment = await store.getEnvironmentForUser(actor.userId, environmentId);
  if (!environment) throw new HttpError(404, "Environment not found.");
  const threadId = optionalString(action.targetMode === "fixed" ? action.threadId : runtime.threadId);

  if (action.type === "macro") {
    const startStepIndex = Number.isInteger(runtime.__macroStartIndex) ? runtime.__macroStartIndex : 0;
    const executions = Array.isArray(runtime.__macroExecutions) ? structuredClone(runtime.__macroExecutions) : [];
    const stepActions = [];
    for (const step of action.steps ?? []) {
      stepActions.push(await store.getActionForUser(actor.userId, step.actionId));
    }
    const resumeSupported = stepActions.every((nested) => nested && nested.type !== "macro" && nested.type !== "media");
    let aggregateStatus = "completed";
    let nextStepIndex = null;
    let approvalCommandId = null;
    for (let index = startStepIndex; index < (action.steps ?? []).length; index += 1) {
      const step = action.steps[index];
      const nested = stepActions[index];
      if (!nested) throw new HttpError(409, `Macro step action is unavailable: ${step.actionId}.`);
      if (nested.type === "media") throw new HttpError(409, "Media actions cannot be used as macro steps.");
      if (nested.type === "macro") throw new HttpError(409, "Nested macros are not supported.");
      try {
        const output = await executeSavedAction({
          store,
          action: nested,
          runtime: { ...runtime, environmentId, threadId },
          actor,
          config,
          baseUrl,
          policyContext,
          stack: [...stack, action.id],
        });
        executions.push({ index, actionId: nested.id, ...output });
        const status = savedActionOutputStatus(output);
        if (["approval_required", "failed", "blocked"].includes(status)) {
          aggregateStatus = status;
          nextStepIndex = index + 1;
          approvalCommandId = status === "approval_required" ? output.command?.id ?? null : null;
          break;
        }
        if (status === "dispatched" && aggregateStatus === "completed") aggregateStatus = "dispatched";
      } catch (error) {
        if (step.continueOnFailure) {
          executions.push({ index, actionId: nested.id, error: errorMessage(error), continued: true });
          aggregateStatus = "failed";
          continue;
        }
        await store.recordActionRun?.({
          userId: actor.userId,
          actionId: action.id,
          actorType: actor.type,
          actorId: actor.id,
          status: failedActionStatus(error),
          intentType: "macro",
          commandIds: error?.details?.command?.id ? [error.details.command.id] : [],
        });
        throw error;
      }
    }
    const output = {
      macro: {
        actionId: action.id,
        status: aggregateStatus,
        executions,
        resumeSupported,
        ...(nextStepIndex !== null && nextStepIndex < action.steps.length
          ? {
              nextStepIndex,
              remainingActionIds: action.steps.slice(nextStepIndex).map((step) => step.actionId),
            }
          : {}),
      },
    };
    if (aggregateStatus === "approval_required" && approvalCommandId && resumeSupported) {
      const run = runtime.__macroRunId
        ? await store.updateMacroRun({
            userId: actor.userId,
            runId: runtime.__macroRunId,
            approvalCommandId,
            nextStepIndex,
            executions,
            status: "waiting_approval",
            result: output,
          })
        : await store.createMacroRun({
            userId: actor.userId,
            actionId: action.id,
            approvalCommandId,
            nextStepIndex,
            runtime: cleanMacroRuntime(runtime, environmentId, threadId),
            actor,
            policyContext: {
              ...policyContext,
              __policyAllowedHours: config.policyAllowedHours ?? null,
            },
            baseUrl,
            executions,
          });
      output.macro.runId = run?.id ?? null;
    } else if (runtime.__macroRunId) {
      await store.updateMacroRun({
        userId: actor.userId,
        runId: runtime.__macroRunId,
        status: aggregateStatus,
        executions,
        result: output,
      });
      output.macro.runId = runtime.__macroRunId;
    }
    await store.recordActionRun?.({
      userId: actor.userId,
      actionId: action.id,
      actorType: actor.type,
      actorId: actor.id,
      status: aggregateStatus,
      intentType: "macro",
      commandIds: actionRunCommandIds(output),
    });
    return output;
  }

  const intent = action.type === "system_status"
    ? { type: "status" }
    : action.type === "system_stop"
      ? { type: "session_control", action: "stop" }
      : actionIntent(action, runtime);
  let output;
  try {
    output = await submitIntent({
      store,
      environment,
      body: {
        environmentId,
        threadId,
        intent,
        mediaUploadId: runtime.mediaUploadId,
        followUpInstruction: runtime.__followUpInstruction,
      },
      actor,
      config,
      baseUrl,
      policyContext,
    });
  } catch (error) {
    await store.recordActionRun?.({
      userId: actor.userId,
      actionId: action.id,
      actorType: actor.type,
      actorId: actor.id,
      status: failedActionStatus(error),
      intentType: intent.type,
      commandIds: error?.details?.command?.id ? [error.details.command.id] : [],
    });
    throw error;
  }
  await store.recordActionRun?.({
    userId: actor.userId,
    actionId: action.id,
    actorType: actor.type,
    actorId: actor.id,
    status: output.command?.status ?? "completed",
    intentType: intent.type,
    commandIds: actionRunCommandIds(output),
  });
  return output;
}

function systemDeviceAction(actionId) {
  if (actionId === SYSTEM_CONTROL_IDS.status) {
    return { id: actionId, type: "system_status", targetMode: "device-current" };
  }
  if (actionId === SYSTEM_CONTROL_IDS.stop) {
    return { id: actionId, type: "system_stop", targetMode: "device-current" };
  }
  return null;
}

function actionRunStatus(output) {
  const commands = output?.macro?.executions?.flatMap((entry) => entry.command ? [entry.command] : []) ?? [];
  const command = output?.command ?? commands.at(-1);
  return (output?.macro?.status ?? command?.status) === "dispatched" ? 202 : 200;
}

function actionResponseAfter(output) {
  const commands = output?.macro?.executions?.flatMap((entry) => entry.command ? [entry.command] : []) ?? [];
  const command = output?.command ?? commands.at(-1);
  return optionalString(command?.createdAt) ?? optionalString(command?.updatedAt) ?? null;
}

function savedActionOutputStatus(output) {
  return output?.macro?.status ?? output?.command?.status ?? "completed";
}

function failedActionStatus(error) {
  return error?.details?.command?.status ?? (error?.status === 403 ? "blocked" : "failed");
}

function cleanMacroRuntime(runtime, environmentId, threadId) {
  const { __macroStartIndex, __macroExecutions, __macroRunId, __followUpInstruction, ...publicRuntime } = runtime;
  return { ...publicRuntime, environmentId, threadId };
}

function actionRunCommandIds(output) {
  const ids = [];
  if (output?.command?.id) ids.push(output.command.id);
  for (const execution of output?.macro?.executions ?? []) {
    if (execution.command?.id) ids.push(execution.command.id);
    for (const id of actionRunCommandIds(execution)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function validateFirmwarePolicyInput(body) {
  if (Object.hasOwn(body, "channel") && !["stable", "beta"].includes(body.channel)) {
    throw new HttpError(400, "channel must be stable or beta.");
  }
  if (Object.hasOwn(body, "updateMode") && !["manual", "notify", "automatic"].includes(body.updateMode)) {
    throw new HttpError(400, "updateMode must be manual, notify, or automatic.");
  }
  if (Object.hasOwn(body, "desiredVersion") && body.desiredVersion !== null) {
    requireString(body.desiredVersion, "desiredVersion");
  }
}

async function compatibleFirmwareReleases(store, device, policy, config) {
  const hardwareModel = optionalString(device.status?.hardwareModel) ?? config.defaultHardwareModel;
  return await store.listFirmwareReleases({ hardwareModel, channel: policy?.channel ?? "stable" });
}

async function firmwarePolicyResponse({ store, device, policy, config }) {
  const availableReleases = await compatibleFirmwareReleases(store, device, policy, config);
  const latestRelease = availableReleases.at(-1) ?? null;
  return {
    deviceId: device.id,
    policy,
    currentVersion: device.status?.firmwareVersion ?? null,
    latestVersion: latestRelease?.version ?? null,
    latestRelease,
    availableVersions: availableReleases.map((release) => release.version),
    availableReleases,
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
  const followUpInstruction = actor.type === "device" ? optionalString(body.followUpInstruction) : null;
  if (followUpInstruction) intent.deviceFollowUpInstruction = followUpInstruction.slice(0, 4096);
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
      snapshot = await readT3Snapshot(environment);
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
      result: compressSnapshot(snapshot, threadIdOrNull),
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
    if (intent.type === "session_control" && intent.action === "stop" && isAlreadyStoppedT3Error(error)) {
      const command = await store.createCommand({
        userId: actor.userId,
        deviceId: actor.type === "device" ? actor.id : null,
        environmentId: environment.id,
        threadId,
        intent,
        normalized: storableT3Command(t3Command),
        status: "completed",
        risk: policy.risk,
        result: { alreadyStopped: true },
        metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
      });
      return { command, alreadyStopped: true };
    }
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

async function t3ReleaseStatus() {
  try {
    const latest = await fetchLatestT3Release();
    return { ...buildT3ReleaseStatus(latest.version), checkedAt: latest.checkedAt };
  } catch (error) {
    return {
      ...buildT3ReleaseStatus(null, errorMessage(error)),
      checkedAt: new Date().toISOString(),
    };
  }
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
  // The normalized intent carries the ordered list; the scalars stay readable for stored intents
  // written before attachments became a list.
  const candidates = [
    ...(Array.isArray(intent?.mediaUploadIds) ? intent.mediaUploadIds : []),
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
  // A project launch persists two nested commands; the first turn is the one that carries media.
  if (command?.createThread || command?.startTurn) {
    return {
      ...command,
      ...(command.createThread ? { createThread: storableT3Command(command.createThread) } : {}),
      ...(command.startTurn ? { startTurn: storableT3Command(command.startTurn) } : {}),
    };
  }
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

async function registerRedeemedCatalogue({ store, session, environment, body }) {
  const entries = Array.isArray(body.instances)
    ? body.instances
    : (Array.isArray(body.catalogue?.instances) ? body.catalogue.instances : null);
  if (!entries || entries.length === 0) return null;
  const catalogue = buildProviderCatalogue(entries, {
    source: optionalString(body.catalogueSource) ?? "setup-script",
  });
  // An unusable catalogue is not worth failing a pairing over; the gateway simply falls back to
  // snapshot-derived harnesses, exactly as it does for a host that never registered one.
  if (catalogue.instances.length === 0) return null;
  await store.updateEnvironmentCatalogue({
    userId: session.userId,
    environmentId: environment.id,
    catalogue,
  });
  return catalogue;
}

async function checkEnvironmentHealth({ store, userId, environment }) {
  const checkedAt = new Date().toISOString();
  if (isEnvironmentTokenExpired(environment)) {
    return recordEnvironmentFailure({
      store,
      userId,
      environment,
      checkedAt,
      reason: "token_expired",
      message: describeEnvironmentFailure("token_expired"),
    });
  }
  let snapshot;
  try {
    snapshot = await readT3Snapshot({ ...environment, timeoutMs: 5000 });
  } catch (error) {
    const reason = classifyEnvironmentFailure(error);
    return recordEnvironmentFailure({
      store,
      userId,
      environment,
      checkedAt,
      reason,
      message: error?.message || describeEnvironmentFailure(reason),
    });
  }
  // A 200 that carries neither projects nor threads is a host speaking a contract this gateway
  // cannot drive, which is a different failure from an unreachable one.
  if (!Array.isArray(snapshot?.projects) || !Array.isArray(snapshot?.threads)) {
    return recordEnvironmentFailure({
      store,
      userId,
      environment,
      checkedAt,
      reason: "contract_incompatible",
      message: "The T3 snapshot did not expose the projects and threads arrays this gateway requires.",
    });
  }
  const screen = compressSnapshot(snapshot);
  const updated = await store.updateEnvironmentHealth({
    userId,
    environmentId: environment.id,
    status: "reachable",
    health: {
      lastCheckedAt: checkedAt,
      lastReachableAt: checkedAt,
      lastError: null,
      failureReason: null,
      snapshot: screen,
    },
  });
  return { environment: updated, screen, reason: null, failure: null };
}

async function recordEnvironmentFailure({ store, userId, environment, checkedAt, reason, message }) {
  const updated = await store.updateEnvironmentHealth({
    userId,
    environmentId: environment.id,
    status: reason === "token_expired" ? "token_expired" : "unreachable",
    health: { lastCheckedAt: checkedAt, lastError: message, failureReason: reason },
  });
  const error = updated?.health?.lastError ?? message;
  return {
    environment: updated,
    error,
    reason,
    failure: buildEnvironmentFailure({ environment: updated ?? environment, reason, message: error }),
  };
}

// The recovery dialog renders from this; it must never carry a credential.
function buildEnvironmentFailure({ environment, reason, message }) {
  return {
    reason,
    message,
    retryable: isRetryableEnvironmentFailure(reason),
    baseUrl: environment?.baseUrl ?? null,
    ...(reason === "contract_incompatible"
      ? {
        installedVersion: environment?.health?.compatibility?.installedVersion ?? null,
        minimumVersion: T3_COMPATIBILITY_POLICY.minimumVersion,
        maximumTestedVersion: T3_COMPATIBILITY_POLICY.maximumTestedVersion,
      }
      : {}),
  };
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

/**
 * Enqueues transcription instead of running it.
 *
 * The 202 is the contract change: the caller gets a job id and polls (or listens on SSE for
 * `media.job`) rather than holding a socket open for the length of an ASR call. An unconfigured
 * provider is still refused synchronously with 409 — queueing work that is guaranteed to fail
 * identically on every attempt would replace a clear error with a silent one.
 */
async function enqueueTranscription({ store, config, userId, mediaId, res }) {
  const media = await store.getMediaForUser(userId, mediaId);
  if (!media) throw new HttpError(404, "Media upload not found.");
  if (media.kind !== "audio") throw new HttpError(400, "Only audio media can be transcribed.");

  if (!isTranscriptionProviderEnabled(config.transcriptionProvider)) {
    const message = "No transcription provider is configured.";
    const updated = await store.updateMediaProcessing?.({
      userId,
      mediaId,
      processing: { transcriptionStatus: "unavailable", transcriptSource: null, lastError: message },
    });
    throw new HttpError(409, message, { media: updated ?? publicMediaRecord(media) });
  }

  const job = await store.createMediaJob({
    userId,
    mediaId,
    kind: "transcription",
    provider: config.transcriptionProvider,
    model: config.transcriptionModel ?? null,
    language: config.transcriptionLanguage ?? null,
    maxAttempts: config.transcriptionMaxAttempts ?? 3,
    reviewRequired: config.transcriptionReviewRequired === true,
  });
  if (!job) throw new HttpError(404, "Media upload not found.");

  const withProcessing = await store.updateMediaProcessing?.({
    userId,
    mediaId,
    processing: {
      transcriptionStatus: "processing",
      transcriptSource: config.transcriptionProvider,
      lastError: null,
    },
  });

  return sendJson(res, 202, {
    job,
    media: await nameMediaRecord(store, userId, withProcessing ?? publicMediaRecord(media), config),
  });
}

/**
 * Enqueues transcription for audio a controller just uploaded.
 *
 * The device does not ask for this. A controller with a microphone records, uploads, and is done;
 * if the gateway did not queue the work here the audio would sit in storage forever, which is
 * exactly what it did before. Unlike the owner-facing endpoint an unconfigured provider is not an
 * error: the upload itself succeeded, so the media is marked `unavailable` and the device is told
 * there is no job to poll rather than having its upload rejected after the bytes are already
 * stored.
 */
async function enqueueDeviceTranscription({ store, config, events, device, media, body = {} }) {
  if (media.kind !== "audio") return { job: null, media };
  if (!isTranscriptionProviderEnabled(config.transcriptionProvider)) {
    const unavailable = await store.updateMediaProcessing?.({
      userId: device.userId,
      mediaId: media.id,
      processing: {
        transcriptionStatus: "unavailable",
        transcriptSource: null,
        lastError: "No transcription provider is configured.",
      },
    });
    return { job: null, media: unavailable ?? media };
  }

  const job = await store.createMediaJob({
    userId: device.userId,
    mediaId: media.id,
    kind: "transcription",
    deviceId: device.id,
    // Pinned to the target the controller was pointed at when it recorded. Reading the device's
    // config at dispatch instead would send a delayed capture to whatever thread happens to be
    // selected by then, which is not the thread the owner was talking to.
    environmentId: optionalString(body.environmentId) ?? optionalString(device.config?.environmentId) ?? null,
    threadId: optionalString(body.threadId) ?? optionalString(device.config?.threadId) ?? null,
    provider: config.transcriptionProvider,
    model: config.transcriptionModel ?? null,
    language: config.transcriptionLanguage ?? null,
    maxAttempts: config.transcriptionMaxAttempts ?? 3,
    reviewRequired: config.transcriptionReviewRequired === true,
  });
  if (!job) return { job: null, media };

  const queued = await store.updateMediaProcessing?.({
    userId: device.userId,
    mediaId: media.id,
    processing: {
      transcriptionStatus: "processing",
      transcriptSource: config.transcriptionProvider,
      lastError: null,
    },
  });
  // The console should see the capture appear the moment it lands, not on the worker's next tick.
  events?.broadcastToUser?.(device.userId, "media.job", {
    ...mediaJobEvent(job, new Date().toISOString()),
    terminal: false,
  });
  return { job, media: queued ?? media };
}

/**
 * Requeues the jobs that failed because of how the gateway was configured, and only those.
 *
 * The incident this exists for: two clips failed permanently because TRANSCRIPTION_PROVIDER was
 * unset. Nothing about those recordings was wrong, but `failed` is terminal and never re-claimed,
 * so fixing the deployment did not bring them back — and there was no way to tell them apart from a
 * clip the model genuinely cannot transcribe.
 *
 * Two refusals, both deliberately louder than a silent no-op:
 *
 * - No provider configured now, or one configured without the credential it needs. Requeueing into
 *   the identical failure would spend the jobs' fresh attempt budget to reproduce the same error
 *   and leave the owner believing the retry was tried and lost.
 * - Anything whose recorded cause is not `configuration` is reported as skipped, with the cause, so
 *   "I retried and nothing happened" is answerable from the response.
 *
 * And the safety rule, which lives in the store because it must not be a caller's choice: every
 * requeued job comes back with `reviewRequired`, so its transcript waits for a person. Auto-send
 * now defaults on for a microphone device, and a bulk retry without this would let a batch of
 * captures from hours or days ago dispatch themselves into a coding agent as instructions the owner
 * has long stopped expecting. The grant means "send what I say as I say it" — it was never consent
 * for what was said last Tuesday.
 */
async function retryConfigurationFailures({ store, config, res, userId, jobIds = null }) {
  const provider = createTranscriptionProvider(config);
  if (!isTranscriptionProviderEnabled(config.transcriptionProvider) || provider.available !== true) {
    throw new HttpError(
      409,
      isTranscriptionProviderEnabled(config.transcriptionProvider)
        ? `TRANSCRIPTION_PROVIDER=${config.transcriptionProvider} is selected but not usable yet`
          + " (its credential is missing), so these jobs would fail again for the same reason."
        : "No transcription provider is configured, so these jobs would fail again for the same"
          + " reason. Set TRANSCRIPTION_PROVIDER first, then retry.",
    );
  }

  // Named ids are read individually so an ineligible one can be reported as itself. Without a list
  // the candidates are every failed job on the account — a job that is still running is not a
  // candidate for anything, and sweeping those in would be the automatic behaviour this path is
  // deliberately not.
  let candidates;
  if (jobIds) {
    const ids = [...new Set(jobIds.map((value) => String(value)))];
    const found = await Promise.all(ids.map((id) => store.getMediaJobForUser(userId, id)));
    const unknown = ids.filter((_, index) => !found[index]);
    if (unknown.length > 0) throw new HttpError(404, `Media job not found: ${unknown.join(", ")}.`);
    candidates = found;
  } else {
    candidates = await store.listMediaJobs({ userId, stage: "failed" });
  }

  const requeued = [];
  const skipped = [];
  const skip = (job) => skipped.push({
    jobId: job.id,
    mediaId: job.mediaId,
    stage: job.stage,
    failureCause: job.failureCause ?? null,
  });

  for (const job of candidates) {
    if (job.stage !== "failed" || job.failureCause !== "configuration") {
      skip(job);
      continue;
    }
    const updated = await store.requeueMediaJob({ userId, jobId: job.id, actorId: userId });
    if (!updated) {
      // The store refuses on the same rules; a disagreement here means the row moved underneath us.
      skip(job);
      continue;
    }
    // The media record still says `failed` from the run that did not work; the owner is looking at
    // that line, not at the job row.
    await store.updateMediaProcessing?.({
      userId,
      mediaId: updated.mediaId,
      processing: {
        transcriptionStatus: "processing",
        transcriptSource: config.transcriptionProvider,
        lastError: null,
      },
    });
    requeued.push({
      jobId: updated.id,
      mediaId: updated.mediaId,
      attempts: updated.attempts,
      requeueCount: updated.requeueCount,
      previousError: job.lastError ?? null,
    });
  }

  return sendJson(res, 200, {
    provider: config.transcriptionProvider,
    // Stated in the response because it is a promise about what happens next, not an internal
    // detail: nothing requeued here can auto-send, however the device's grant is set.
    holdForReview: true,
    requeued,
    skipped,
    counts: { requeued: requeued.length, skipped: skipped.length },
  });
}

/**
 * Decides whether a finished voice transcript is sent on, and sends it.
 *
 * Called by the job worker at the moment of dispatch, never at enqueue. That ordering is the point:
 * a capture can sit in the queue through a retry budget while the owner tightens a profile, revokes
 * the device, or turns auto-send back off, and a request recorded under the old rules must not
 * carry the old answer past the new ones. Everything below — the grant, the device, the policy
 * evaluation inside submitIntent() — is read fresh here.
 *
 * Refusals are returned, not thrown. The transcript is already on the media record by this point,
 * so a blocked send leaves the owner a transcript to look at and a reason it did not go.
 */
async function dispatchVoiceTranscript({ store, config, job, transcript }) {
  // Console uploads have no device and never auto-send; the owner is already looking at the screen.
  if (!job?.deviceId) return null;

  const device = await store.getDeviceForUser(job.userId, job.deviceId);
  // Revoked or deleted between record and dispatch. The grant died with the pairing.
  if (!device || device.revokedAt) return null;
  // Read here, never at enqueue, and now three-valued: an owner's explicit choice either way, or
  // the hardware's default — on for a device that has reported a microphone. A device that stopped
  // reporting one, or an owner who turned it off while this capture sat in the queue, both land
  // here as `false` and the capture waits.
  if (!voiceAutoSendEnabled(device)) return null;

  const environmentId = job.environmentId ?? device.config?.environmentId ?? null;
  const threadId = job.threadId ?? device.config?.threadId ?? null;
  if (!environmentId || !threadId) {
    return {
      autoSend: true,
      dispatchStatus: "failed",
      dispatchError: "This device has no environment and thread configured to send to.",
    };
  }
  const environment = await store.getEnvironmentForUser(job.userId, environmentId);
  if (!environment) {
    return { autoSend: true, dispatchStatus: "failed", dispatchError: "Environment not found." };
  }

  try {
    // The ordinary device intent path, not a shortcut around it: normalizeIntent turns the audio
    // intent into a prompt with the recording attached, and evaluateIntentPolicy runs against this
    // device's profile before anything is dispatched.
    const output = await submitIntent({
      store,
      environment,
      body: {
        threadId,
        environmentId,
        intent: { type: "audio_prompt", transcript, mediaUploadIds: [job.mediaId] },
      },
      actor: { type: "device", id: device.id, userId: job.userId, profile: device.profile },
      config,
      baseUrl: config.publicBaseUrl ?? null,
    });
    const status = output?.command?.status ?? null;
    if (status === "approval_required") {
      return {
        autoSend: true,
        dispatchStatus: "approval_required",
        commandId: output.command.id,
        dispatchError: null,
      };
    }
    if (status === "dispatched" || status === "completed") {
      return { autoSend: true, dispatchStatus: "sent", commandId: output.command.id, dispatchError: null };
    }
    return {
      autoSend: true,
      dispatchStatus: "failed",
      commandId: output?.command?.id ?? null,
      dispatchError: `T3 dispatch ended at status ${status ?? "unknown"}.`,
    };
  } catch (error) {
    const blocked = error instanceof HttpError && error.status === 403;
    return {
      autoSend: true,
      dispatchStatus: blocked ? "blocked" : "failed",
      commandId: error?.details?.command?.id ?? null,
      dispatchError: errorMessage(error),
    };
  }
}

/**
 * The diff between what the provider heard and what cleanup produced, attached on read.
 *
 * Derived rather than stored: both versions are already on the job, so a computed answer cannot go
 * stale against them. `contentPreserved: false` is the reason a job can park at `review_required`
 * even where review was never configured — normalisation moved the user's words, so a person
 * decides rather than the worker.
 */
function withTranscriptChange(job) {
  if (!job) return job;
  return {
    ...job,
    transcriptChange: describeTranscriptChange(job.rawTranscript, job.normalizedTranscript),
  };
}

/**
 * Attaches the derived `displayName` and `origin` to media records on their way out.
 *
 * Derived here rather than stored (see src/mediaNaming.mjs): the device label and the thread title
 * a name is built from both live somewhere else and both change, so a persisted name would be a
 * copy that quietly stops being true — and clips already in a user's library would need a migration
 * to get one at all.
 *
 * Batched, because a listing is the hot caller: one device read and one job read for the whole
 * page, never one per row.
 */
async function nameMediaRecords(store, userId, records, config = null) {
  const list = (records ?? []).filter(Boolean);
  if (list.length === 0) return [];

  // A console-only library touches neither table: there is no device to label and no pinned thread.
  const fromDevice = list.some((media) => media.deviceId);
  const [devices, jobs] = fromDevice
    ? await Promise.all([store.listDevices(userId), store.listMediaJobs({ userId })])
    : [[], []];
  const deviceById = new Map((devices ?? []).map((device) => [device.id, device]));

  // The job holds the target the controller was pointed at when it recorded, which is the thread
  // the owner was talking to; the device's own config is only where it happens to point *now*, so
  // it is the fallback for a capture that never produced a job (an image, or audio with no
  // transcription provider configured).
  const jobByMedia = new Map();
  for (const job of jobs ?? []) {
    if (!job?.mediaId) continue;
    const previous = jobByMedia.get(job.mediaId);
    if (previous && String(previous.createdAt ?? "") > String(job.createdAt ?? "")) continue;
    jobByMedia.set(job.mediaId, job);
  }

  const targets = list.map((media) => {
    const device = media.deviceId ? deviceById.get(media.deviceId) ?? null : null;
    const job = jobByMedia.get(media.id) ?? null;
    return {
      media,
      device,
      environmentId: optionalString(job?.environmentId) ?? optionalString(device?.config?.environmentId),
      threadId: optionalString(job?.threadId) ?? optionalString(device?.config?.threadId),
    };
  });

  await warmThreadTitles(store, userId, targets, config);

  const now = new Date();
  return targets.map(({ media, device, environmentId, threadId }) => ({
    ...media,
    ...buildMediaName({
      media,
      device,
      environmentId,
      threadId,
      threadTitle: lookupThreadTitle(environmentId, threadId),
      now,
    }),
  }));
}

/** The single-record form, for the routes that answer with one upload. */
async function nameMediaRecord(store, userId, media, config = null) {
  if (!media) return media;
  const [named] = await nameMediaRecords(store, userId, [media], config);
  return named ?? media;
}

/**
 * Fills the thread-title cache for the environments this page actually needs.
 *
 * Titles normally arrive for free from the snapshots the gateway already fetches, but the first
 * listing after a restart would otherwise show `Thread 4f2a1c` where a real title exists. So a
 * stale environment gets one short-timeout read — and a failure is remembered exactly like a
 * success, so an unreachable T3 costs one attempt per window rather than one per page load.
 * Nothing here can fail the listing: a name is decoration.
 */
async function warmThreadTitles(store, userId, targets, config) {
  const environmentIds = [...new Set(targets
    .filter((target) => target.threadId && target.environmentId)
    .map((target) => target.environmentId))]
    .filter((environmentId) => threadTitlesAreStale(environmentId));

  for (const environmentId of environmentIds) {
    try {
      const environment = await store.getEnvironmentForUser(userId, environmentId);
      if (!environment || isEnvironmentTokenExpired(environment)) {
        markThreadTitlesUnavailable(environmentId);
        continue;
      }
      await readT3Snapshot({
        ...environment,
        timeoutMs: config?.mediaNameSnapshotTimeoutMs ?? 1500,
      });
    } catch {
      markThreadTitlesUnavailable(environmentId);
    }
  }
}

/** getMediaForUser hands back the raw record; storagePath must never leave the gateway. */
function publicMediaRecord(media) {
  const { storagePath, ...rest } = media;
  return rest;
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
  const disabled = body.disabled === true;
  return {
    label: requireString(body.label, "label"),
    environmentId: optionalString(body.environmentId),
    threadId: optionalString(body.threadId),
    intent,
    disabled,
    disabledReason: disabled ? optionalString(body.disabledReason) ?? null : null,
  };
}

async function buildSupportDiagnosticsBundle({ store, user }) {
  const [
    devices,
    environments,
    media,
    mediaJobs,
    macros,
    commands,
    audit,
    display,
    observability,
  ] = await Promise.all([
    store.listDevices(user.id),
    store.listEnvironments(user.id),
    store.listMediaUploads(user.id),
    // "Why is my transcription stuck?" is answerable from the job's stage, attempts and lastError
    // and from nothing else, so the bundle carries them.
    store.listMediaJobs?.({ userId: user.id }) ?? [],
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
      transcripts: "redacted with length and sha256",
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
      mediaJobs: mediaJobs.length,
      macros: macros.length,
      commands: commands.length,
      audit: audit.length,
    },
    display,
    observability,
    devices,
    environments,
    media: media.map(redactMediaForSupport),
    mediaJobs: mediaJobs.map(redactMediaJobForSupport),
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

// Every transcript version is user content. The stage machine around them is not, and is the
// whole reason a job is worth including.
function redactMediaJobForSupport(job) {
  return {
    ...job,
    rawTranscript: redactOptionalText(job.rawTranscript),
    normalizedTranscript: redactOptionalText(job.normalizedTranscript),
    userEditedTranscript: redactOptionalText(job.userEditedTranscript),
  };
}

function redactOptionalText(value) {
  return typeof value === "string" && value.length > 0 ? redactText(value) : value ?? null;
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
    // `title` is here because a thread_create intent may carry one the firmware supplied, which is
    // the owner's words exactly as much as a prompt is.
    if (["text", "command", "transcript", "description", "prompt", "title"].includes(key) && typeof value === "string") {
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
  // A thread title is user content on a `thread.create`, and on the nested one a project launch
  // stores. Handled here rather than in redactSupportValue() so the generic walker keeps leaving
  // titles alone everywhere else it is used.
  for (const nested of [output, output?.createThread]) {
    if (typeof nested?.title === "string") nested.title = redactText(nested.title);
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

async function approveCommand({ store, userId, commandId, config }) {
  const startedAt = Date.now();
  const command = await store.getCommandForUser(userId, commandId);
  if (!command) throw new HttpError(404, "Command not found.");
  if (command.status !== "approval_required") {
    if (command.status === "dispatched") {
      const macroResume = await resumeMacroRunAfterApproval({ store, userId, commandId, config });
      if (macroResume) return { command, macroResume };
    }
    throw new HttpError(409, "Command is not waiting for approval.", {
      command,
      status: command.status,
    });
  }
  const approvalClaim = await store.claimCommandApproval?.({ userId, commandId });
  if (!approvalClaim) {
    throw new HttpError(409, "Command approval is already being processed.", { commandId });
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
      const updated = await store.updateCommand({
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
      return { command: updated, macroResume: await resumeMacroRunAfterApproval({ store, userId, commandId, config }) };
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
  return { command: updated, macroResume: await resumeMacroRunAfterApproval({ store, userId, commandId, config }) };
}

async function resumeMacroRunAfterApproval({ store, userId, commandId, config }) {
  const pending = await store.getMacroRunForApproval?.({ userId, commandId });
  if (!pending) return null;
  if (["completed", "dispatched", "failed", "blocked"].includes(pending.status)) {
    return { resumed: false, run: pending, result: pending.result ?? null };
  }
  const claimed = await store.claimMacroRunForResume?.({ userId, runId: pending.id });
  if (!claimed) return { resumed: false, run: pending, reason: "already_resuming" };
  const action = await store.getActionForUser(userId, claimed.actionId);
  if (!action) {
    const run = await store.updateMacroRun({
      userId,
      runId: claimed.id,
      status: "failed",
      result: { error: "Macro action no longer exists." },
    });
    return { resumed: false, run, reason: "action_missing" };
  }
  try {
    const output = await executeSavedAction({
      store,
      action,
      runtime: {
        ...claimed.runtime,
        __macroStartIndex: claimed.nextStepIndex,
        __macroExecutions: claimed.executions,
        __macroRunId: claimed.id,
      },
      actor: claimed.actor,
      config: {
        ...config,
        ...(Object.hasOwn(claimed.policyContext ?? {}, "__policyAllowedHours")
          ? { policyAllowedHours: claimed.policyContext.__policyAllowedHours }
          : {}),
      },
      baseUrl: claimed.baseUrl,
      policyContext: claimed.policyContext,
    });
    return { resumed: true, runId: claimed.id, ...output };
  } catch (error) {
    const run = await store.updateMacroRun({
      userId,
      runId: claimed.id,
      status: failedActionStatus(error),
      result: { error: errorMessage(error) },
    });
    return { resumed: true, run, error: errorMessage(error) };
  }
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

function isAlreadyStoppedT3Error(error) {
  if (![404, 409].includes(error?.status)) return false;
  return /already[ _-]?stopped|no active|not running|inactive session/iu.test(String(error?.responseBody ?? ""));
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

function sanitizeFirmwareRelease(release) {
  if (!release) return null;
  const { artifactKey, artifactProvider, ...output } = release;
  return output;
}

function requireOtaSigningKey(config) {
  if (config.otaSigningKey) return config.otaSigningKey;
  if (config.demoMode) return "dev-insecure-ota-signing-key";
  throw new HttpError(503, "OTA_SIGNING_KEY is required for firmware manifests.");
}

function firmwareDownloadSigningKey(config) {
  return config.firmwareDownloadSigningKey ?? requireOtaSigningKey(config);
}

function requestBaseUrl(req) {
  const proto = optionalString(req.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

async function deviceGatewayResponse(store, device, suppliedSelection = null) {
  const profiles = (await store.listGatewayProfiles(device.userId)).map(publicGatewayProfile);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const selection = suppliedSelection ?? await store.getDeviceGatewaySelection({
    userId: device.userId,
    deviceId: device.id,
  });
  return {
    deviceId: device.id,
    revision: selection?.revision ?? 0,
    state: selection?.state ?? "stable",
    profiles,
    activeProfileId: selection?.activeProfileId ?? null,
    pendingProfileId: selection?.pendingProfileId ?? null,
    activeProfile: byId.get(selection?.activeProfileId) ?? null,
    pendingProfile: byId.get(selection?.pendingProfileId) ?? null,
    previousProfile: byId.get(selection?.previousProfileId) ?? null,
    lastError: selection?.lastError ?? null,
    requestedAt: selection?.requestedAt ?? null,
    appliedAt: selection?.appliedAt ?? null,
  };
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

// The redeem route has no authenticated actor to key on — the code itself is the credential — so
// the limit is per client address, like the factory realm.
async function enforceConnectRedeem(req, res, rateLimiter, config) {
  await enforceRateLimit(req, res, rateLimiter, config, {
    scope: "t3:connect-redeem",
    actorId: clientKey(req),
    limit: config.rateLimits?.connectRedeem,
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
    // `reason` is the discriminator the console branches on; the message stays human copy.
    throw new HttpError(409, "T3 access token has expired. Re-pair this environment.", {
      environmentId: environment.id,
      accessTokenExpiresAt: environment.accessTokenExpiresAt,
      reason: "token_expired",
      failure: buildEnvironmentFailure({
        environment,
        reason: "token_expired",
        message: describeEnvironmentFailure("token_expired"),
      }),
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

// Compact thread list for a 122x250 panel. `selected` lets the firmware render the
// current row without duplicating selection logic, while the top-level threadId is
// retained for older clients. `status` follows the same precedence as the selected
// thread display: active work wins over a stale stopped session.
//
// `status` is the field the orb reads, and the selected row's `running` is refined
// afterwards into an agent verb by refineSelectedThreadVerb() when — and only when — T3's
// work log proves one. The words produced here are unchanged.
//
// `projectId` narrows the list to one folder. Null — the default, and what firmware
// that predates project selection sends — keeps the whole bound environment visible,
// so adding project selection cannot shrink an existing controller's thread list.
function deviceSelectableThreads(snapshot, selectedThreadId = null, projectId = null) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const scope = optionalString(projectId);
  return threads
    // A thread with no project cannot be proven to live in the selected folder, so a
    // bound project excludes it rather than guessing.
    .filter((thread) => !scope || optionalString(thread?.projectId) === scope)
    .map((thread) => ({
      id: optionalString(thread?.id) ?? null,
      title: optionalString(thread?.title) ?? optionalString(thread?.name) ?? "Untitled thread",
      status: deviceThreadStatus(thread),
      selected: optionalString(thread?.id) === optionalString(selectedThreadId),
    }))
    .filter((thread) => thread.id !== null);
}

// Refines the selected thread's `running` into what the agent is actually doing.
//
// Only the selected thread, and only while it is running. The orb reads exactly one row —
// the selected one (presentationForState() in the Hosyond ui.cpp) — so hydrating the rest
// would buy a screen nothing and cost one HTTP round trip per thread per poll. `turnLimit: 1`
// bounds the response to the live turn.
//
// Best-effort by construction. A T3 that predates GET /api/orchestration/threads/:threadId,
// a slow host, or a thread that settled between the two reads all leave the row at plain
// `running`, which is exactly what this route answered before. The thread list must not fail
// because a decoration could not be computed.
async function refineSelectedThreadVerb(environment, threads) {
  const selected = threads.find((thread) => thread.selected && thread.status === "running");
  if (!selected) return threads;
  let detail = null;
  try {
    detail = await fetchT3ThreadDetail(environment, selected.id, { turnLimit: 1 });
  } catch {
    return threads;
  }
  const refined = refineThreadStatus(selected.status, detail);
  if (refined === selected.status) return threads;
  selected.status = refined;
  return threads;
}

// The owner's environments, as much of one as a bezel can render. Deliberately not
// publicEnvironment(): baseUrl, scopes, health timestamps and pairing state are console
// material, and the token-bearing fields must never reach the hardware realm at all.
// `tokenExpired` is carried because selecting such an environment is a dead end the
// device should be able to show *before* the owner walks to it.
function deviceSelectableEnvironments(environments, selectedEnvironmentId = null) {
  return (Array.isArray(environments) ? environments : [])
    .map((environment) => ({
      id: optionalString(environment?.id) ?? null,
      label: optionalString(environment?.label) ?? "Untitled environment",
      status: optionalString(environment?.status) ?? "unknown",
      tokenExpired: isEnvironmentTokenExpired(environment),
      selected: optionalString(environment?.id) === optionalString(selectedEnvironmentId),
    }))
    .filter((environment) => environment.id !== null);
}

// Projects ("folders") in the bound environment, straight from the T3 snapshot — the
// orchestration API publishes them alongside threads, so this costs no extra call.
// `threadCount` is what makes the list usable at five keys: it says which folder has
// anything in it before the owner pages into an empty one.
function deviceSelectableProjects(snapshot, selectedProjectId = null) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  return projects
    .map((project) => {
      const id = optionalString(project?.id) ?? null;
      return {
        id,
        title: optionalString(project?.title) ?? optionalString(project?.name) ?? "Untitled project",
        threadCount: id === null
          ? 0
          : threads.filter((thread) => optionalString(thread?.projectId) === id).length,
        selected: id !== null && id === optionalString(selectedProjectId),
      };
    })
    .filter((project) => project.id !== null);
}

// The T3 project a thread belongs to, or null when the snapshot does not say.
function snapshotThreadProjectId(snapshot, threadId) {
  const wanted = optionalString(threadId);
  if (!wanted) return null;
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const thread = threads.find((candidate) => optionalString(candidate?.id) === wanted);
  return thread ? optionalString(thread?.projectId) : null;
}

/**
 * `fetchT3Snapshot`, plus the thread titles it happened to carry.
 *
 * Every snapshot the gateway already fetches names every thread in the environment, and media
 * naming needs exactly those names. Remembering them here means a media listing can put a real
 * thread title on a row without adding a T3 round trip of its own — see `src/mediaNaming.mjs`.
 * Purely a side effect: a caller that only wants the snapshot is unaffected.
 */
async function readT3Snapshot(environment, options = {}) {
  const snapshot = await fetchT3Snapshot(environment, options);
  rememberSnapshotThreadTitles(environment?.id, snapshot);
  return snapshot;
}

// Every device route that reads T3 reports an unreachable host the same way, so the
// firmware has one error contract to branch on instead of four.
async function fetchDeviceSnapshot(environment) {
  try {
    return await readT3Snapshot(environment);
  } catch (error) {
    throw new HttpError(502, "T3 environment is unavailable.", {
      code: "t3_unreachable",
      environmentId: environment.id,
      cause: errorMessage(error),
    });
  }
}

// The five words this list has always spoken. Refinement into an agent verb happens in
// refineSelectedThreadVerb(), never here: this function sees only the bodiless snapshot
// thread, which carries no evidence about what the agent is doing.
function deviceThreadStatus(thread) {
  const sessionStatus = optionalString(thread?.session?.status);
  const turnStatus = optionalString(thread?.latestTurn?.state);
  if (sessionStatus === "running" || turnStatus === "running") return "running";
  if (sessionStatus === "starting") return "starting";
  return turnStatus ?? sessionStatus ?? "idle";
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
