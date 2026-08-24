import { createHash, timingSafeEqual } from "node:crypto";

import { ENVIRONMENT_REMOVED_REASON } from "./actions.mjs";
import { defaultSubscription, normalizeSubscription } from "./billing.mjs";
import { CONNECT_SESSION_TTL_MS, normalizeConnectAccessMode } from "./connectSession.mjs";
import { ENVIRONMENT_FAILURE_REASONS } from "./environmentFailure.mjs";
import { createId, createSecret, nowIso } from "./ids.mjs";
import { normalizeOnboarding, normalizeStoredOnboarding } from "./onboarding.mjs";
import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_PRIVACY_SETTINGS = {
  mediaRetentionDays: 30,
};

// The media processing job state machine. `queued` and the three working stages are driven by the
// worker; `review_required` waits on a person; `dispatched` and `failed` are terminal and never
// re-claimed, which is what stops a restart from dispatching the same transcript twice.
export const MEDIA_JOB_STAGES = [
  "queued",
  "transcribing",
  "normalizing",
  "review_required",
  "ready",
  "dispatching",
  "dispatched",
  "failed",
];
const MEDIA_JOB_STAGE_SET = new Set(MEDIA_JOB_STAGES);
export const MEDIA_JOB_TERMINAL_STAGES = new Set(["dispatched", "failed"]);
const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS = 3;
const DEVICE_ONLINE_THRESHOLD_MS = 90_000;
// A claim code has to outlive warehouse-to-customer transit, because the printed label is issued at
// manufacture and read by the owner weeks later. Units that sit in inventory past this refresh from
// the device menu (`rotate: true`) rather than silently on every boot.
const CLAIM_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function claimCodeExpiryFrom(issuedAtMs) {
  return new Date(issuedAtMs + CLAIM_CODE_TTL_MS).toISOString();
}

