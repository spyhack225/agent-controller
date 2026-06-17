import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClerkAuthenticator } from "./clerkAuth.mjs";
import { loadConfig } from "./config.mjs";
import { buildDeviceDisplayState, buildUserDisplayState } from "./displayState.mjs";
import { createEventBroker } from "./events.mjs";
import {
  HttpError,
  optionalString,
  readJson,
  requireString,
  sendBuffer,
  sendError,
  sendJson,
} from "./http.mjs";
import { normalizeIntent } from "./intent.mjs";
import {
  buildFirmwareManifest,
  buildFlashConfig,
  isNewerVersion,
  normalizeFirmwareRelease,
} from "./manufacturing.mjs";
import { deleteStoredMedia, readStoredMedia, storeUploadedMedia, transcribeStoredAudio } from "./mediaStore.mjs";
import { buildUserObservabilitySummary } from "./observability.mjs";
import { evaluateIntentPolicy } from "./policy.mjs";
import { isKnownDeviceProfile, listDeviceProfiles, normalizeDeviceProfile } from "./profiles.mjs";
import { createRateLimiter } from "./rateLimit.mjs";
import { createStore } from "./store.mjs";
import {
  buildT3Command,
  dispatchT3Command,
  exchangePairingToken,
  fetchT3Snapshot,
} from "./t3Client.mjs";

