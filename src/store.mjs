import { createHash, timingSafeEqual } from "node:crypto";

import { defaultSubscription, normalizeSubscription } from "./billing.mjs";
import { createId, createSecret, nowIso } from "./ids.mjs";
import { normalizeOnboarding, normalizeStoredOnboarding } from "./onboarding.mjs";
import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_PRIVACY_SETTINGS = {
  mediaRetentionDays: 30,
};
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

export function createStore(seed = {}, options = {}) {
  const t3TokenBox = createSecretBox(options.t3TokenEncryptionKey);
  const users = new Map((seed.users ?? []).map((user) => [user.id, user]));
  const apiTokens = new Map((seed.apiTokens ?? []).map((token) => [token.id, token]));
  const devices = new Map((seed.devices ?? []).map((device) => [device.id, device]));
  const environments = new Map((seed.environments ?? []).map((environment) => [environment.id, environment]));
  const firmwareReleases = new Map((seed.firmwareReleases ?? []).map((release) => [release.id, release]));
  const mediaUploads = new Map((seed.mediaUploads ?? []).map((media) => [media.id, media]));
  const macros = new Map((seed.macros ?? []).map((macro) => [macro.id, macro]));
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
      firmwareReleases: [...firmwareReleases.values()],
      mediaUploads: [...mediaUploads.values()],
      macros: [...macros.values()],
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

  function preprovisionDevice({ label, profile = "agent-controller" }) {
    const secret = createSecret();
    const claimCode = createHumanCode();
    const device = {
      id: createId("dev"),
      userId: null,
      label,
      profile,
      secretHash: hashSecret(secret),
      claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
      claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      claimedAt: null,
      revokedAt: null,
      lastSeenAt: null,
      status: createDefaultDeviceStatus(),
      config: createDefaultDeviceConfig(),
      createdAt: nowIso(),
    };
    devices.set(device.id, device);
    audit({
      userId: "system",
      actorType: "system",
      action: "device.preprovisioned",
      targetId: device.id,
      metadata: { label, profile },
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
    device.config = normalizeDeviceConfig(config, device.config);
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: "device.config_updated",
      targetId: device.id,
      metadata: {
        environmentId: device.config.environmentId,
        threadId: device.config.threadId,
        menu: device.config.menu,
      },
    });
    notifyChanged();
    return publicDevice(device);
  }

  function upsertEnvironment(input) {
    const user = ensureUser({ userId: input.userId });
    const existing = input.id ? environments.get(input.id) : null;
    if (input.id && (!existing || existing.userId !== user.id)) return null;
    const environment = {
      id: input.id ?? createId("env"),
      userId: user.id,
      label: input.label,
      baseUrl: input.baseUrl.replace(/\/+$/u, ""),
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

  function deleteEnvironment({ userId, environmentId }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    environments.delete(environmentId);
    for (const device of devices.values()) {
      if (device.userId !== userId || device.config?.environmentId !== environmentId) continue;
      device.config = normalizeDeviceConfig({ ...device.config, environmentId: null }, device.config);
    }
    audit({
      userId,
      actorType: "user",
      action: "environment.deleted",
      targetId: environment.id,
      metadata: { label: environment.label, baseUrl: environment.baseUrl },
    });
    notifyChanged();
    return publicEnvironment(environment);
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
    return [...environments.values()]
      .filter((environment) => environment.userId === userId)
      .map(publicEnvironment);
  }

  function createFirmwareRelease(input) {
    const release = {
      id: createId("fw"),
      version: input.version,
      hardwareModel: input.hardwareModel,
      url: input.url,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      mandatory: input.mandatory,
      releaseNotes: input.releaseNotes ?? "",
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
        hardwareModel: release.hardwareModel,
        mandatory: release.mandatory,
      },
    });
    notifyChanged();
    return release;
  }

  function listFirmwareReleases({ hardwareModel } = {}) {
    return [...firmwareReleases.values()]
      .filter((release) => !hardwareModel || release.hardwareModel === hardwareModel)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function getLatestFirmwareRelease({ hardwareModel }) {
    return listFirmwareReleases({ hardwareModel }).at(-1) ?? null;
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

  function createMacro(input) {
    const macro = {
      id: createId("macro"),
      userId: input.userId,
      label: input.label,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      intent: input.intent,
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
    rotateDeviceSecret,
    updateDeviceProfile,
    resetDeviceForTransfer,
    ensureUnclaimedDeviceClaimCode,
    authenticateDevice,
    recordDeviceHeartbeat,
    listDevices,
    getDeviceForUser,
    updateDeviceConfig,
    upsertEnvironment,
    deleteEnvironment,
    updateEnvironmentHealth,
    updateEnvironmentCatalogue,
    getEnvironmentForUser,
    listEnvironments,
    createFirmwareRelease,
    listFirmwareReleases,
    getLatestFirmwareRelease,
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
    createMacro,
    getMacroForUser,
    listMacros,
    deleteMacro,
    createCommand,
    getCommandForUser,
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
    snapshot: null,
    ...(existing ?? {}),
  };
  return {
    ...base,
    ...(Object.hasOwn(input, "lastCheckedAt") ? { lastCheckedAt: normalizeNullableString(input.lastCheckedAt) } : {}),
    ...(Object.hasOwn(input, "lastReachableAt") ? { lastReachableAt: normalizeNullableString(input.lastReachableAt) } : {}),
    ...(Object.hasOwn(input, "lastError") ? { lastError: normalizeNullableString(input.lastError) } : {}),
    ...(Object.hasOwn(input, "snapshot") ? { snapshot: input.snapshot ?? null } : {}),
  };
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
    config: normalizeDeviceConfig({}, device.config),
    status: normalizeDeviceStatus({}, device.status, device.status?.lastHeartbeatAt ?? null),
    presence: buildDevicePresence(device),
    actions: deviceActions(device),
    claimed: Boolean(device.claimedAt),
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
    createdAt: macro.createdAt,
    updatedAt: macro.updatedAt,
  };
}

function publicEnvironment(environment) {
  const { accessToken, accessTokenCiphertext, ...publicFields } = environment;
  return {
    ...publicFields,
    health: normalizeEnvironmentHealth(environment.health),
  };
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