function claimCodeIsLive(device, now = Date.now()) {
  if (!device.claimCodeHash) return false;
  const expiresAt = Date.parse(device.claimCodeExpiresAt ?? "");
  // A code minted before expiry tracking existed has no recorded end date. Treating it as live
  // keeps already-shipped labels working instead of invalidating them on deploy.
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > now;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

// The shape every store implementation reports back from deleteEnvironment, and the shape the
// dependency preview answers with. Kept here so memory, file, and Convex stores cannot drift.
export function emptyEnvironmentRemoval() {
  return { devices: [], actions: [], macros: [], onboarding: false };
}

export function createStore(seed = {}, options = {}) {
  const t3TokenBox = createSecretBox(options.t3TokenEncryptionKey);
  const users = new Map((seed.users ?? []).map((user) => [user.id, user]));
  const apiTokens = new Map((seed.apiTokens ?? []).map((token) => [token.id, token]));
  const devices = new Map((seed.devices ?? []).map((device) => [device.id, device]));
  const environments = new Map((seed.environments ?? []).map((environment) => [environment.id, environment]));
  const connectSessions = new Map((seed.connectSessions ?? []).map((session) => [session.id, session]));
  const firmwareReleases = new Map((seed.firmwareReleases ?? []).map((release) => [release.id, release]));
  const gatewayProfiles = new Map((seed.gatewayProfiles ?? []).map((profile) => [profile.id, profile]));
  const mediaUploads = new Map((seed.mediaUploads ?? []).map((media) => [media.id, media]));
  const mediaJobs = new Map((seed.mediaJobs ?? []).map((job) => [job.id, job]));
  const macros = new Map((seed.macros ?? []).map((macro) => [macro.id, macro]));
  const actions = new Map((seed.actions ?? []).map((action) => [action.id, action]));
  const deviceControls = new Map(
    (seed.deviceControls ?? []).map((controls) => [
      controls.deviceId,
      { ...controls, explicit: controls.explicit !== false },
    ]),
  );
  const macroRuns = new Map((seed.macroRuns ?? []).map((run) => [run.id, run]));
  // Keyed by user + slug: a profile id is unique per user, not globally.
  const deviceProfiles = new Map(
    (seed.deviceProfiles ?? []).map((profile) => [`${profile.userId}:${profile.profileId}`, profile]),
  );
  const commands = new Map((seed.commands ?? []).map((command) => [command.id, command]));
  const commandEvents = new Map((seed.commandEvents ?? []).map((event) => [event.id, event]));
  const auditLogs = [...(seed.auditLogs ?? [])];
  const listeners = new Set();

  function notifyChanged() {
    for (const listener of listeners) listener(exportState());
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function exportState() {
    return {
      version: 1,
      users: [...users.values()],
      apiTokens: [...apiTokens.values()],
      devices: [...devices.values()],
      environments: [...environments.values()],
      connectSessions: [...connectSessions.values()],
      firmwareReleases: [...firmwareReleases.values()],
      gatewayProfiles: [...gatewayProfiles.values()],
      mediaUploads: [...mediaUploads.values()],
      mediaJobs: [...mediaJobs.values()],
      macros: [...macros.values()],
      actions: [...actions.values()],
      deviceControls: [...deviceControls.values()],
      macroRuns: [...macroRuns.values()],
      deviceProfiles: [...deviceProfiles.values()],
      commands: [...commands.values()],
      commandEvents: [...commandEvents.values()],
      auditLogs,
    };
  }

  function ensureUser({ userId = "user_dev", email = "dev@example.local", name = null } = {}) {
    const existing = users.get(userId);
    if (existing) {
      existing.privacy = normalizePrivacySettings(existing.privacy);
      existing.onboarding = normalizeStoredOnboarding(existing.onboarding);
      if (email && existing.email !== email) existing.email = email;
      if (name && existing.name !== name) existing.name = name;
      return publicUser(existing);
    }
    const user = {
      id: userId,
      email,
      ...(name ? { name } : {}),
      privacy: DEFAULT_PRIVACY_SETTINGS,
      onboarding: normalizeStoredOnboarding(null),
      createdAt: nowIso(),
    };
    users.set(user.id, user);
    audit({
      userId: user.id,
      actorType: "system",
      action: "user.created",
      targetId: user.id,
      metadata: { email },
    });
    notifyChanged();
    return publicUser(user);
  }

  function getUserPrivacySettings(userId) {
    const user = users.get(userId);
    return normalizePrivacySettings(user?.privacy);
  }

  function updateUserPrivacySettings({ userId, privacy }) {
    const user = users.get(userId);
    if (!user) return null;
    user.privacy = normalizePrivacySettings(privacy, user.privacy);
    audit({
      userId,
      actorType: "user",
      action: "user.privacy_updated",
      targetId: userId,
      metadata: user.privacy,
    });
    notifyChanged();
    return user.privacy;
  }

  function getUserSubscription(userId) {
    const user = users.get(userId);
    if (!user) return null;
    return user.subscription
      ? normalizeSubscription(user.subscription, user.subscription, user.subscription.updatedAt)
      : defaultSubscription(user.createdAt ?? nowIso());
  }

  function updateUserSubscription({ userId, ...input }) {
    const user = users.get(userId);
    if (!user) return null;
    const previous = user.subscription ?? defaultSubscription(user.createdAt ?? nowIso());
    user.subscription = normalizeSubscription(input, previous, nowIso());
    audit({
      userId,
      actorType: "user",
      action: "user.subscription_updated",
      targetId: userId,
      metadata: {
        tier: user.subscription.tier,
        status: user.subscription.status,
        provider: user.subscription.provider,
      },
    });
    notifyChanged();
    return user.subscription;
  }

  function getUserOnboarding(userId) {
    return normalizeStoredOnboarding(users.get(userId)?.onboarding);
  }

  function updateUserOnboarding({ userId, onboarding }) {
    const user = users.get(userId);
    if (!user) return null;
    const previous = normalizeStoredOnboarding(user.onboarding);
    user.onboarding = normalizeOnboarding(onboarding, previous);
    const action = user.onboarding.status === "completed"
      ? "user.onboarding_completed"
      : user.onboarding.status === "paused"
        ? "user.onboarding_paused"
        : previous.status === "not_started"
          ? "user.onboarding_started"
          : "user.onboarding_updated";
    audit({
      userId,
      actorType: "user",
      action,
      targetId: userId,
      metadata: {
        status: user.onboarding.status,
        currentStep: user.onboarding.currentStep,
      },
    });
    notifyChanged();
    return user.onboarding;
  }

  function createUserToken({ userId, label = "Platform API token" }) {
    const user = ensureUser({ userId });
    const token = createSecret();
    const record = {
      id: createId("tok"),
      userId: user.id,
      label,
      tokenHash: hashSecret(token),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: nowIso(),
    };
    apiTokens.set(record.id, record);
    audit({
      userId: user.id,
      actorType: "user",
      action: "user_token.created",
      targetId: record.id,
      metadata: { label },
    });
    notifyChanged();
    return { token: publicUserToken(record), secret: token };
  }

  function authenticateUserToken(secret) {
    const hash = hashSecret(secret);
    for (const record of apiTokens.values()) {
      if (record.revokedAt) continue;
      if (!safeEqual(record.tokenHash, hash)) continue;
      const user = users.get(record.userId);
      if (!user) return null;
      record.lastUsedAt = nowIso();
      return user;
    }
    return null;
  }

  function createDevice({ userId, label, profile = "agent-controller" }) {
    const user = ensureUser({ userId });
    const secret = createSecret();
    const device = {
      id: createId("dev"),
      userId: user.id,
      label,
      profile,
      secretHash: hashSecret(secret),
      claimCodeHash: null,
      claimedAt: nowIso(),
      revokedAt: null,
      lastSeenAt: null,
      status: createDefaultDeviceStatus(),
      config: createDefaultDeviceConfig(),
      firmwarePolicy: createDefaultFirmwarePolicy(),
      createdAt: nowIso(),
    };
    devices.set(device.id, device);
    audit({
      userId: user.id,
      actorType: "user",
      action: "device.created",
      targetId: device.id,
      metadata: { label, profile },
    });
    notifyChanged();
    return { device: publicDevice(device), secret };
  }

  function preprovisionDevice({ label, profile = "agent-controller", hardwareModel = null }) {
    const secret = createSecret();
    const claimCode = createHumanCode();
    const device = {
      id: createId("dev"),
      userId: null,
      label,
      profile,
      // Stamped at pre-provision because it is a property of the physical unit, not of whoever
      // ends up owning it. An OTA release targets this, and the console uses it to say which
      // firmware image to flash — of which there is now one per board.
      hardwareModel,
      secretHash: hashSecret(secret),
      claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
      claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      claimedAt: null,
      revokedAt: null,
      lastSeenAt: null,
      status: createDefaultDeviceStatus(),
      config: createDefaultDeviceConfig(),
      firmwarePolicy: createDefaultFirmwarePolicy(),
      createdAt: nowIso(),
    };
    devices.set(device.id, device);
    audit({
      userId: "system",
      actorType: "system",
      action: "device.preprovisioned",
      targetId: device.id,
      metadata: { label, profile, hardwareModel },
    });
    notifyChanged();
    return { device: publicDevice(device), secret, claimCode };
  }

  function claimDevice({ userId, claimCode, label }) {
    const user = ensureUser({ userId });
    const normalized = normalizeClaimCode(claimCode);
    const claimHash = hashSecret(normalized);
    for (const device of devices.values()) {
      if (device.revokedAt || device.claimedAt || !device.claimCodeHash) continue;
      if (!safeEqual(device.claimCodeHash, claimHash)) continue;
      // An expired code is matched but refused, so the caller can say "expired" rather than the
      // indistinguishable "no such code" a `continue` would produce.
      if (!claimCodeIsLive(device)) return null;
      device.userId = user.id;
      device.claimCodeHash = null;
      device.claimCodeExpiresAt = null;
      device.claimedAt = nowIso();
      if (label) device.label = label;
      audit({
        userId: user.id,
        actorType: "user",
        action: "device.claimed",
        targetId: device.id,
        metadata: { label: device.label, profile: device.profile },
      });
      notifyChanged();
      return publicDevice(device);
    }
    return null;
  }

  function revokeDevice({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    device.revokedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "device.revoked",
      targetId: device.id,
      metadata: { label: device.label },
    });
    notifyChanged();
    return publicDevice(device);
  }

  /**
   * Permanently removes a device record. Only a revoked device qualifies: revocation kills the
   * credential, so deleting afterwards cannot strand hardware that is still able to authenticate.
   * Requiring the two steps also makes the irreversible one deliberate.
   *
   * Commands and audit entries reference the device by id and are intentionally left in place —
   * deleting the controller must not erase the record of what it did.
   */
  function deleteDevice({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    if (!device.revokedAt) return { device: null, reason: "not_revoked" };
    const removed = publicDevice(device);
    devices.delete(deviceId);
    deviceControls.delete(deviceId);
    audit({
      userId,
      actorType: "user",
      action: "device.deleted",
      targetId: device.id,
      metadata: { label: device.label, profile: device.profile, revokedAt: device.revokedAt },
    });
    notifyChanged();
    return { device: removed, reason: null };
  }

  function rotateDeviceSecret({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const secret = createSecret();
    device.secretHash = hashSecret(secret);
    audit({
      userId,
      actorType: "user",
      action: "device.secret_rotated",
      targetId: device.id,
      metadata: { label: device.label },
    });
    notifyChanged();
    return { device: publicDevice(device), secret };
  }

  function updateDeviceProfile({ userId, deviceId, profile }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previousProfile = device.profile;
    device.profile = profile;
    audit({
      userId,
      actorType: "user",
      action: "device.profile_updated",
      targetId: device.id,
      metadata: { label: device.label, previousProfile, profile },
    });
    notifyChanged();
    return publicDevice(device);
  }

  function resetDeviceForTransfer({ userId, deviceId, label }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const secret = createSecret();
    const claimCode = createHumanCode();
    const previousLabel = device.label;
    device.userId = null;
    device.label = label ?? device.label;
    device.secretHash = hashSecret(secret);
    device.claimCodeHash = hashSecret(normalizeClaimCode(claimCode));
    device.claimCodeExpiresAt = claimCodeExpiryFrom(Date.now());
    device.claimedAt = null;
    device.lastSeenAt = null;
    device.status = createDefaultDeviceStatus();
    device.config = createDefaultDeviceConfig();
    device.firmwarePolicy = createDefaultFirmwarePolicy();
    deviceControls.delete(device.id);
    audit({
      userId,
      actorType: "user",
      action: "device.transfer_reset",
      targetId: device.id,
      metadata: {
        previousLabel,
        label: device.label,
        profile: device.profile,
      },
    });
    audit({
      userId: "system",
      actorType: "system",
      action: "device.claim_code_rotated",
      targetId: device.id,
      metadata: { label: device.label, profile: device.profile },
    });
    notifyChanged();
    return { device: publicDevice(device), secret, claimCode };
  }

  // Rotating on every call is what invalidated the printed label the moment a unit was powered on:
  // firmware asks for a setup code on its first 403, seconds after boot. The code now survives until
  // it expires, and only an explicit `rotate` — an owner or factory action — replaces it early.
  function ensureUnclaimedDeviceClaimCode({ deviceId, rotate = false }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt || device.claimedAt) return null;
    const now = Date.now();
    if (!rotate && claimCodeIsLive(device, now)) {
      // Codes are stored hashed, so the plaintext cannot be handed back a second time — and should
      // not be. The device caches the code it was issued; "still valid" is the whole answer.
      return {
        device: publicDevice(device),
        claimCode: null,
        rotated: false,
        claimCodeExpiresAt: device.claimCodeExpiresAt ?? null,
      };
    }
    const claimCode = createHumanCode();
    device.claimCodeHash = hashSecret(normalizeClaimCode(claimCode));
    device.claimCodeExpiresAt = claimCodeExpiryFrom(now);
    audit({
      userId: "system",
      actorType: "device",
      actorId: device.id,
      action: "device.setup_code_rotated",
      targetId: device.id,
      metadata: { label: device.label, profile: device.profile, rotate },
    });
    notifyChanged();
    return {
      device: publicDevice(device),
      claimCode,
      rotated: true,
      claimCodeExpiresAt: device.claimCodeExpiresAt,
    };
  }

  function authenticateDevice(deviceId, secret) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    if (!safeEqual(device.secretHash, hashSecret(secret))) return null;
    device.lastSeenAt = nowIso();
    notifyChanged();
    return publicDevice(device);
  }

  function recordDeviceHeartbeat({ deviceId, status = {} }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    const heartbeatAt = nowIso();

    // A heartbeat arriving after the device had gone offline is a reconnect. Recording it is what
    // makes "reliable device reconnect after Wi-Fi loss" measurable rather than guessed: an
    // offline gap alone cannot distinguish a reconnect from a device that never came back.
    const previousHeartbeatAt = Date.parse(device.status?.lastHeartbeatAt ?? "");
    const gapMs = Number.isFinite(previousHeartbeatAt)
      ? Date.parse(heartbeatAt) - previousHeartbeatAt
      : null;
    const reconnected = gapMs !== null && gapMs > DEVICE_ONLINE_THRESHOLD_MS;

    device.lastSeenAt = heartbeatAt;
    device.status = normalizeDeviceStatus(status, device.status, heartbeatAt);
    device.connectivity = {
      heartbeatCount: (device.connectivity?.heartbeatCount ?? 0) + 1,
      reconnectCount: (device.connectivity?.reconnectCount ?? 0) + (reconnected ? 1 : 0),
      lastReconnectAt: reconnected ? heartbeatAt : device.connectivity?.lastReconnectAt ?? null,
      longestOfflineMs: Math.max(device.connectivity?.longestOfflineMs ?? 0, reconnected ? gapMs : 0),
    };

    notifyChanged();
    return publicDevice(device);
  }

  function listDevices(userId) {
    return [...devices.values()]
      .filter((device) => device.userId === userId)
      .map(publicDevice);
  }

  function getDeviceForUser(userId, deviceId) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return publicDevice(device);
  }

  // actorType defaults to "user" because the owner-facing PUT is the common path.
  // A device changing its own thread passes "device", so the audit trail does not
  // credit the owner with something the hardware did on its own.
  function updateDeviceConfig({ userId, deviceId, config, actorType = "user", actorId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previousLabel = device.label;
    if (Object.hasOwn(config, "label")) {
      device.label = normalizeNullableString(config.label) ?? device.label;
    }
    device.config = normalizeDeviceConfig(config, device.config);
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: "device.config_updated",
      targetId: device.id,
      metadata: {
        label: device.label,
        previousLabel,
        environmentId: device.config.environmentId,
        threadId: device.config.threadId,
        gatewayAccessMode: device.config.gatewayAccessMode,
        gatewayUrl: device.config.gatewayUrl,
        menu: device.config.menu,
      },
    });
    notifyChanged();
    return publicDevice(device);
  }

  /**
   * Grants or revokes this device's licence to auto-send a finished voice transcript.
   *
   * Scoped to one device on purpose. Audio is captured by a particular microphone in a particular
   * room, so the trust question is about that unit — an account-wide switch would silently extend
   * the grant to the next controller the owner claims.
   */
  function setDeviceVoiceAutoSend({ userId, deviceId, enabled, actorId = null, actorType = "user" }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    device.voiceAutoSend = normalizeVoiceAutoSend(
      enabled === true ? { enabled: true, enabledBy: actorId ?? userId, enabledAt: nowIso() } : { enabled: false },
    );
    device.updatedAt = nowIso();
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: enabled === true ? "device.voice_auto_send_enabled" : "device.voice_auto_send_disabled",
      targetId: deviceId,
      metadata: device.voiceAutoSend,
    });
    notifyChanged();
    return publicDevice(device);
  }

  function createGatewayProfile({ userId, label, mode, url }) {
    const profile = { id: createId("gateway"), userId, label, mode, url, createdAt: nowIso(), updatedAt: nowIso() };
    gatewayProfiles.set(profile.id, profile);
    audit({ userId, actorType: "user", action: "gateway_profile.created", targetId: profile.id,
      metadata: { label, mode, origin: url } });
    notifyChanged();
    return { ...profile };
  }

  function listGatewayProfiles(userId) {
    return [...gatewayProfiles.values()].filter((profile) => profile.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((profile) => ({ ...profile }));
  }

  function getGatewayProfileForUser(userId, profileId) {
    const profile = gatewayProfiles.get(profileId);
    return profile?.userId === userId ? { ...profile } : null;
  }

  function updateGatewayProfile({ userId, profileId, label, mode, url }) {
    const profile = gatewayProfiles.get(profileId);
    if (!profile || profile.userId !== userId) return null;
    const deviceIds = [...devices.values()].filter((device) => device.userId === userId
      && [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(profileId))
      .map((device) => device.id);
    if (deviceIds.length && (profile.url !== url || profile.mode !== mode)) return { conflict: true, deviceIds };
    Object.assign(profile, { label, mode, url, updatedAt: nowIso() });
    audit({ userId, actorType: "user", action: "gateway_profile.updated", targetId: profile.id,
      metadata: { label, mode, origin: url } });
    notifyChanged();
    return { ...profile, conflict: false };
  }

  function deleteGatewayProfile({ userId, profileId }) {
    const profile = gatewayProfiles.get(profileId);
    if (!profile || profile.userId !== userId) return null;
    const deviceIds = [...devices.values()].filter((device) => device.userId === userId
      && [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(profileId))
      .map((device) => device.id);
    if (deviceIds.length) return { conflict: true, deviceIds };
    gatewayProfiles.delete(profileId);
    audit({ userId, actorType: "user", action: "gateway_profile.deleted", targetId: profileId,
      metadata: { label: profile.label, mode: profile.mode } });
    notifyChanged();
    return { profile: { ...profile }, conflict: false };
  }

  function getDeviceGatewaySelection({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return normalizeGatewaySelection(device.gatewaySelection);
  }

  function stageDeviceGatewaySwitch({ userId, deviceId, profileId, actorType = "user", actorId = null }) {
    const device = devices.get(deviceId);
    const profile = gatewayProfiles.get(profileId);
    if (!device || device.userId !== userId || device.revokedAt || !profile || profile.userId !== userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    device.gatewaySelection = {
      ...previous,
      revision: previous.revision + 1,
      state: "pending",
      previousProfileId: previous.activeProfileId,
      pendingProfileId: profileId,
      requestedAt: nowIso(),
      lastError: null,
    };
    audit({ userId, actorType, ...(actorId ? { actorId } : {}), action: "device.gateway_switch_requested",
      targetId: deviceId, metadata: { revision: device.gatewaySelection.revision, profileId } });
    notifyChanged();
    return structuredClone(device.gatewaySelection);
  }

  function reportDeviceGatewaySwitch({ userId, deviceId, revision, profileId, status, detail = null }) {
    const device = devices.get(deviceId);
    const profile = gatewayProfiles.get(profileId);
    if (!device || device.userId !== userId || device.revokedAt || !profile || profile.userId !== userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    if (revision !== previous.revision) return { conflict: true, selection: previous };
    if (status === "requested") {
      const selection = stageDeviceGatewaySwitch({ userId, deviceId, profileId, actorType: "device", actorId: deviceId });
      return { conflict: false, selection };
    }
    if (status === "applied") {
      if (previous.pendingProfileId && previous.pendingProfileId !== profileId) return { conflict: true, selection: previous };
      device.gatewaySelection = {
        ...previous,
        revision: previous.pendingProfileId ? previous.revision : previous.revision + 1,
        state: "stable",
        previousProfileId: previous.activeProfileId,
        activeProfileId: profileId,
        pendingProfileId: null,
        appliedAt: nowIso(),
        lastError: null,
      };
    } else {
      if (previous.pendingProfileId && previous.pendingProfileId !== profileId) return { conflict: true, selection: previous };
      device.gatewaySelection = { ...previous, state: "failed", pendingProfileId: null,
        lastError: detail ?? "Gateway probe failed." };
    }
    audit({ userId, actorType: "device", actorId: deviceId,
      action: status === "applied" ? "device.gateway_switch_applied" : "device.gateway_switch_failed",
      targetId: deviceId, metadata: { revision: device.gatewaySelection.revision, profileId, detail } });
    notifyChanged();
    return { conflict: false, selection: structuredClone(device.gatewaySelection) };
  }

  function rollbackDeviceGatewaySwitch({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    device.gatewaySelection = { ...previous, revision: previous.revision + 1, state: "stable",
      pendingProfileId: null, lastError: null };
    audit({ userId, actorType: "user", action: "device.gateway_switch_rolled_back", targetId: deviceId,
      metadata: { revision: device.gatewaySelection.revision, activeProfileId: device.gatewaySelection.activeProfileId } });
    notifyChanged();
    return structuredClone(device.gatewaySelection);
  }

  function createAction(input) {
    const action = {
      id: createId("action"),
      userId: input.userId,
      type: input.type,
      label: input.label,
      payload: structuredClone(input.payload ?? {}),
      targetMode: input.targetMode ?? "device-current",
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      steps: structuredClone(input.steps ?? []),
      disabled: input.disabled === true,
      disabledReason: input.disabled === true ? (input.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    actions.set(action.id, action);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "action.created",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, stepCount: action.steps.length },
    });
    notifyChanged();
    return publicAction(action);
  }

  function getActionForUser(userId, actionId) {
    const action = actions.get(actionId);
    return action?.userId === userId ? publicAction(action) : null;
  }

  function listActions(userId) {
    return [...actions.values()]
      .filter((action) => action.userId === userId)
      .map(publicAction);
  }

  function updateAction({ userId, actionId, ...input }) {
    const action = actions.get(actionId);
    if (!action || action.userId !== userId) return null;
    for (const key of ["type", "label", "targetMode", "environmentId", "threadId", "disabled", "disabledReason"]) {
      if (input[key] !== undefined) action[key] = input[key];
    }
    if (input.payload !== undefined) action.payload = structuredClone(input.payload);
    if (input.steps !== undefined) action.steps = structuredClone(input.steps);
    action.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "action.updated",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, stepCount: action.steps.length },
    });
    notifyChanged();
    return publicAction(action);
  }

  function deleteAction({ userId, actionId }) {
    const action = actions.get(actionId);
    if (!action || action.userId !== userId) return null;
    actions.delete(actionId);
    const unassignedDeviceIds = [];
    for (const controls of deviceControls.values()) {
      if (controls.userId !== userId) continue;
      const items = controls.items.filter((item) => item.actionId !== actionId);
      if (items.length === controls.items.length) continue;
      controls.items = items;
      controls.revision += 1;
      controls.updatedAt = nowIso();
      unassignedDeviceIds.push(controls.deviceId);
    }
    audit({
      userId,
      actorType: "user",
      action: "action.deleted",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, unassignedDeviceIds },
    });
    notifyChanged();
    return { action: publicAction(action), unassignedDeviceIds };
  }

  function recordActionRun({ userId, actionId, actorType, actorId, status, intentType = null, commandIds = [] }) {
    audit({
      userId,
      actorType,
      actorId,
      action: `action.run_${status}`,
      targetId: actionId,
      metadata: { intentType, commandIds: [...commandIds] },
    });
    notifyChanged();
    return true;
  }

  function createMacroRun(input) {
    const run = {
      id: createId("macrorun"),
      userId: input.userId,
      actionId: input.actionId,
      approvalCommandId: input.approvalCommandId,
      nextStepIndex: input.nextStepIndex,
      runtime: structuredClone(input.runtime),
      actor: structuredClone(input.actor),
      policyContext: structuredClone(input.policyContext ?? {}),
      baseUrl: input.baseUrl ?? null,
      executions: structuredClone(input.executions ?? []),
      status: "waiting_approval",
      resumeAttempts: 0,
      resumeClaimedAt: null,
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    macroRuns.set(run.id, run);
    notifyChanged();
    return structuredClone(run);
  }

  function getMacroRunForApproval({ userId, commandId }) {
    const run = [...macroRuns.values()].find((candidate) => candidate.userId === userId
      && candidate.approvalCommandId === commandId);
    return run ? structuredClone(run) : null;
  }

  function claimMacroRunForResume({ userId, runId, leaseMs = 30_000 }) {
    const run = macroRuns.get(runId);
    if (!run || run.userId !== userId) return null;
    const claimedAt = Date.parse(run.resumeClaimedAt ?? "");
    if (run.status === "resuming" && Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs) return null;
    if (!["waiting_approval", "resuming"].includes(run.status)) return null;
    run.status = "resuming";
    run.resumeAttempts += 1;
    run.resumeClaimedAt = nowIso();
    run.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(run);
  }

  function updateMacroRun({ userId, runId, ...input }) {
    const run = macroRuns.get(runId);
    if (!run || run.userId !== userId) return null;
    for (const key of ["approvalCommandId", "nextStepIndex", "status", "result"]) {
      if (input[key] !== undefined) run[key] = structuredClone(input[key]);
    }
    if (input.executions !== undefined) run.executions = structuredClone(input.executions);
    run.resumeClaimedAt = input.status === "waiting_approval" ? null : run.resumeClaimedAt;
    run.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(run);
  }

  function getDeviceControls({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return publicDeviceControls(deviceControls.get(deviceId) ?? createDefaultDeviceControls(device));
  }

  function updateDeviceControls({ userId, deviceId, items }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const existing = deviceControls.get(deviceId) ?? createDefaultDeviceControls(device);
    const controls = {
      ...existing,
      explicit: true,
      userId,
      deviceId,
      revision: existing.revision + 1,
      items: structuredClone(items),
      updatedAt: nowIso(),
    };
    deviceControls.set(deviceId, controls);
    audit({
      userId,
      actorType: "user",
      action: "device.controls_updated",
      targetId: deviceId,
      metadata: { revision: controls.revision, itemCount: controls.items.length },
    });
    notifyChanged();
    return publicDeviceControls(controls);
  }

  function acknowledgeDeviceControls({
    userId,
    deviceId,
    revision,
    status = "applied",
    error = null,
    appliedCount = null,
    expectedCount = null,
  }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const controls = deviceControls.get(deviceId) ?? createDefaultDeviceControls(device);
    if (!controls.explicit) return { controls: publicDeviceControls(controls), reason: "no_explicit_layout" };
    let reason = null;
    if (revision > controls.revision) reason = "future_revision";
    else if (revision < controls.revision) reason = "stale_revision";
    else if (appliedCount !== null && expectedCount !== null && appliedCount !== expectedCount) reason = "count_mismatch";
    if (reason) {
      controls.lastAckStatus = "rejected";
      controls.lastAckError = reason === "count_mismatch"
        ? `Device applied ${appliedCount} controls; gateway resolved ${expectedCount}.`
        : `Device acknowledged revision ${revision}; current revision is ${controls.revision}.`;
    } else {
      controls.appliedRevision = Math.max(controls.appliedRevision ?? 0, revision);
      controls.appliedAt = nowIso();
      controls.lastAckStatus = status;
      controls.lastAckError = error;
    }
    deviceControls.set(deviceId, controls);
    audit({
      userId,
      actorType: "device",
      actorId: deviceId,
      action: "device.controls_acknowledged",
      targetId: deviceId,
      metadata: { revision, status: controls.lastAckStatus, error: controls.lastAckError, appliedCount, expectedCount },
    });
    notifyChanged();
    return { controls: publicDeviceControls(controls), reason };
  }

  function getDeviceFirmwarePolicy({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return normalizeFirmwarePolicy({}, device.firmwarePolicy);
  }

  function updateDeviceFirmwarePolicy({ userId, deviceId, policy, actorType = "user", actorId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    device.firmwarePolicy = normalizeFirmwarePolicy(policy, device.firmwarePolicy);
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: actorType === "device" ? "device.firmware_reported" : "device.firmware_policy_updated",
      targetId: deviceId,
      metadata: device.firmwarePolicy,
    });
    notifyChanged();
    return { ...device.firmwarePolicy };
  }

  function upsertEnvironment(input) {
    const user = ensureUser({ userId: input.userId });
    const normalizedBaseUrl = input.baseUrl.replace(/\/+$/u, "");
    const existing = input.id
      ? environments.get(input.id)
      : [...environments.values()]
        .filter((environment) => environment.userId === user.id && environment.baseUrl === normalizedBaseUrl)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0] ?? null;
    if (input.id && (!existing || existing.userId !== user.id)) return null;
    const environment = {
      id: existing?.id ?? createId("env"),
      userId: user.id,
      label: input.label,
      baseUrl: normalizedBaseUrl,
      ...(t3TokenBox.enabled
        ? { accessTokenCiphertext: t3TokenBox.seal(input.accessToken) }
        : { accessToken: input.accessToken }),
      scopes: input.scopes,
      accessTokenExpiresAt: normalizeNullableString(input.accessTokenExpiresAt) ?? null,
      status: input.status ?? "unknown",
      health: normalizeEnvironmentHealth(input.health, existing?.health),
      // Re-pairing must not discard the registered harness catalogue.
      ...(existing?.providerCatalogue ? { providerCatalogue: existing.providerCatalogue } : {}),
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    environments.set(environment.id, environment);
    audit({
      userId: user.id,
      actorType: "user",
      action: "environment.upserted",
      targetId: environment.id,
      metadata: { label: environment.label, baseUrl: environment.baseUrl, scopes: environment.scopes },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  function updateEnvironmentCatalogue({ userId, environmentId, catalogue }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    environment.providerCatalogue = catalogue;
    environment.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "environment.catalogue_updated",
      targetId: environment.id,
      metadata: {
        source: catalogue?.source ?? null,
        instanceCount: catalogue?.instances?.length ?? 0,
        instanceIds: (catalogue?.instances ?? []).map((instance) => instance.instanceId),
      },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  // Nothing may keep pointing at a removed environment. A fixed-target action or macro without an
  // environmentId is a row `normalizeActionInput` would refuse to create, so an orphan is disabled
  // with a reason rather than silently retargeted at whatever the device happens to be using.
  function deleteEnvironment({ userId, environmentId }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    environments.delete(environmentId);
    const removed = emptyEnvironmentRemoval();
    for (const device of devices.values()) {
      if (device.userId !== userId || device.config?.environmentId !== environmentId) continue;
      device.config = normalizeDeviceConfig({ ...device.config, environmentId: null }, device.config);
      removed.devices.push(device.id);
    }
    for (const action of actions.values()) {
      if (action.userId !== userId || action.environmentId !== environmentId) continue;
      action.environmentId = null;
      action.threadId = null;
      action.targetMode = "device-current";
      action.disabled = true;
      action.disabledReason = ENVIRONMENT_REMOVED_REASON;
      action.updatedAt = nowIso();
      removed.actions.push(action.id);
    }
    for (const macro of macros.values()) {
      if (macro.userId !== userId || macro.environmentId !== environmentId) continue;
      macro.environmentId = null;
      macro.threadId = null;
      macro.disabled = true;
      macro.disabledReason = ENVIRONMENT_REMOVED_REASON;
      macro.updatedAt = nowIso();
      removed.macros.push(macro.id);
    }
    const user = users.get(userId);
    const onboarding = user ? normalizeStoredOnboarding(user.onboarding) : null;
    if (onboarding?.environmentId === environmentId) {
      user.onboarding = {
        ...onboarding,
        environmentId: null,
        firstThreadId: null,
        updatedAt: nowIso(),
      };
      removed.onboarding = true;
    }
    audit({
      userId,
      actorType: "user",
      action: "environment.deleted",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        baseUrl: environment.baseUrl,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    notifyChanged();
    return { environment: publicEnvironment(environment), removed };
  }

  function updateEnvironmentHealth({ userId, environmentId, status, health }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    const nextHealth = normalizeEnvironmentHealth(health, environment.health);
    environment.status = status ?? environment.status;
    environment.health = nextHealth;
    environment.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "environment.health_checked",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        status: environment.status,
        lastError: nextHealth.lastError,
      },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  function getEnvironmentForUser(userId, environmentId) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    return environmentForGateway(environment, t3TokenBox);
  }

  function listEnvironments(userId) {
    const uniqueByUrl = new Map();
    for (const environment of [...environments.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
      if (!uniqueByUrl.has(environment.baseUrl)) uniqueByUrl.set(environment.baseUrl, environment);
    }
    return [...uniqueByUrl.values()].map(publicEnvironment);
  }

  // Console-first pairing. The console mints one of these while the user is signed in; the setup
  // script on the T3 host redeems it with no platform credential of its own. See
  // src/connectSession.mjs for why the code — not a token — is what travels.
  function createConnectSession({ userId, label, accessMode, environmentId = null }) {
    const user = ensureUser({ userId });
    const code = createHumanCode();
    const timestamp = nowIso();
    const session = {
      id: createId("cxn"),
      userId: user.id,
      label: label || "T3 Code",
      accessMode: normalizeConnectAccessMode(accessMode),
      // Set only when re-pairing. It is what keeps a re-pair updating the existing row instead of
      // adding a second one for the same host.
      environmentId: environmentId ?? null,
      status: "pending",
      codeHash: hashSecret(normalizeClaimCode(code)),
      expiresAt: new Date(Date.now() + CONNECT_SESSION_TTL_MS).toISOString(),
      baseUrl: null,
      error: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    connectSessions.set(session.id, session);
    audit({
      userId: user.id,
      actorType: "user",
      action: "connect_session.created",
      targetId: session.id,
      metadata: { label: session.label, accessMode: session.accessMode, environmentId: session.environmentId },
    });
    notifyChanged();
    return { session: publicConnectSession(session), code };
  }

  function getConnectSession({ userId, sessionId }) {
    const session = connectSessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    return publicConnectSession(expireConnectSessionIfDue(session));
  }

  // Consumes the code before the caller does any network work. The exchange that follows can fail,
  // and burning the code either way is the point: a code that survives a failed attempt is a code
  // that can be replayed.
  function claimConnectSession({ code }) {
    const claimHash = hashSecret(normalizeClaimCode(code));
    for (const session of connectSessions.values()) {
      if (!session.codeHash || !safeEqual(session.codeHash, claimHash)) continue;
      if (expireConnectSessionIfDue(session).status === "expired") {
        notifyChanged();
        // Matched but refused, so the host can say "expired" rather than the indistinguishable
        // "no such code" a `continue` would produce.
        return { session: null, reason: "expired" };
      }
      if (session.status !== "pending") return { session: null, reason: "used" };
      session.status = "redeeming";
      session.updatedAt = nowIso();
      notifyChanged();
      return { session: publicConnectSession(session), reason: null };
    }
    return { session: null, reason: "unknown" };
  }

  function completeConnectSession({ sessionId, environmentId = null, baseUrl = null, error = null }) {
    const session = connectSessions.get(sessionId);
    if (!session) return null;
    session.status = error ? "failed" : "completed";
    session.environmentId = environmentId ?? session.environmentId;
    session.baseUrl = baseUrl ?? session.baseUrl;
    session.error = error ?? null;
    session.codeHash = null;
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    audit({
      userId: session.userId,
      actorType: "user",
      action: error ? "connect_session.failed" : "connect_session.completed",
      targetId: session.id,
      metadata: { environmentId: session.environmentId, baseUrl: session.baseUrl, error: session.error },
    });
    notifyChanged();
    return publicConnectSession(session);
  }

  // The hash survives an expiry so a late redeem still reports "expired" rather than "unknown"; it
  // is cleared only when the session reaches a terminal state, which is what makes a replayed code
  // indistinguishable from one that never existed.
  function expireConnectSessionIfDue(session) {
    if (session.status !== "pending") return session;
    if (Date.parse(session.expiresAt) > Date.now()) return session;
    session.status = "expired";
    session.updatedAt = nowIso();
    return session;
  }

  function createFirmwareRelease(input) {
    const release = {
      id: createId("fw"),
      version: input.version,
      channel: input.channel ?? "stable",
      hardwareModel: input.hardwareModel,
      url: input.url,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      mandatory: input.mandatory,
      releaseNotes: input.releaseNotes ?? "",
      artifactKey: input.artifactKey ?? null,
      artifactProvider: input.artifactProvider ?? null,
      createdAt: nowIso(),
    };
    firmwareReleases.set(release.id, release);
    audit({
      userId: "system",
      actorType: "system",
      action: "firmware.release_created",
      targetId: release.id,
      metadata: {
        version: release.version,
        channel: release.channel,
        hardwareModel: release.hardwareModel,
        mandatory: release.mandatory,
      },
    });
    notifyChanged();
    return release;
  }

  function listFirmwareReleases({ hardwareModel, channel } = {}) {
    return [...firmwareReleases.values()]
      .filter((release) => (!hardwareModel || release.hardwareModel === hardwareModel)
        && (!channel || (release.channel ?? "stable") === channel))
      .map(publicFirmwareRelease)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function deleteFirmwareRelease(releaseId) {
    const release = firmwareReleases.get(releaseId);
    if (!release) return null;
    firmwareReleases.delete(releaseId);
    audit({
      userId: "system",
      actorType: "system",
      action: "firmware.release_deleted",
      targetId: releaseId,
      metadata: { version: release.version, channel: release.channel, hardwareModel: release.hardwareModel },
    });
    notifyChanged();
    return { ...release };
  }

  function getLatestFirmwareRelease({ hardwareModel, channel }) {
    return listFirmwareReleases({ hardwareModel, channel }).at(-1) ?? null;
  }

  function getFirmwareArtifact({ sha256, hardwareModel = null }) {
    const release = [...firmwareReleases.values()].find((candidate) => candidate.sha256 === sha256
      && candidate.artifactKey && (!hardwareModel || candidate.hardwareModel === hardwareModel));
    return release ? { ...release } : null;
  }

  function createMediaUpload(input) {
    const transcript = input.kind === "audio" ? normalizeTranscript(input.transcript) ?? null : null;
    const media = {
      id: createId("media"),
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      storagePath: input.storagePath,
      originalName: input.originalName ?? null,
      transcript,
      processing: normalizeMediaProcessing(input.processing, input.kind, transcript),
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso(),
    };
    mediaUploads.set(media.id, media);
    audit({
      userId: input.userId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      action: "media.uploaded",
      targetId: media.id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        transcriptLength: media.transcript?.length ?? 0,
        transcriptionStatus: media.processing?.transcriptionStatus ?? null,
        expiresAt: media.expiresAt,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function getMediaForUser(userId, mediaId) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    return media;
  }

  function updateMediaTranscript({ userId, mediaId, transcript, source = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId || media.kind !== "audio") return null;
    const previousLength = media.transcript?.length ?? 0;
    media.transcript = normalizeTranscript(transcript) ?? null;
    media.processing = normalizeMediaProcessing({
      transcriptionStatus: media.transcript ? "ready" : "pending",
      transcriptSource: media.transcript ? source : null,
      lastError: null,
    }, media.kind, media.transcript);
    audit({
      userId,
      actorType: "user",
      action: "media.transcript_updated",
      targetId: media.id,
      metadata: {
        previousLength,
        transcriptLength: media.transcript?.length ?? 0,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function createDeviceProfile({ userId, profileId, label, description, capabilities }) {
    const key = `${userId}:${profileId}`;
    if (deviceProfiles.has(key)) return null;
    const profile = {
      id: createId("dprof"),
      userId,
      profileId,
      label,
      description,
      capabilities: [...capabilities],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    deviceProfiles.set(key, profile);
    audit({
      userId,
      actorType: "user",
      action: "device_profile.created",
      targetId: profileId,
      metadata: { label, capabilities: profile.capabilities },
    });
    notifyChanged();
    return { ...profile };
  }

  function listUserDeviceProfiles(userId) {
    return [...deviceProfiles.values()]
      .filter((profile) => profile.userId === userId)
      .map((profile) => ({ ...profile, capabilities: [...profile.capabilities] }));
  }

  function getUserDeviceProfile(userId, profileId) {
    const profile = deviceProfiles.get(`${userId}:${profileId}`);
    return profile ? { ...profile, capabilities: [...profile.capabilities] } : null;
  }

  function updateDeviceProfileDefinition({ userId, profileId, label, description, capabilities }) {
    const profile = deviceProfiles.get(`${userId}:${profileId}`);
    if (!profile) return null;
    if (label !== undefined) profile.label = label;
    if (description !== undefined) profile.description = description;
    if (capabilities !== undefined) profile.capabilities = [...capabilities];
    profile.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "device_profile.updated",
      targetId: profileId,
      metadata: { label: profile.label, capabilities: profile.capabilities },
    });
    notifyChanged();
    return { ...profile, capabilities: [...profile.capabilities] };
  }

  function deleteDeviceProfile({ userId, profileId }) {
    const key = `${userId}:${profileId}`;
    const profile = deviceProfiles.get(key);
    if (!profile) return null;
    deviceProfiles.delete(key);
    audit({
      userId,
      actorType: "user",
      action: "device_profile.deleted",
      targetId: profileId,
      metadata: { label: profile.label },
    });
    notifyChanged();
    return { ...profile, capabilities: [...profile.capabilities] };
  }

  function updateMediaDescription({ userId, mediaId, description, source = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId || media.kind !== "image") return null;
    const previousLength = media.description?.length ?? 0;
    media.description = normalizeTranscript(description) ?? null;
    media.processing = normalizeMediaProcessing({
      visionStatus: media.description ? "ready" : "pending",
      descriptionSource: media.description ? source : null,
      lastError: null,
    }, media.kind, media.transcript, media.description);
    audit({
      userId,
      actorType: "user",
      action: "media.description_updated",
      targetId: media.id,
      metadata: {
        previousLength,
        descriptionLength: media.description?.length ?? 0,
        source,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function updateMediaProcessing({ userId, mediaId, processing }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    if (media.kind !== "audio" && media.kind !== "image") return null;
    media.processing = normalizeMediaProcessing(processing, media.kind, media.transcript, media.description);
    audit({
      userId,
      actorType: "system",
      action: "media.processing_updated",
      targetId: media.id,
      metadata: media.processing,
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function listMediaUploads(userId) {
    return [...mediaUploads.values()]
      .filter((media) => media.userId === userId)
      .map(publicMediaUpload);
  }

  function listExpiredMediaUploads({ userId, now = nowIso() }) {
    return [...mediaUploads.values()]
      .filter((media) => media.userId === userId && media.expiresAt && media.expiresAt <= now);
  }

  function deleteMediaUpload({ userId, mediaId, reason = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    mediaUploads.delete(mediaId);
    // A job whose media is gone can never finish; leaving it queued would make the worker
    // rediscover it on every tick until the retry budget burned out.
    for (const [jobId, job] of mediaJobs) {
      if (job.mediaId === mediaId) mediaJobs.delete(jobId);
    }
    audit({
      userId,
      actorType: "user",
      action: "media.deleted",
      targetId: media.id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        reason,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  // --- Durable media processing jobs -------------------------------------------------------
  //
  // Transcription used to run inside the HTTP handler, so a 30-second ASR call held a socket open
  // and died with the process. Jobs are rows now: the request enqueues one and the worker in
  // src/mediaJobs.mjs drives it, so a restart mid-flight resumes instead of losing the work.

  function createMediaJob(input) {
    const media = mediaUploads.get(input.mediaId);
    if (!media || media.userId !== input.userId) return null;
    const kind = input.kind ?? "transcription";

    // Enqueue is idempotent. Two clicks on "Transcribe" (or a retry after a flaky response) must
    // not produce two workers racing to write the same transcript.
    const active = [...mediaJobs.values()].find((job) => job.userId === input.userId
      && job.mediaId === input.mediaId
      && job.kind === kind
      && !MEDIA_JOB_TERMINAL_STAGES.has(job.stage));
    if (active) return structuredClone(active);

    const job = {
      id: createId("mjob"),
      userId: input.userId,
      mediaId: input.mediaId,
      kind,
      stage: "queued",
      // Where the capture came from, and where a finished transcript would be sent. Recorded at
      // enqueue because the worker runs long after the request that created the job is gone, and
      // a controller's configured thread can change in the meantime — the capture belongs to the
      // thread the owner was looking at when they pressed record.
      deviceId: input.deviceId ?? null,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      // The dispatch outcome, filled in by the worker. `autoSend` is the decision it actually
      // acted on, not the preference read at enqueue: a grant revoked while the job sat in the
      // queue has to win.
      autoSend: false,
      dispatchStatus: null,
      dispatchError: null,
      commandId: null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      language: input.language ?? null,
      rawTranscript: null,
      normalizedTranscript: null,
      userEditedTranscript: null,
      attempts: 0,
      maxAttempts: normalizeAttemptLimit(input.maxAttempts),
      reviewRequired: input.reviewRequired === true,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      failureKind: null,
      timings: { queuedAt: nowIso() },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    mediaJobs.set(job.id, job);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "media_job.queued",
      targetId: job.id,
      metadata: {
        mediaId: job.mediaId,
        kind: job.kind,
        provider: job.provider,
        maxAttempts: job.maxAttempts,
        deviceId: job.deviceId,
      },
    });
    notifyChanged();
    return structuredClone(job);
  }

  function getMediaJobForUser(userId, jobId) {
    const job = mediaJobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return structuredClone(job);
  }

  function listMediaJobs({ userId, mediaId = null, stage = null } = {}) {
    return [...mediaJobs.values()]
      .filter((job) => job.userId === userId
        && (!mediaId || job.mediaId === mediaId)
        && (!stage || job.stage === stage))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => structuredClone(job));
  }

  /**
   * Takes a lease on runnable jobs.
   *
   * The lease is what makes a crashed worker survivable: it holds the job for `leaseMs`, and once
   * that expires any worker may pick it up again. Resumption reads the stage back off the evidence
   * already stored (a raw transcript means transcription is done), so nothing is redone.
   *
   * `review_required` is deliberately not runnable — it waits on a person, not a worker.
   */
  function claimMediaJobs({ owner, leaseMs = 60_000, limit = 4, now = nowIso() } = {}) {
    const nowMs = Date.parse(now);
    const claimed = [];
    let mutated = false;

    for (const job of [...mediaJobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (claimed.length >= limit) break;
      if (MEDIA_JOB_TERMINAL_STAGES.has(job.stage)) continue;
      if (job.stage === "review_required") continue;

      const leaseExpiresAtMs = Date.parse(job.leaseExpiresAt ?? "");
      if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs) continue;

      if (job.attempts >= job.maxAttempts) {
        // The budget is spent. Failing here rather than handing the job out again keeps an
        // exhausted job from being rediscovered on every single tick.
        job.stage = "failed";
        job.failureKind = "terminal";
        job.lastError = job.lastError ?? `Media job abandoned after ${job.attempts} attempts.`;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.timings = { ...job.timings, failedAt: nowIso() };
        job.updatedAt = nowIso();
        mutated = true;
        continue;
      }

      job.attempts += 1;
      job.leaseOwner = owner ?? null;
      job.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      job.stage = resumeStageFor(job);
      job.timings = { ...job.timings, startedAt: job.timings?.startedAt ?? nowIso() };
      job.updatedAt = nowIso();
      mutated = true;
      claimed.push(structuredClone(job));
    }

    if (mutated) notifyChanged();
    return claimed;
  }

  function updateMediaJob({ jobId, userId = null, ...input }) {
    const job = mediaJobs.get(jobId);
    if (!job) return null;
    if (userId !== null && job.userId !== userId) return null;

    // rawTranscript and normalizedTranscript are versions, not a field to overwrite: once the ASR
    // output is recorded it is the immutable record of what the provider actually heard. Only the
    // user-edited version stays writable.
    if (input.rawTranscript !== undefined && job.rawTranscript === null) {
      job.rawTranscript = normalizeRawTranscript(input.rawTranscript);
    }
    if (input.normalizedTranscript !== undefined && job.normalizedTranscript === null) {
      job.normalizedTranscript = normalizeTranscript(input.normalizedTranscript) ?? null;
    }
    if (input.userEditedTranscript !== undefined) {
      job.userEditedTranscript = normalizeTranscript(input.userEditedTranscript) ?? null;
    }

    for (const key of ["provider", "model", "language", "dispatchStatus", "dispatchError", "commandId"]) {
      if (input[key] !== undefined) job[key] = input[key] ?? null;
    }
    if (input.autoSend !== undefined) job.autoSend = input.autoSend === true;
    if (input.stage !== undefined && MEDIA_JOB_STAGE_SET.has(input.stage)) job.stage = input.stage;
    if (input.lastError !== undefined) job.lastError = input.lastError ?? null;
    if (input.failureKind !== undefined) {
      job.failureKind = ["retryable", "terminal"].includes(input.failureKind) ? input.failureKind : null;
    }
    if (input.timings !== undefined) job.timings = { ...job.timings, ...structuredClone(input.timings ?? {}) };
    if (input.releaseLease === true) {
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
    }
    job.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(job);
  }

  function createMacro(input) {
    const macro = {
      id: createId("macro"),
      userId: input.userId,
      label: input.label,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      intent: input.intent,
      disabled: input.disabled === true,
      disabledReason: input.disabled === true ? (input.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    macros.set(macro.id, macro);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "macro.created",
      targetId: macro.id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
        environmentId: macro.environmentId,
      },
    });
    notifyChanged();
    return publicMacro(macro);
  }

  function getMacroForUser(userId, macroId) {
    const macro = macros.get(macroId);
    if (!macro || macro.userId !== userId) return null;
    return macro;
  }

  function listMacros(userId) {
    return [...macros.values()]
      .filter((macro) => macro.userId === userId)
      .map(publicMacro);
  }

  function deleteMacro({ userId, macroId }) {
    const macro = macros.get(macroId);
    if (!macro || macro.userId !== userId) return null;
    macros.delete(macroId);
    audit({
      userId,
      actorType: "user",
      action: "macro.deleted",
      targetId: macro.id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
      },
    });
    notifyChanged();
    return publicMacro(macro);
  }

  function createCommand(input) {
    const command = {
      id: createId("cmd"),
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      environmentId: input.environmentId,
      threadId: input.threadId ?? null,
      intent: input.intent,
      normalized: input.normalized,
      status: input.status,
      risk: input.risk,
      result: input.result ?? null,
      metrics: normalizeCommandMetrics(input.metrics),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    commands.set(command.id, command);
    recordCommandEvent({
      userId: command.userId,
      commandId: command.id,
      deviceId: command.deviceId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      status: command.status,
      risk: command.risk,
      result: command.result,
      metrics: command.metrics,
    });
    audit({
      userId: input.userId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      action: `command.${input.status}`,
      targetId: command.id,
      metadata: { intentType: input.intent.type, risk: input.risk },
    });
    notifyChanged();
    return command;
  }

  function getCommandForUser(userId, commandId) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId) return null;
    return command;
  }

  function claimCommandApproval({ userId, commandId, leaseMs = 30_000 }) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId || command.status !== "approval_required") return null;
    const claimedAt = Date.parse(command.approvalClaimedAt ?? "");
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs) return null;
    command.approvalClaimedAt = nowIso();
    return command;
  }

  function updateCommand({ userId, commandId, status, normalized, result, risk, metrics }) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId) return null;
    const previousStatus = command.status;
    if (status !== undefined) command.status = status;
    if (normalized !== undefined) command.normalized = normalized;
    if (result !== undefined) command.result = result;
    if (risk !== undefined) command.risk = risk;
    if (metrics !== undefined) command.metrics = normalizeCommandMetrics(metrics);
    command.updatedAt = nowIso();
    recordCommandEvent({
      userId,
      commandId: command.id,
      deviceId: command.deviceId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId,
      status: command.status,
      previousStatus,
      risk: command.risk,
      result: command.result,
      metrics: command.metrics,
    });
    audit({
      userId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId,
      action: `command.${command.status}`,
      targetId: command.id,
      metadata: {
        intentType: command.intent.type,
        risk: command.risk,
        previousStatus,
      },
    });
    notifyChanged();
    return command;
  }

  function listCommands(userId) {
    return [...commands.values()].filter((command) => command.userId === userId);
  }

  function listCommandEvents({ userId, commandId }) {
    return [...commandEvents.values()]
      .filter((event) => event.userId === userId && (!commandId || event.commandId === commandId));
  }

  function recordCommandEvent(input) {
    const event = {
      id: createId("cmdevt"),
      userId: input.userId,
      commandId: input.commandId,
      deviceId: input.deviceId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      status: input.status,
      previousStatus: input.previousStatus ?? null,
      risk: input.risk,
      result: input.result ?? null,
      metrics: normalizeCommandMetrics(input.metrics),
      createdAt: nowIso(),
    };
    commandEvents.set(event.id, event);
    return event;
  }

  function audit(input) {
    auditLogs.push({
      id: createId("audit"),
      userId: input.userId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    });
  }

  function listAuditLogs(userId) {
    return auditLogs.filter((event) => event.userId === userId);
  }

  return {
    subscribe,
    exportState,
    ensureUser,
    getUserPrivacySettings,
    updateUserPrivacySettings,
    getUserSubscription,
    updateUserSubscription,
    getUserOnboarding,
    updateUserOnboarding,
    createUserToken,
    authenticateUserToken,
    createDevice,
    preprovisionDevice,
    claimDevice,
    revokeDevice,
    deleteDevice,
    rotateDeviceSecret,
    updateDeviceProfile,
    resetDeviceForTransfer,
    ensureUnclaimedDeviceClaimCode,
    authenticateDevice,
    recordDeviceHeartbeat,
    listDevices,
    getDeviceForUser,
    updateDeviceConfig,
    setDeviceVoiceAutoSend,
    upsertEnvironment,
    deleteEnvironment,
    updateEnvironmentHealth,
    updateEnvironmentCatalogue,
    getEnvironmentForUser,
    listEnvironments,
    createConnectSession,
    getConnectSession,
    claimConnectSession,
    completeConnectSession,
    createGatewayProfile,
    listGatewayProfiles,
    getGatewayProfileForUser,
    updateGatewayProfile,
    deleteGatewayProfile,
    getDeviceGatewaySelection,
    stageDeviceGatewaySwitch,
    reportDeviceGatewaySwitch,
    rollbackDeviceGatewaySwitch,
    createFirmwareRelease,
    deleteFirmwareRelease,
    listFirmwareReleases,
    getLatestFirmwareRelease,
    getFirmwareArtifact,
    createMediaUpload,
    getMediaForUser,
    createDeviceProfile,
    listUserDeviceProfiles,
    getUserDeviceProfile,
    updateDeviceProfileDefinition,
    deleteDeviceProfile,
    updateMediaTranscript,
    updateMediaDescription,
    updateMediaProcessing,
    listMediaUploads,
    listExpiredMediaUploads,
    deleteMediaUpload,
    createMediaJob,
    getMediaJobForUser,
    listMediaJobs,
    claimMediaJobs,
    updateMediaJob,
    createAction,
    getActionForUser,
    listActions,
    updateAction,
    deleteAction,
    recordActionRun,
    createMacroRun,
    getMacroRunForApproval,
    claimMacroRunForResume,
    updateMacroRun,
    getDeviceControls,
    updateDeviceControls,
    acknowledgeDeviceControls,
    getDeviceFirmwarePolicy,
    updateDeviceFirmwarePolicy,
    createMacro,
    getMacroForUser,
    listMacros,
    deleteMacro,
    createCommand,
    getCommandForUser,
    claimCommandApproval,
    updateCommand,
    listCommands,
    listCommandEvents,
    listAuditLogs,
  };
}

function createHumanCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  const raw = Buffer.from(createSecret(10), "base64url");
  for (let index = 0; index < 10; index += 1) {
    output += alphabet[raw[index] % alphabet.length];
    if (index === 4) output += "-";
  }
  return output;
}

function normalizeClaimCode(claimCode) {
  return String(claimCode).trim().toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function createDefaultDeviceConfig() {
  return {
    environmentId: null,
    threadId: null,
    gatewayAccessMode: "local",
    gatewayUrl: null,
    defaultPrompt: "Continue the current task, inspect progress, and run relevant tests.",
    shellCommand: "npm test",
    menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
  };
}

function createDefaultDeviceStatus() {
  return {
    lastHeartbeatAt: null,
    firmwareVersion: null,
    hardwareModel: null,
    ipAddress: null,
    wifiRssi: null,
    freeHeap: null,
    uptimeMs: null,
    batteryMv: null,
    batteryPercent: null,
    protocolVersion: 1,
    features: [],
    limits: {},
  };
}

function createDefaultFirmwarePolicy() {
  return {
    channel: "stable",
    updateMode: "manual",
    desiredVersion: null,
    lastUpdateStatus: null,
    lastUpdateAt: null,
    lastUpdateError: null,
    updateProgress: null,
    targetVersion: null,
  };
}

function createDefaultDeviceControls(device) {
  return {
    userId: device.userId,
    deviceId: device.id,
    revision: 1,
    explicit: false,
    items: [
      { id: "system_status", kind: "status", label: "Status" },
      { id: "system_stop", kind: "stop", label: "Stop run" },
    ],
    appliedRevision: null,
    appliedAt: null,
    lastAckStatus: null,
    lastAckError: null,
    updatedAt: device.createdAt ?? nowIso(),
  };
}

function normalizeDeviceStatus(input = {}, existing = null, heartbeatAt = nowIso()) {
  const base = {
    ...createDefaultDeviceStatus(),
    ...(existing ?? {}),
  };
  const next = {
    ...base,
    lastHeartbeatAt: heartbeatAt,
  };

  if (Object.hasOwn(input, "firmwareVersion")) next.firmwareVersion = normalizeNullableString(input.firmwareVersion);
  if (Object.hasOwn(input, "hardwareModel")) next.hardwareModel = normalizeNullableString(input.hardwareModel);
  if (Object.hasOwn(input, "ipAddress")) next.ipAddress = normalizeNullableString(input.ipAddress);
  if (Object.hasOwn(input, "wifiRssi")) next.wifiRssi = normalizeOptionalNumber(input.wifiRssi);
  if (Object.hasOwn(input, "freeHeap")) next.freeHeap = normalizeOptionalNumber(input.freeHeap);
  if (Object.hasOwn(input, "uptimeMs")) next.uptimeMs = normalizeOptionalNumber(input.uptimeMs);
  if (Object.hasOwn(input, "batteryMv")) next.batteryMv = normalizeOptionalNumber(input.batteryMv);
  if (Object.hasOwn(input, "batteryPercent")) next.batteryPercent = normalizeOptionalNumber(input.batteryPercent);
  if (Object.hasOwn(input, "protocolVersion")) {
    const protocolVersion = Number(input.protocolVersion);
    if (Number.isInteger(protocolVersion) && protocolVersion >= 1) next.protocolVersion = protocolVersion;
  }
  if (Object.hasOwn(input, "features")) {
    next.features = Array.isArray(input.features)
      ? [...new Set(input.features.filter((feature) => typeof feature === "string" && feature.trim()).map((feature) => feature.trim()))].slice(0, 32)
      : [];
  }
  if (Object.hasOwn(input, "limits")) {
    next.limits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits)
      ? Object.fromEntries(Object.entries(input.limits).filter(([, value]) => Number.isFinite(Number(value))))
      : {};
  }
  if (Object.hasOwn(input, "gateway") && input.gateway && typeof input.gateway === "object" && !Array.isArray(input.gateway)) {
    next.gateway = normalizeGatewayTelemetry(input.gateway);
  }

  return next;
}

function normalizeGatewayTelemetry(input) {
  const reportedStatus = input.switchStatus ?? input.state;
  const status = reportedStatus === "stable" ? "active"
    : reportedStatus === "pending" ? "probing"
      : ["active", "probing", "failed"].includes(reportedStatus) ? reportedStatus : "active";
  return {
    activeProfileId: normalizeNullableString(input.activeProfileId),
    activeUrl: normalizeNullableString(input.activeUrl),
    pendingProfileId: normalizeNullableString(input.pendingProfileId),
    pendingUrl: normalizeNullableString(input.pendingUrl),
    switchStatus: status,
    detail: normalizeNullableString(input.detail),
  };
}

function normalizeFirmwarePolicy(input = {}, existing = null) {
  const next = { ...createDefaultFirmwarePolicy(), ...(existing ?? {}) };
  if (Object.hasOwn(input, "channel") && ["stable", "beta"].includes(input.channel)) {
    next.channel = input.channel;
  }
  if (Object.hasOwn(input, "updateMode") && ["manual", "notify", "automatic"].includes(input.updateMode)) {
    next.updateMode = input.updateMode;
  }
  for (const key of ["desiredVersion", "lastUpdateStatus", "lastUpdateAt", "lastUpdateError", "targetVersion"]) {
    if (Object.hasOwn(input, key)) next[key] = normalizeNullableString(input[key]);
  }
  if (Object.hasOwn(input, "updateProgress")) {
    const progress = Number(input.updateProgress);
    next.updateProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  }
  return next;
}

function normalizeDeviceConfig(input = {}, existing = null) {
  const base = {
    ...createDefaultDeviceConfig(),
    ...(existing ?? {}),
  };
  const next = { ...base };

  if (Object.hasOwn(input, "environmentId")) {
    next.environmentId = normalizeNullableString(input.environmentId);
  }
  if (Object.hasOwn(input, "threadId")) {
    next.threadId = normalizeNullableString(input.threadId);
  }
  if (Object.hasOwn(input, "gatewayAccessMode") && ["local", "tailscale", "online"].includes(input.gatewayAccessMode)) {
    next.gatewayAccessMode = input.gatewayAccessMode;
  }
  if (Object.hasOwn(input, "gatewayUrl")) {
    next.gatewayUrl = normalizeNullableString(input.gatewayUrl)?.replace(/\/+$/u, "") ?? null;
  }
  if (Object.hasOwn(input, "defaultPrompt")) {
    const value = normalizeNullableString(input.defaultPrompt);
    next.defaultPrompt = value || createDefaultDeviceConfig().defaultPrompt;
  }
  if (Object.hasOwn(input, "shellCommand")) {
    const value = normalizeNullableString(input.shellCommand);
    next.shellCommand = value || createDefaultDeviceConfig().shellCommand;
  }
  if (Object.hasOwn(input, "menu")) {
    const allowed = new Set(["status", "prompt", "shell", "macro", "approve", "reject", "media", "stop", "thread", "reset"]);
    const menu = Array.isArray(input.menu)
      ? input.menu
        .map((item) => normalizeNullableString(item))
        .filter((item) => item && allowed.has(item))
      : [];
    // 8 matches kMaxMenuItems in the firmware. Anything beyond it is dropped here
    // silently, so this cap must not be tighter than what the hardware can render.
    next.menu = [...new Set(menu)].slice(0, 8);
    if (next.menu.length === 0) next.menu = createDefaultDeviceConfig().menu;
  }

  return next;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnvironmentHealth(input = {}, existing = null) {
  const base = {
    lastCheckedAt: null,
    lastReachableAt: null,
    lastError: null,
    failureReason: null,
    snapshot: null,
    compatibility: null,
    ...(existing ?? {}),
  };
  return {
    ...base,
    ...(Object.hasOwn(input, "lastCheckedAt") ? { lastCheckedAt: normalizeNullableString(input.lastCheckedAt) } : {}),
    ...(Object.hasOwn(input, "lastReachableAt") ? { lastReachableAt: normalizeNullableString(input.lastReachableAt) } : {}),
    ...(Object.hasOwn(input, "lastError") ? { lastError: normalizeNullableString(input.lastError) } : {}),
    ...(Object.hasOwn(input, "failureReason") ? { failureReason: normalizeEnvironmentFailureReason(input.failureReason) } : {}),
    ...(Object.hasOwn(input, "snapshot") ? { snapshot: input.snapshot ?? null } : {}),
    ...(Object.hasOwn(input, "compatibility") ? { compatibility: input.compatibility ?? null } : {}),
  };
}

function normalizeEnvironmentFailureReason(value) {
  return ENVIRONMENT_FAILURE_REASONS.includes(value) ? value : null;
}

function normalizeCommandMetrics(input = {}) {
  const metrics = input && typeof input === "object" ? input : {};
  return {
    acknowledgementDurationMs: normalizeOptionalNumber(metrics.acknowledgementDurationMs),
    dispatchDurationMs: normalizeOptionalNumber(metrics.dispatchDurationMs),
    completedAt: normalizeNullableString(metrics.completedAt),
    failureAt: normalizeNullableString(metrics.failureAt),
  };
}

function normalizePrivacySettings(input = {}, existing = DEFAULT_PRIVACY_SETTINGS) {
  const base = {
    ...DEFAULT_PRIVACY_SETTINGS,
    ...(existing ?? {}),
  };
  if (!input || typeof input !== "object") return base;
  const next = { ...base };
  if (Object.hasOwn(input, "mediaRetentionDays")) {
    const value = input.mediaRetentionDays;
    if (value === null) {
      next.mediaRetentionDays = null;
    } else {
      const days = Number(value);
      if (Number.isInteger(days) && days >= 1 && days <= 365) {
        next.mediaRetentionDays = days;
      }
    }
  }
  return next;
}

export function createMemoryStore(seed) {
  return createStore(seed);
}

function normalizeTranscript(value) {
  if (typeof value !== "string") return undefined;
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}

// The raw ASR version is kept verbatim — leading and trailing whitespace included — because the
// point of storing it is to be able to see exactly what the provider returned. Only the length is
// bounded, and only so one runaway response cannot bloat the row.
function normalizeRawTranscript(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 12000);
}

function normalizeAttemptLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MEDIA_JOB_MAX_ATTEMPTS;
  return Math.min(parsed, 10);
}

/**
 * Where a claimed job picks back up.
 *
 * Derived from what is already stored rather than from the stage it crashed in, so a worker that
 * died after writing the raw transcript does not pay for the ASR call twice.
 */
function resumeStageFor(job) {
  if (job.rawTranscript === null) return "transcribing";
  if (job.normalizedTranscript === null) return "normalizing";
  return "dispatching";
}

const MEDIA_PROCESSING_STATUSES = new Set(["pending", "processing", "ready", "failed", "unavailable"]);

function normalizeMediaProcessing(input = null, kind = "image", transcript = null, description = null) {
  const now = nowIso();
  if (kind === "image") {
    // Images carry vision state instead of transcription state.
    const status = MEDIA_PROCESSING_STATUSES.has(input?.visionStatus)
      ? input.visionStatus
      : (description ? "ready" : "pending");
    return {
      transcriptionStatus: "not_applicable",
      transcriptSource: null,
      visionStatus: status,
      descriptionSource: input?.descriptionSource ?? (description ? "upload" : null),
      lastError: input?.lastError ?? null,
      updatedAt: input?.updatedAt ?? now,
    };
  }
  if (kind !== "audio") {
    return {
      transcriptionStatus: "not_applicable",
      transcriptSource: null,
      lastError: null,
      updatedAt: input?.updatedAt ?? now,
    };
  }
  const allowed = MEDIA_PROCESSING_STATUSES;
  const status = allowed.has(input?.transcriptionStatus)
    ? input.transcriptionStatus
    : (transcript ? "ready" : "pending");
  return {
    transcriptionStatus: status,
    transcriptSource: input?.transcriptSource ?? (transcript ? "upload" : null),
    lastError: input?.lastError ?? null,
    updatedAt: input?.updatedAt ?? now,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    privacy: normalizePrivacySettings(user.privacy),
    onboarding: normalizeStoredOnboarding(user.onboarding),
    createdAt: user.createdAt,
  };
}

function publicDevice(device) {
  const { secretHash, claimCodeHash, pendingSecretHash, ...publicFields } = device;
  return {
    ...publicFields,
    gatewaySelection: normalizeGatewaySelection(device.gatewaySelection),
    config: normalizeDeviceConfig({}, device.config),
    status: normalizeDeviceStatus({}, device.status, device.status?.lastHeartbeatAt ?? null),
    firmwarePolicy: normalizeFirmwarePolicy({}, device.firmwarePolicy),
    presence: buildDevicePresence(device),
    actions: deviceActions(device),
    voiceAutoSend: normalizeVoiceAutoSend(device.voiceAutoSend),
    claimed: Boolean(device.claimedAt),
  };
}

/**
 * Whether this device may dispatch a finished voice transcript without a person looking at it.
 *
 * Always off until the owner says otherwise, and `enabledBy` records which owner that was — an
 * auto-sending microphone is a standing grant to act on whatever it happens to hear, so who issued
 * it has to survive in the record and not only in the audit log. Turning it off clears the grant
 * rather than keeping a stale name attached to a permission nobody holds any more.
 */
function normalizeVoiceAutoSend(input = null) {
  const enabled = input?.enabled === true;
  return {
    enabled,
    enabledBy: enabled ? normalizeNullableString(input?.enabledBy) : null,
    enabledAt: enabled ? normalizeNullableString(input?.enabledAt) : null,
  };
}

function publicFirmwareRelease(release) {
  if (!release) return null;
  const { artifactKey, artifactProvider, ...output } = release;
  return { ...output, channel: release.channel ?? "stable" };
}

function normalizeGatewaySelection(input = null) {
  return {
    revision: Number.isInteger(input?.revision) && input.revision >= 0 ? input.revision : 0,
    state: ["stable", "pending", "failed"].includes(input?.state) ? input.state : "stable",
    activeProfileId: input?.activeProfileId ?? null,
    pendingProfileId: input?.pendingProfileId ?? null,
    previousProfileId: input?.previousProfileId ?? null,
    requestedAt: input?.requestedAt ?? null,
    appliedAt: input?.appliedAt ?? null,
    lastError: input?.lastError ?? null,
  };
}

/**
 * Which owner operations this device can currently accept.
 *
 * Every store mutation below already refuses a revoked device, but a client has no way to know
 * that and had to re-derive it from `revokedAt` — so each new guard here silently produced another
 * control that looks live and returns 404. Declaring the answer keeps the UI honest without it
 * having to mirror rules it cannot see.
 */
function deviceActions(device) {
  const revoked = Boolean(device.revokedAt);
  return {
    // rotateDeviceSecret / resetDeviceForTransfer / updateDeviceConfig / updateDeviceProfile all
    // bail on device.revokedAt and return null, which the routes surface as 404.
    rotateSecret: !revoked,
    transferReset: !revoked,
    updateConfig: !revoked,
    updateProfile: !revoked,
    // revokeDevice does not check, so revoking twice succeeds while changing nothing. A no-op
    // dressed as a destructive action is worse than a refusal.
    revoke: !revoked,
    // The inverse of the rest: deleting is the one thing that only becomes available once the
    // credential is dead.
    delete: revoked,
  };
}

function buildDevicePresence(device, now = Date.now()) {
  const lastSeenAt = normalizeNullableString(device.lastSeenAt);
  const lastHeartbeatAt = normalizeNullableString(device.status?.lastHeartbeatAt);
  const latestActivityAt = latestIso(lastSeenAt, lastHeartbeatAt);
  const ageMs = latestActivityAt ? Math.max(0, now - Date.parse(latestActivityAt)) : null;
  const online = ageMs !== null && ageMs <= DEVICE_ONLINE_THRESHOLD_MS;
  return {
    state: online ? "online" : "offline",
    online,
    lastSeenAt,
    lastHeartbeatAt,
    latestActivityAt,
    ageMs,
    staleAfterMs: DEVICE_ONLINE_THRESHOLD_MS,
  };
}

function latestIso(...values) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latestTime) {
      latest = value;
      latestTime = parsed;
    }
  }
  return latest;
}

function publicUserToken(token) {
  const { tokenHash, ...publicFields } = token;
  return publicFields;
}

function publicMediaUpload(media) {
  const { storagePath, ...publicFields } = media;
  return {
    ...publicFields,
    processing: normalizeMediaProcessing(media.processing, media.kind, media.transcript),
    expiresAt: media.expiresAt ?? null,
  };
}

function publicMacro(macro) {
  return {
    id: macro.id,
    userId: macro.userId,
    label: macro.label,
    environmentId: macro.environmentId ?? null,
    threadId: macro.threadId ?? null,
    intent: macro.intent,
    disabled: macro.disabled === true,
    disabledReason: macro.disabled === true ? (macro.disabledReason ?? null) : null,
    createdAt: macro.createdAt,
    updatedAt: macro.updatedAt,
  };
}

function publicAction(action) {
  return {
    id: action.id,
    userId: action.userId,
    type: action.type,
    label: action.label,
    payload: structuredClone(action.payload ?? {}),
    targetMode: action.targetMode ?? "device-current",
    environmentId: action.environmentId ?? null,
    threadId: action.threadId ?? null,
    steps: structuredClone(action.steps ?? []),
    disabled: action.disabled === true,
    disabledReason: action.disabled === true ? (action.disabledReason ?? null) : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function publicDeviceControls(controls) {
  return {
    deviceId: controls.deviceId,
    revision: controls.revision,
    explicit: controls.explicit === true,
    items: structuredClone(controls.items ?? []),
    appliedRevision: controls.appliedRevision ?? null,
    appliedAt: controls.appliedAt ?? null,
    lastAckStatus: controls.lastAckStatus ?? null,
    lastAckError: controls.lastAckError ?? null,
    updatedAt: controls.updatedAt,
  };
}

function publicEnvironment(environment) {
  const { accessToken, accessTokenCiphertext, ...publicFields } = environment;
  return {
    ...publicFields,
    health: normalizeEnvironmentHealth(environment.health),
  };
}

function publicConnectSession(session) {
  const { codeHash, ...publicFields } = session;
  return { ...publicFields };
}

function environmentForGateway(environment, tokenBox) {
  const publicFields = publicEnvironment(environment);
  const accessToken = environment.accessTokenCiphertext
    ? tokenBox.open(environment.accessTokenCiphertext)
    : environment.accessToken;
  return {
    ...publicFields,
    accessToken,
  };
}