const STANDARD_T3_SCOPES = ["orchestration:read", "orchestration:operate"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

export function createApp({
  store = null,
  config = loadConfig(),
  rateLimiter = createRateLimiter(),
  clerkAuth = createClerkAuthenticator(config),
} = {}) {
  store ??= createStore({}, { t3TokenEncryptionKey: config.t3TokenEncryptionKey });
  const events = createEventBroker();
  store.subscribe((state) => events.broadcastStateChange(state));

  async function handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && isStaticRoute(url.pathname)) {
        return serveStatic(res, url.pathname);
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

      if (req.method === "GET" && url.pathname === "/v1/device-profiles") {
        return sendJson(res, 200, { profiles: listDeviceProfiles() });
      }

      if (req.method === "POST" && url.pathname === "/v1/users/dev") {
        if (!isDevTokenCreationEnabled(config)) {
          throw new HttpError(403, "Development token creation is disabled.");
        }
        enforceRateLimit(req, res, rateLimiter, config, {
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
        enforceFactoryWrite(req, res, rateLimiter, config);
        const body = await readJson(req);
        const profile = requireDeviceProfile(body.profile);
        const result = await store.preprovisionDevice({
          label: requireString(body.label, "label"),
          profile,
        });
        return sendJson(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/factory/batches") {
        authenticateFactory(req, config);
        enforceFactoryWrite(req, res, rateLimiter, config);
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
              wifiSsid: optionalString(body.wifiSsid) ?? "your-wifi",
              wifiPassword: optionalString(body.wifiPassword) ?? "your-password",
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
        enforceFactoryWrite(req, res, rateLimiter, config);
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
        enforceFactoryWrite(req, res, rateLimiter, config);
        const hardwareModel = optionalString(url.searchParams.get("hardwareModel"));
        return sendJson(res, 200, {
          releases: await store.listFirmwareReleases({ hardwareModel }),
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/devices") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const profile = requireDeviceProfile(body.profile);
        const result = await store.createDevice({
          userId: user.id,
          label: requireString(body.label, "label"),
          profile,
        });
        return sendJson(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/devices/claim") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const device = await store.claimDevice({
          userId: user.id,
          claimCode: requireString(body.claimCode, "claimCode"),
          label: optionalString(body.label),
        });
        if (!device) throw new HttpError(404, "Claim code is invalid or already used.");
        return sendJson(res, 200, { device });
      }

      const deviceActionMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(revoke|rotate-secret|transfer-reset)$/u);
      if (req.method === "POST" && deviceActionMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const [, deviceId, action] = deviceActionMatch;
        if (action === "revoke") {
          const device = await store.revokeDevice({ userId: user.id, deviceId });
          if (!device) throw new HttpError(404, "Device not found.");
          return sendJson(res, 200, { device });
        }
        if (action === "transfer-reset") {
          const body = await readJson(req);
          const result = await store.resetDeviceForTransfer({
            userId: user.id,
            deviceId,
            label: optionalString(body.label),
          });
          if (!result) throw new HttpError(404, "Device not found or revoked.");
          return sendJson(res, 200, result);
        }
        const result = await store.rotateDeviceSecret({ userId: user.id, deviceId });
        if (!result) throw new HttpError(404, "Device not found or revoked.");
        return sendJson(res, 200, result);
      }

      const deviceConfigMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/config$/u);
      if (deviceConfigMatch && req.method === "GET") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        const device = await store.getDeviceForUser(user.id, deviceConfigMatch[1]);
        if (!device) throw new HttpError(404, "Device not found.");
        return sendJson(res, 200, { deviceId: device.id, config: device.config });
      }

      if (deviceConfigMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
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
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const profile = requireDeviceProfile(body.profile);
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
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { devices: await store.listDevices(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/t3/environments") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
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
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { environments: await store.listEnvironments(user.id) });
      }

      const environmentMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)$/u);
      if (environmentMatch && req.method === "PUT") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
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
        enforceUserWrite(req, res, rateLimiter, config, user);
        const environment = await store.deleteEnvironment({ userId: user.id, environmentId: environmentMatch[1] });
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, { environment });
      }

      const environmentCheckMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/check$/u);
      if (req.method === "POST" && environmentCheckMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const environment = await store.getEnvironmentForUser(user.id, environmentCheckMatch[1]);
        if (!environment) throw new HttpError(404, "Environment not found.");
        return sendJson(res, 200, await checkEnvironmentHealth({ store, userId: user.id, environment }));
      }

      const environmentSnapshotMatch = url.pathname.match(/^\/v1\/t3\/environments\/([^/]+)\/snapshot$/u);
      if (req.method === "GET" && environmentSnapshotMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
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
          return sendJson(res, 200, { environment: updated, snapshot, screen });
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

      if (req.method === "GET" && url.pathname === "/v1/audit") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { events: await store.listAuditLogs(user.id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/commands") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { commands: await store.listCommands(user.id) });
      }

      const commandEventsMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/events$/u);
      if (req.method === "GET" && commandEventsMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
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
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { macros: await store.listMacros(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/macros") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
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
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, await buildSupportDiagnosticsBundle({ store, user }));
      }

      if (req.method === "GET" && url.pathname === "/v1/observability/summary") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { summary: await buildUserObservabilitySummary(store, user.id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/settings/privacy") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { privacy: await store.getUserPrivacySettings(user.id) });
      }

      if (req.method === "PUT" && url.pathname === "/v1/settings/privacy") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const privacy = await store.updateUserPrivacySettings({
          userId: user.id,
          privacy: normalizePrivacySettingsInput(body),
        });
        return sendJson(res, 200, { privacy });
      }

      const commandActionMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/(approve|reject)$/u);
      if (req.method === "POST" && commandActionMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const [, commandId, action] = commandActionMatch;
        const output = action === "approve"
          ? await approveCommand({ store, userId: user.id, commandId })
          : await rejectCommand({ store, userId: user.id, commandId });
        return sendJson(res, action === "approve" ? 202 : 200, output);
      }

      const macroActionMatch = url.pathname.match(/^\/v1\/macros\/([^/]+)(?:\/(run))?$/u);
      if (macroActionMatch && req.method === "DELETE" && !macroActionMatch[2]) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const macro = await store.deleteMacro({ userId: user.id, macroId: macroActionMatch[1] });
        if (!macro) throw new HttpError(404, "Macro not found.");
        return sendJson(res, 200, { macro });
      }

      if (macroActionMatch && req.method === "POST" && macroActionMatch[2] === "run") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
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
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, {
          macro,
          ...output,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/display") {
        const user = await authenticateUser(req, store, config, url, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { display: await buildUserDisplayState(store, user.id) });
      }

      if (req.method === "GET" && url.pathname === "/v1/events") {
        const user = await authenticateUser(req, store, config, url, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return events.connect({ userId: user.id, res });
      }

      if (req.method === "GET" && url.pathname === "/v1/media") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        return sendJson(res, 200, { media: await store.listMediaUploads(user.id) });
      }

      if (req.method === "POST" && url.pathname === "/v1/media") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const media = await storeUploadedMedia({
          store,
          config,
          actor: { type: "user", id: user.id, userId: user.id },
          payload: body,
        });
        return sendJson(res, 201, { media });
      }

      const mediaTranscriptMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/transcript$/u);
      if (req.method === "PUT" && mediaTranscriptMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const media = await store.updateMediaTranscript({
          userId: user.id,
          mediaId: mediaTranscriptMatch[1],
          transcript: requireString(body.transcript, "transcript"),
        });
        if (!media) throw new HttpError(404, "Audio media upload not found.");
        return sendJson(res, 200, { media });
      }

      const mediaTranscribeMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/transcribe$/u);
      if (req.method === "POST" && mediaTranscribeMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
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
        enforceUserWrite(req, res, rateLimiter, config, user);
        return sendJson(res, 200, await purgeExpiredMedia({ store, userId: user.id }));
      }

      const mediaMatch = url.pathname.match(/^\/v1\/media\/([^/]+)$/u);
      if (req.method === "GET" && mediaMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserRead(req, res, rateLimiter, config, user);
        const media = await store.getMediaForUser(user.id, mediaMatch[1]);
        if (!media) throw new HttpError(404, "Media upload not found.");
        const buffer = await readStoredMedia(media);
        return sendBuffer(res, 200, buffer, {
          "content-type": media.contentType,
          "x-media-id": media.id,
          "x-media-sha256": media.sha256,
        });
      }

      if (req.method === "DELETE" && mediaMatch) {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const media = await store.getMediaForUser(user.id, mediaMatch[1]);
        if (!media) throw new HttpError(404, "Media upload not found.");
        await deleteStoredMedia(media);
        const deleted = await store.deleteMediaUpload({ userId: user.id, mediaId: media.id });
        return sendJson(res, 200, { media: deleted });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/heartbeat") {
        const device = await authenticateDevice(req, store);
        enforceDeviceHeartbeat(req, res, rateLimiter, config, device);
        const body = await readJson(req);
        const updatedDevice = await store.recordDeviceHeartbeat({
          deviceId: device.id,
          status: body.status ?? body,
        });
        return sendJson(res, 200, { ok: true, device: updatedDevice ?? device });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/setup-code") {
        const device = await authenticateDevice(req, store);
        enforceDeviceWrite(req, res, rateLimiter, config, device);
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
        const setup = await store.rotateUnclaimedDeviceClaimCode({ deviceId: device.id });
        if (!setup) throw new HttpError(409, "Device cannot create a setup code.");
        return sendJson(res, 201, {
          device: setup.device,
          setup: {
            claimed: false,
            claimCode: setup.claimCode,
            instructions: "Sign in to the Agent Controller dashboard and claim this device with the displayed code.",
          },
          claimCode: setup.claimCode,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/display") {
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
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
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, { deviceId: device.id, config: device.config });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/firmware") {
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
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
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return events.connect({ userId: device.userId, res });
      }

      if (req.method === "GET" && url.pathname === "/v1/device/approvals") {
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const commands = await store.listCommands(device.userId);
        return sendJson(res, 200, {
          commands: commands.filter((command) => command.status === "approval_required"),
        });
      }

      const deviceApprovalMatch = url.pathname.match(/^\/v1\/device\/approvals\/([^/]+)\/(approve|reject)$/u);
      if (req.method === "POST" && deviceApprovalMatch) {
        const device = await authenticateDevice(req, store);
        enforceDeviceWrite(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const [, commandId, action] = deviceApprovalMatch;
        const output = action === "approve"
          ? await approveCommand({ store, userId: device.userId, commandId })
          : await rejectCommand({ store, userId: device.userId, commandId });
        return sendJson(res, action === "approve" ? 202 : 200, output);
      }

      if (req.method === "GET" && url.pathname === "/v1/device/macros") {
        const device = await authenticateDevice(req, store, url);
        enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        return sendJson(res, 200, { macros: await store.listMacros(device.userId) });
      }

      const deviceMacroRunMatch = url.pathname.match(/^\/v1\/device\/macros\/([^/]+)\/run$/u);
      if (req.method === "POST" && deviceMacroRunMatch) {
        const device = await authenticateDevice(req, store);
        enforceDeviceWrite(req, res, rateLimiter, config, device);
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
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, {
          macro,
          ...output,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/media") {
        const device = await authenticateDevice(req, store);
        enforceDeviceWrite(req, res, rateLimiter, config, device);
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
        const device = await authenticateDevice(req, store);
        enforceDeviceRead(req, res, rateLimiter, config, device);
        requireClaimedDevice(device);
        const environmentId = requireString(url.searchParams.get("environmentId"), "environmentId");
        const environment = await store.getEnvironmentForUser(device.userId, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        assertEnvironmentTokenActive(environment);
        const snapshot = await fetchT3Snapshot(environment);
        return sendJson(res, 200, { device, environmentId, screen: compressSnapshot(snapshot) });
      }

      if (req.method === "POST" && url.pathname === "/v1/device/intents") {
        const device = await authenticateDevice(req, store);
        enforceDeviceWrite(req, res, rateLimiter, config, device);
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
          }),
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/intents") {
        const user = await authenticateUser(req, store, config, null, clerkAuth);
        enforceUserWrite(req, res, rateLimiter, config, user);
        const body = await readJson(req);
        const environmentId = requireString(body.environmentId, "environmentId");
        const environment = await store.getEnvironmentForUser(user.id, environmentId);
        if (!environment) throw new HttpError(404, "Environment not found.");
        const output = await submitIntent({
          store,
          environment,
          body,
          actor: { type: "user", id: user.id, userId: user.id, profile: "power-controller" },
        });
        return sendJson(res, output.command.status === "dispatched" ? 202 : 200, output);
      }

      throw new HttpError(404, "Route not found.");
    } catch (error) {
      sendError(res, error);
    }
  }

  return {
    store,
    server: createServer((req, res) => void handle(req, res)),
  };
}

async function submitIntent({ store, environment, body, actor }) {
  const startedAt = Date.now();
  const intent = await normalizeIntent(body.intent ?? {}, {
    store,
    userId: actor.userId,
  });
  const policy = evaluateIntentPolicy({
    device: { profile: actor.profile },
    intent,
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
        result: { reason: policy.reason },
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
      result: { reason: policy.reason },
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
  const t3Command = buildT3Command({ intent, threadId });
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
      normalized: t3Command,
      status: "failed",
      risk: policy.risk,
      result: t3FailureResult(error),
      metrics: commandMetrics({ startedAt, dispatchStartedAt, failure: true }),
    });
    throw new HttpError(502, "T3 dispatch failed.", { command, cause: errorMessage(error) });
  }
  const command = await store.createCommand({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    environmentId: environment.id,
    threadId,
    intent,
    normalized: t3Command,
    status: "dispatched",
    risk: policy.risk,
    result,
    metrics: commandMetrics({ startedAt, dispatchStartedAt, completed: true }),
  });
  return { command };
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

async function purgeExpiredMedia({ store, userId, now = new Date().toISOString() }) {
  const expired = await store.listExpiredMediaUploads({ userId, now });
  const purged = [];
  for (const media of expired) {
    await deleteStoredMedia(media);
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
    if (["text", "command", "transcript", "prompt"].includes(key) && typeof value === "string") {
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
    } else if (["text", "command", "transcript", "prompt"].includes(key) && typeof entry === "string") {
      output[key] = redactText(entry);
    } else {
      output[key] = redactSupportValue(entry);
    }
  }
  return output;
}

function isSecretLikeKey(key) {
  return /(secret|token|authorization|password|accessToken|tokenHash|secretHash|claimCodeHash|storagePath)/iu.test(key);
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
      normalized: t3Command,
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
    normalized: t3Command,
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
  existing = {},
} = {}) {
  const now = Date.now();
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    acknowledgementDurationMs: elapsedMs(startedAt, now),
    dispatchDurationMs: dispatchStartedAt ? elapsedMs(dispatchStartedAt, now) : null,
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
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (config.authProvider === "clerk") {
      if (!clerkAuth) throw new HttpError(503, "Clerk authentication is not configured.");
      const clerkUser = await clerkAuth(req);
      if (!clerkUser) throw new HttpError(401, "Invalid Clerk session token.");
      return await store.ensureUser({
        userId: clerkUser.id,
        email: `${clerkUser.id}@clerk.local`,
      });
    }

    const token = auth.slice("Bearer ".length).trim();
    const user = await store.authenticateUserToken(token);
    if (user) return user;
    if (clerkAuth) {
      const clerkUser = await clerkAuth(req);
      if (clerkUser) {
        return await store.ensureUser({
          userId: clerkUser.id,
          email: `${clerkUser.id}@clerk.local`,
        });
      }
    }
    throw new HttpError(401, "Invalid platform token.");
  }

  const queryToken = url?.searchParams.get("token");
  if (queryToken) {
    if (config.authProvider === "clerk") {
      if (!clerkAuth) throw new HttpError(503, "Clerk authentication is not configured.");
      const previousAuth = req.headers.authorization;
      req.headers.authorization = `Bearer ${queryToken}`;
      try {
        const clerkUser = await clerkAuth(req);
        if (!clerkUser) throw new HttpError(401, "Invalid Clerk session token.");
        return await store.ensureUser({
          userId: clerkUser.id,
          email: `${clerkUser.id}@clerk.local`,
        });
      } finally {
        req.headers.authorization = previousAuth;
      }
    }
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

async function authenticateDevice(req, store, url = null) {
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

function enforceFactoryWrite(req, res, rateLimiter, config) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "factory:write",
    actorId: clientKey(req),
    limit: config.rateLimits?.factoryWrite,
  });
}

function enforceUserRead(req, res, rateLimiter, config, user) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "user:read",
    actorId: user.id,
    limit: config.rateLimits?.userRead,
  });
}

function enforceUserWrite(req, res, rateLimiter, config, user) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "user:write",
    actorId: user.id,
    limit: config.rateLimits?.userWrite,
  });
}

function enforceDeviceHeartbeat(req, res, rateLimiter, config, device) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:heartbeat",
    actorId: device.id,
    limit: config.rateLimits?.deviceHeartbeat,
  });
}

function enforceDeviceRead(req, res, rateLimiter, config, device) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:read",
    actorId: device.id,
    limit: config.rateLimits?.deviceRead,
  });
}

function enforceDeviceWrite(req, res, rateLimiter, config, device) {
  enforceRateLimit(req, res, rateLimiter, config, {
    scope: "device:write",
    actorId: device.id,
    limit: config.rateLimits?.deviceWrite,
  });
}

function enforceRateLimit(req, res, rateLimiter, config, { scope, actorId, limit }) {
  const windowMs = config.rateLimits?.windowMs ?? 60_000;
  const result = rateLimiter.check({
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

function isEnvironmentTokenExpired(environment, now = Date.now()) {
  if (!environment?.accessTokenExpiresAt) return false;
  const expiresAt = Date.parse(environment.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function assertEnvironmentTokenActive(environment) {
  if (isEnvironmentTokenExpired(environment)) {
    throw new HttpError(409, "T3 access token has expired. Re-pair this environment.", {
      environmentId: environment.id,
      accessTokenExpiresAt: environment.accessTokenExpiresAt,
    });
  }
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

function compressSnapshot(snapshot) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects.length : 0;
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads.length : 0;
  return {
    title: "T3 Code",
    state: "reachable",
    line1: `${projects} projects`,
    line2: `${threads} threads`,
  };
}

function isStaticRoute(pathname) {
  return pathname === "/" || pathname === "/app.js" || pathname === "/styles.css";
}

async function serveStatic(res, pathname) {
  const filename = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(PUBLIC_DIR, filename);
  const buffer = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
  return sendBuffer(res, 200, buffer, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
}

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
