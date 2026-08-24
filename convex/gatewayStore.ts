import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { providerCatalogueValidator } from "./schema";

const defaultConfig = {
  gatewayAccessMode: "local",
  gatewayUrl: null,
  defaultPrompt: "Continue the current task, inspect progress, and run relevant tests.",
  shellCommand: "npm test",
  menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
};

const defaultStatus = {
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
const defaultFirmwarePolicy = {
  channel: "stable",
  updateMode: "manual",
  desiredVersion: null,
  lastUpdateStatus: null,
  lastUpdateAt: null,
  lastUpdateError: null,
  updateProgress: null,
  targetVersion: null,
};
const deviceOnlineThresholdMs = 90_000;
// Mirrors ENVIRONMENT_REMOVED_REASON in src/actions.mjs. Convex functions cannot import from src/,
// so the literal is duplicated here; change both together.
const ENVIRONMENT_REMOVED_REASON = "environment_removed";

const defaultEnvironmentHealth = {
  lastCheckedAt: null,
  lastReachableAt: null,
  lastError: null,
  failureReason: null,
  snapshot: null,
  compatibility: null,
};

// Mirrors ENVIRONMENT_FAILURE_REASONS in src/environmentFailure.mjs.
const environmentFailureReasons = new Set([
  "process_not_running",
  "network_unreachable",
  "timeout",
  "tls_error",
  "token_expired",
  "authentication_failed",
  "contract_incompatible",
  "unknown",
]);

const defaultPrivacySettings = {
  mediaRetentionDays: 30,
};

const subscriptionTiers = new Set(["free", "starter", "pro", "team", "enterprise"]);
const subscriptionStatuses = new Set(["active", "trialing", "past_due", "canceled"]);

const defaultSubscriptionTier = "free";
const defaultSubscriptionStatus = "active";

const defaultOnboarding = {
  version: 2,
  status: "not_started",
  currentStep: "welcome",
  networkMode: null,
  networkUrl: null,
  provider: { harness: null, instanceId: null, model: null },
  workspace: { path: null, title: null, projectId: null },
  environmentId: null,
  firstThreadId: null,
  device: { mode: null, deviceId: null, credentialConfirmed: false },
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  updatedAt: null,
};

function gatewayQuery(definition: any) {
  return query({
    ...definition,
    args: { gatewaySecret: v.string(), ...definition.args },
    handler: async (ctx, args) => {
      requireGatewaySecret((args as { gatewaySecret: string }).gatewaySecret);
      return await definition.handler(ctx, args);
    },
  });
}

function gatewayMutation(definition: any) {
  return mutation({
    ...definition,
    args: { gatewaySecret: v.string(), ...definition.args },
    handler: async (ctx, args) => {
      requireGatewaySecret((args as { gatewaySecret: string }).gatewaySecret);
      return await definition.handler(ctx, args);
    },
  });
}

function requireGatewaySecret(value: string) {
  const expected = process.env.GATEWAY_CONVEX_SECRET;
  if (!expected || value !== expected) {
    throw new Error("Unauthorized gateway store access");
  }
}

export const ensureUser = gatewayMutation({
  args: {
    userId: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return publicUser(await ensureUserRecord(
      ctx,
      args.userId ?? "user_dev",
      args.email ?? "dev@example.local",
      args.name,
    ));
  },
});

export const createUserToken = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.optional(v.string()),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const id = await ctx.db.insert("apiTokens", {
      userExternalId: args.userId,
      label: args.label ?? "Platform API token",
      tokenHash: args.tokenHash,
      createdAt: nowIso(),
    });
    const token = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user_token.created",
      targetId: id,
      metadata: { label: args.label ?? "Platform API token" },
    });
    return publicUserToken(token);
  },
});

export const authenticateUserToken = gatewayMutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("byTokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!token || token.revokedAt) return null;
    await ctx.db.patch(token._id, { lastUsedAt: nowIso() });
    const user = await findUser(ctx, token.userExternalId);
    return user ? publicUser(user) : null;
  },
});

export const getUserPrivacySettings = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    return normalizePrivacySettings(user?.privacy);
  },
});

export const updateUserPrivacySettings = gatewayMutation({
  args: {
    userId: v.string(),
    privacy: v.object({
      mediaRetentionDays: v.union(v.number(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const user = await ensureUserRecord(ctx, args.userId);
    const privacy = normalizePrivacySettings(args.privacy, user?.privacy);
    await ctx.db.patch(user._id, { privacy, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user.privacy_updated",
      targetId: args.userId,
      metadata: privacy,
    });
    return privacy;
  },
});

export const getUserSubscription = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    if (!user) return null;
    return normalizeSubscription(user.subscription, user.createdAt);
  },
});

export const updateUserSubscription = gatewayMutation({
  args: {
    userId: v.string(),
    tier: v.optional(v.string()),
    status: v.optional(v.string()),
    provider: v.optional(v.union(v.string(), v.null())),
    externalId: v.optional(v.union(v.string(), v.null())),
    currentPeriodEnd: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    if (!user) return null;
    const previous = normalizeSubscription(user.subscription, user.createdAt);
    const subscription = { ...previous, updatedAt: nowIso() };

    if (args.tier !== undefined) subscription.tier = requireSubscriptionTier(args.tier);
    if (args.status !== undefined) subscription.status = requireSubscriptionStatus(args.status);
    if (args.provider !== undefined) subscription.provider = normalizeNullableString(args.provider);
    if (args.externalId !== undefined) subscription.externalId = normalizeNullableString(args.externalId);
    if (args.currentPeriodEnd !== undefined) {
      subscription.currentPeriodEnd = normalizeNullableString(args.currentPeriodEnd);
    }

    await ctx.db.patch(user._id, { subscription, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user.subscription_updated",
      targetId: args.userId,
      metadata: subscription,
    });
    return subscription;
  },
});

export const getUserOnboarding = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    return normalizeOnboarding(user?.onboarding);
  },
});

export const updateUserOnboarding = gatewayMutation({
  args: {
    userId: v.string(),
    onboarding: v.any(),
  },
  handler: async (ctx, args) => {
    const user = await ensureUserRecord(ctx, args.userId);
    const previous = normalizeOnboarding(user?.onboarding);
    const onboarding = normalizeOnboardingInput(args.onboarding, previous);
    await ctx.db.patch(user._id, { onboarding, updatedAt: nowIso() });
    const action = onboarding.status === "completed"
      ? "user.onboarding_completed"
      : onboarding.status === "paused"
        ? "user.onboarding_paused"
        : previous.status === "not_started"
          ? "user.onboarding_started"
          : "user.onboarding_updated";
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action,
      targetId: args.userId,
      metadata: {
        status: onboarding.status,
        currentStep: onboarding.currentStep,
      },
    });
    return onboarding;
  },
});

export const createDevice = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    profile: v.optional(v.string()),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const id = await ctx.db.insert("devices", {
      userExternalId: args.userId,
      label: args.label,
      profile: args.profile ?? "agent-controller",
      secretHash: args.secretHash,
      claimedAt: nowIso(),
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const device = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.created",
      targetId: id,
      metadata: { label: args.label, profile: args.profile ?? "agent-controller" },
    });
    return publicDevice(device);
  },
});

export const preprovisionDevice = gatewayMutation({
  args: {
    label: v.string(),
    profile: v.optional(v.string()),
    secretHash: v.string(),
    claimCodeHash: v.string(),
    claimCodeExpiresAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("devices", {
      label: args.label,
      profile: args.profile ?? "agent-controller",
      secretHash: args.secretHash,
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: args.claimCodeExpiresAt,
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const device = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "device.preprovisioned",
      targetId: id,
      metadata: { label: args.label, profile: args.profile ?? "agent-controller" },
    });
    return publicDevice(device);
  },
});

export const claimDevice = gatewayMutation({
  args: {
    userId: v.string(),
    claimCodeHash: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const device = await ctx.db
      .query("devices")
      .withIndex("byClaimCodeHash", (q) => q.eq("claimCodeHash", args.claimCodeHash))
      .first();
    if (!device || device.revokedAt || device.claimedAt || !device.claimCodeHash) return null;
    // Matched but expired is refused here rather than treated as "no such code", so the caller can
    // report the difference. A code with no recorded expiry predates expiry tracking and stays live.
    if (device.claimCodeExpiresAt && Date.parse(device.claimCodeExpiresAt) <= Date.now()) return null;
    await ctx.db.patch(device._id, {
      userExternalId: args.userId,
      claimCodeHash: undefined,
      claimCodeExpiresAt: undefined,
      claimedAt: nowIso(),
      ...(args.label ? { label: args.label } : {}),
      updatedAt: nowIso(),
    });
    const claimed = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.claimed",
      targetId: device._id,
      metadata: { label: claimed?.label, profile: claimed?.profile },
    });
    return publicDevice(claimed);
  },
});

export const revokeDevice = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    await ctx.db.patch(device._id, { revokedAt: nowIso(), updatedAt: nowIso() });
    const revoked = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.revoked",
      targetId: device._id,
      metadata: { label: device.label },
    });
    return publicDevice(revoked);
  },
});

/**
 * Permanently removes a device record. Only a revoked device qualifies — see deleteDevice() in
 * src/store.mjs, which is the reference implementation. Commands and audit entries reference the
 * device by id and are intentionally left in place.
 */
export const deleteDevice = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    if (!device.revokedAt) return { device: null, reason: "not_revoked" };
    const removed = publicDevice(device);
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", device._id))
      .first();
    if (controls) await ctx.db.delete(controls._id);
    await ctx.db.delete(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.deleted",
      targetId: device._id,
      metadata: { label: device.label, profile: device.profile, revokedAt: device.revokedAt },
    });
    return { device: removed, reason: null };
  },
});

export const rotateDeviceSecret = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    await ctx.db.patch(device._id, { secretHash: args.secretHash, updatedAt: nowIso() });
    const rotated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.secret_rotated",
      targetId: device._id,
      metadata: { label: device.label },
    });
    return publicDevice(rotated);
  },
});

export const updateDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    profile: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    await ctx.db.patch(device._id, { profile: args.profile, updatedAt: nowIso() });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.profile_updated",
      targetId: device._id,
      metadata: {
        label: device.label,
        previousProfile: device.profile,
        profile: args.profile,
      },
    });
    return publicDevice(updated);
  },
});

export const resetDeviceForTransfer = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    label: v.optional(v.string()),
    secretHash: v.string(),
    claimCodeHash: v.string(),
    claimCodeExpiresAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    await ctx.db.patch(device._id, {
      userExternalId: undefined,
      ...(args.label ? { label: args.label } : {}),
      secretHash: args.secretHash,
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: args.claimCodeExpiresAt,
      claimedAt: undefined,
      lastSeenAt: undefined,
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      updatedAt: nowIso(),
    });
    const reset = await ctx.db.get(device._id);
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", device._id))
      .first();
    if (controls) await ctx.db.delete(controls._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.transfer_reset",
      targetId: device._id,
      metadata: {
        previousLabel: device.label,
        label: reset?.label,
        profile: device.profile,
      },
    });
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "device.claim_code_rotated",
      targetId: device._id,
      metadata: { label: reset?.label, profile: device.profile },
    });
    return publicDevice(reset);
  },
});

// The candidate hash is only written when a new code is actually needed. When the existing code is
// still live the caller's plaintext is discarded unused, which is what stops a device's first-403
// setup-code request from invalidating the label printed at manufacture.
export const ensureUnclaimedDeviceClaimCode = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    rotate: v.optional(v.boolean()),
    claimCodeHash: v.string(),
    claimCodeExpiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt || device.claimedAt) return null;
    const live = Boolean(device.claimCodeHash)
      && (!device.claimCodeExpiresAt || Date.parse(device.claimCodeExpiresAt) > Date.now());
    if (!args.rotate && live) {
      return { device: publicDevice(device), rotated: false };
    }
    await ctx.db.patch(device._id, {
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: args.claimCodeExpiresAt,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "device",
      actorId: device._id,
      action: "device.setup_code_rotated",
      targetId: device._id,
      metadata: { label: device.label, profile: device.profile, rotate: args.rotate === true },
    });
    return { device: publicDevice(updated), rotated: true };
  },
});

export const authenticateDevice = gatewayMutation({
  args: {
    // Device credentials arrive before trust is established. Treat a malformed
    // external id as an authentication miss rather than allowing Convex's id
    // validator to turn attacker-controlled input into an HTTP 500.
    deviceId: v.string(),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    const deviceId = ctx.db.normalizeId("devices", args.deviceId);
    if (!deviceId) return null;
    const device = await ctx.db.get(deviceId);
    if (!device || device.revokedAt || device.secretHash !== args.secretHash) return null;
    await ctx.db.patch(device._id, { lastSeenAt: nowIso(), updatedAt: nowIso() });
    return publicDevice(await ctx.db.get(device._id));
  },
});

export const recordDeviceHeartbeat = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    status: v.any(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt) return null;
    const heartbeatAt = nowIso();
    await ctx.db.patch(device._id, {
      lastSeenAt: heartbeatAt,
      status: normalizeDeviceStatus(args.status, device.status, heartbeatAt),
      updatedAt: heartbeatAt,
    });
    return publicDevice(await ctx.db.get(device._id));
  },
});

export const listDevices = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const devices = await ctx.db
      .query("devices")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return devices.map(publicDevice);
  },
});

export const getDeviceForUser = gatewayQuery({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    return publicDevice(await getDeviceForOwner(ctx, args.userId, args.deviceId));
  },
});

export const updateDeviceConfig = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    config: v.any(),
    // A device setting its own thread passes "device", so the audit trail does not
    // credit the owner with something the hardware did on its own.
    actorType: v.optional(v.string()),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const config = normalizeDeviceConfig(args.config, device.config);
    const label = Object.hasOwn(args.config, "label")
      ? normalizeNullableString(args.config.label) ?? device.label
      : device.label;
    await ctx.db.patch(device._id, { label, config, updatedAt: nowIso() });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: "device.config_updated",
      targetId: device._id,
      metadata: {
        label,
        previousLabel: device.label,
        environmentId: config.environmentId ?? null,
        threadId: config.threadId ?? null,
        gatewayAccessMode: config.gatewayAccessMode ?? "local",
        gatewayUrl: config.gatewayUrl ?? null,
        menu: config.menu,
      },
    });
    return publicDevice(updated);
  },
});

export const createGatewayProfile = gatewayMutation({
  args: { userId: v.string(), label: v.string(), mode: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const createdAt = nowIso();
    const id = await ctx.db.insert("gatewayProfiles", { userExternalId: args.userId, label: args.label,
      mode: args.mode, url: args.url, createdAt, updatedAt: createdAt });
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.created",
      targetId: id, metadata: { label: args.label, mode: args.mode, origin: args.url } });
    return publicGatewayProfile(await ctx.db.get(id));
  },
});

export const listGatewayProfiles = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => (await ctx.db.query("gatewayProfiles").withIndex("byUserExternalId",
    (q) => q.eq("userExternalId", args.userId)).collect()).map(publicGatewayProfile)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
});

export const getGatewayProfileForUser = gatewayQuery({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles") },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    return profile?.userExternalId === args.userId ? publicGatewayProfile(profile) : null;
  },
});

export const updateGatewayProfile = gatewayMutation({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles"), label: v.string(), mode: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const assigned = (await ctx.db.query("devices").withIndex("byUserExternalId",
      (q) => q.eq("userExternalId", args.userId)).collect()).filter((device) =>
      [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(String(profile._id)));
    if (assigned.length && (profile.url !== args.url || profile.mode !== args.mode)) {
      return { conflict: true, deviceIds: assigned.map((device) => String(device._id)) };
    }
    await ctx.db.patch(profile._id, { label: args.label, mode: args.mode, url: args.url, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.updated",
      targetId: profile._id, metadata: { label: args.label, mode: args.mode, origin: args.url } });
    return { ...publicGatewayProfile(await ctx.db.get(profile._id)), conflict: false };
  },
});

export const deleteGatewayProfile = gatewayMutation({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles") },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const assigned = (await ctx.db.query("devices").withIndex("byUserExternalId",
      (q) => q.eq("userExternalId", args.userId)).collect()).filter((device) =>
      [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(String(profile._id)));
    if (assigned.length) return { conflict: true, deviceIds: assigned.map((device) => String(device._id)) };
    await ctx.db.delete(profile._id);
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.deleted",
      targetId: profile._id, metadata: { label: profile.label, mode: profile.mode } });
    return { conflict: false, profile: publicGatewayProfile(profile) };
  },
});

export const getDeviceGatewaySelection = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    return device ? normalizeGatewaySelection(device.gatewaySelection) : null;
  },
});

export const stageDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), profileId: v.id("gatewayProfiles"),
    actorType: v.optional(v.string()), actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    const profile = await ctx.db.get(args.profileId);
    if (!device || device.revokedAt || !profile || profile.userExternalId !== args.userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    const selection = { ...previous, revision: previous.revision + 1, state: "pending",
      previousProfileId: previous.activeProfileId, pendingProfileId: String(profile._id), requestedAt: nowIso(), lastError: null };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: args.actorType ?? "user", actorId: args.actorId,
      action: "device.gateway_switch_requested", targetId: device._id,
      metadata: { revision: selection.revision, profileId: String(profile._id) } });
    return selection;
  },
});

export const reportDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), revision: v.number(),
    profileId: v.id("gatewayProfiles"), status: v.string(), detail: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    const profile = await ctx.db.get(args.profileId);
    if (!device || device.revokedAt || !profile || profile.userExternalId !== args.userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    if (args.revision !== previous.revision) return { conflict: true, selection: previous };
    if (args.status === "requested") {
      const selection = { ...previous, revision: previous.revision + 1, state: "pending",
        previousProfileId: previous.activeProfileId, pendingProfileId: String(profile._id), requestedAt: nowIso(), lastError: null };
      await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
      return { conflict: false, selection };
    }
    if (previous.pendingProfileId && previous.pendingProfileId !== String(profile._id)) {
      return { conflict: true, selection: previous };
    }
    const selection = args.status === "applied"
      ? { ...previous, revision: previous.pendingProfileId ? previous.revision : previous.revision + 1,
          state: "stable", previousProfileId: previous.activeProfileId, activeProfileId: String(profile._id),
          pendingProfileId: null, appliedAt: nowIso(), lastError: null }
      : { ...previous, state: "failed", pendingProfileId: null, lastError: args.detail ?? "Gateway probe failed." };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: "device", actorId: String(device._id),
      action: args.status === "applied" ? "device.gateway_switch_applied" : "device.gateway_switch_failed",
      targetId: device._id, metadata: { revision: selection.revision, profileId: String(profile._id), detail: args.detail } });
    return { conflict: false, selection };
  },
});

export const rollbackDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    const selection = { ...previous, revision: previous.revision + 1, state: "stable", pendingProfileId: null, lastError: null };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    return selection;
  },
});

export const upsertEnvironment = gatewayMutation({
  args: {
    id: v.optional(v.id("environments")),
    userId: v.string(),
    label: v.string(),
    baseUrl: v.string(),
    accessToken: v.string(),
    accessTokenExpiresAt: v.optional(v.union(v.string(), v.null())),
    scopes: v.array(v.string()),
    status: v.optional(v.string()),
    health: v.optional(v.any()),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    let existing: any = null;
    if (args.id) {
      existing = await ctx.db.get(args.id);
      if (!existing || existing.userExternalId !== args.userId) return null;
    } else {
      const normalizedBaseUrl = args.baseUrl.replace(/\/+$/u, "");
      const matches = (await ctx.db
        .query("environments")
        .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
        .collect())
        .filter((environment) => environment.baseUrl === normalizedBaseUrl)
        .sort((left, right) => left._creationTime - right._creationTime);
      existing = matches[0] ?? null;
    }
    const input = {
      userExternalId: args.userId,
      label: args.label,
      baseUrl: args.baseUrl.replace(/\/+$/u, ""),
      accessToken: args.accessToken,
      accessTokenExpiresAt: normalizeNullableString(args.accessTokenExpiresAt) ?? null,
      scopes: args.scopes,
      status: args.status ?? "unknown",
      health: normalizeEnvironmentHealth(args.health, existing?.health),
      updatedAt: nowIso(),
    };
    const id = existing?._id ?? await ctx.db.insert("environments", {
      ...input,
      createdAt: args.createdAt ?? nowIso(),
    });
    if (existing) await ctx.db.patch(existing._id, input);
    const environment = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.upserted",
      targetId: id,
      metadata: { label: input.label, baseUrl: input.baseUrl, scopes: input.scopes },
    });
    return publicEnvironment(environment);
  },
});

export const deleteEnvironment = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
  },
  // Mirror of deleteEnvironment in src/store.mjs: nothing may keep pointing at a removed
  // environment, and a fixed-target action or macro left without one is disabled with a reason
  // rather than silently retargeted. The two copies must stay in step.
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    const environmentId = String(environment._id);
    await ctx.db.delete(environment._id);
    const removed: {
      devices: string[];
      actions: string[];
      macros: string[];
      onboarding: boolean;
    } = { devices: [], actions: [], macros: [], onboarding: false };
    const timestamp = nowIso();

    const devices = await ctx.db
      .query("devices")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    for (const device of devices) {
      if (device.config?.environmentId !== environmentId) continue;
      await ctx.db.patch(device._id, {
        config: normalizeDeviceConfig({ ...device.config, environmentId: null }, device.config),
        updatedAt: timestamp,
      });
      removed.devices.push(String(device._id));
    }

    const actions = await ctx.db
      .query("actions")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    for (const action of actions) {
      if (String(action.environmentId ?? "") !== environmentId) continue;
      await ctx.db.patch(action._id, {
        environmentId: undefined,
        threadId: undefined,
        targetMode: "device-current",
        disabled: true,
        disabledReason: ENVIRONMENT_REMOVED_REASON,
        updatedAt: timestamp,
      });
      removed.actions.push(String(action._id));
    }

    const macros = await ctx.db
      .query("macros")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    for (const macro of macros) {
      if (String(macro.environmentId ?? "") !== environmentId) continue;
      await ctx.db.patch(macro._id, {
        environmentId: undefined,
        threadId: undefined,
        disabled: true,
        disabledReason: ENVIRONMENT_REMOVED_REASON,
        updatedAt: timestamp,
      });
      removed.macros.push(String(macro._id));
    }

    const user = await findUser(ctx, args.userId);
    const onboarding = normalizeOnboarding(user?.onboarding);
    if (user && onboarding.environmentId === environmentId) {
      await ctx.db.patch(user._id, {
        onboarding: { ...onboarding, environmentId: null, firstThreadId: null, updatedAt: timestamp },
        updatedAt: timestamp,
      });
      removed.onboarding = true;
    }

    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.deleted",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        baseUrl: environment.baseUrl,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    return { environment: publicEnvironment(environment), removed };
  },
});

export const updateEnvironmentHealth = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    status: v.optional(v.string()),
    health: v.any(),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    const health = normalizeEnvironmentHealth(args.health, environment.health);
    await ctx.db.patch(environment._id, {
      ...(args.status ? { status: args.status } : {}),
      health,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(environment._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.health_checked",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        status: updated?.status,
        lastError: health.lastError,
      },
    });
    return publicEnvironment(updated);
  },
});

export const updateEnvironmentCatalogue = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    catalogue: providerCatalogueValidator,
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    const catalogue = args.catalogue;
    await ctx.db.patch(environment._id, {
      providerCatalogue: catalogue,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(environment._id);
    const instanceIds = catalogue.instances.map((instance: any) => instance.instanceId);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.catalogue_updated",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        source: catalogue.source,
        instanceCount: instanceIds.length,
        instanceIds,
      },
    });
    return publicEnvironment(updated);
  },
});

export const getEnvironmentForUser = gatewayQuery({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    return environmentForGateway(environment);
  },
});

export const listEnvironments = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const environments = await ctx.db
      .query("environments")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    const uniqueByUrl = new Map<string, any>();
    for (const environment of environments.sort((left, right) => left._creationTime - right._creationTime)) {
      if (!uniqueByUrl.has(environment.baseUrl)) uniqueByUrl.set(environment.baseUrl, environment);
    }
    return [...uniqueByUrl.values()].map(publicEnvironment);
  },
});

export const createFirmwareRelease = gatewayMutation({
  args: {
    version: v.string(),
    channel: v.optional(v.string()),
    hardwareModel: v.string(),
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    mandatory: v.boolean(),
    releaseNotes: v.optional(v.string()),
    artifactKey: v.optional(v.string()),
    artifactProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("firmwareReleases", {
      version: args.version,
      channel: args.channel ?? "stable",
      hardwareModel: args.hardwareModel,
      url: args.url,
      sha256: args.sha256,
      sizeBytes: args.sizeBytes,
      mandatory: args.mandatory,
      releaseNotes: args.releaseNotes ?? "",
      ...(args.artifactKey ? { artifactKey: args.artifactKey } : {}),
      ...(args.artifactProvider ? { artifactProvider: args.artifactProvider } : {}),
      createdAt: nowIso(),
    });
    const release = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "firmware.release_created",
      targetId: id,
      metadata: {
        version: args.version,
        channel: args.channel ?? "stable",
        hardwareModel: args.hardwareModel,
        mandatory: args.mandatory,
      },
    });
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey ?? null,
      artifactProvider: release.artifactProvider ?? null };
  },
});

export const deleteFirmwareRelease = gatewayMutation({
  args: { releaseId: v.string() },
  handler: async (ctx, args) => {
    const releaseId = ctx.db.normalizeId("firmwareReleases", args.releaseId);
    if (!releaseId) return null;
    const release = await ctx.db.get(releaseId);
    if (!release) return null;
    await ctx.db.delete(releaseId);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "firmware.release_deleted",
      targetId: releaseId,
      metadata: {
        version: release.version,
        channel: release.channel ?? "stable",
        hardwareModel: release.hardwareModel,
      },
    });
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey ?? null,
      artifactProvider: release.artifactProvider ?? null };
  },
});

export const listFirmwareReleases = gatewayQuery({
  args: {
    hardwareModel: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const releases = args.hardwareModel
      ? await ctx.db
        .query("firmwareReleases")
        .withIndex("byHardwareModel", (q) => q.eq("hardwareModel", args.hardwareModel!))
        .collect()
      : await ctx.db.query("firmwareReleases").collect();
    return releases
      .filter((release) => !args.channel || (release.channel ?? "stable") === args.channel)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicFirmwareRelease);
  },
});

export const getLatestFirmwareRelease = gatewayQuery({
  args: {
    hardwareModel: v.string(),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const releases = await ctx.db
      .query("firmwareReleases")
      .withIndex("byHardwareModel", (q) => q.eq("hardwareModel", args.hardwareModel))
      .collect();
    return publicFirmwareRelease(releases
      .filter((release) => !args.channel || (release.channel ?? "stable") === args.channel)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1));
  },
});

export const getFirmwareArtifact = gatewayQuery({
  args: { sha256: v.string(), hardwareModel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const releases = await ctx.db.query("firmwareReleases").collect();
    const release = releases.find((candidate) => candidate.sha256 === args.sha256 && candidate.artifactKey
      && (!args.hardwareModel || candidate.hardwareModel === args.hardwareModel));
    if (!release) return null;
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey,
      artifactProvider: release.artifactProvider ?? "disk" };
  },
});

export const createMediaUpload = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    kind: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    storagePath: v.string(),
    originalName: v.optional(v.string()),
    transcript: v.optional(v.string()),
    expiresAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const transcript = args.kind === "audio" ? normalizeTranscript(args.transcript) ?? null : null;
    const id = await ctx.db.insert("mediaUploads", {
      userExternalId: args.userId,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      kind: args.kind,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      sha256: args.sha256,
      storagePath: args.storagePath,
      ...(args.originalName ? { originalName: args.originalName } : {}),
      transcript,
      processing: normalizeMediaProcessing(null, args.kind, transcript),
      expiresAt: args.expiresAt ?? null,
      createdAt: nowIso(),
    });
    const media = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      action: "media.uploaded",
      targetId: id,
      metadata: {
        kind: args.kind,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        sha256: args.sha256,
        transcriptLength: transcript?.length ?? 0,
        transcriptionStatus: normalizeMediaProcessing(null, args.kind, transcript).transcriptionStatus,
        expiresAt: args.expiresAt ?? null,
      },
    });
    return publicMediaUpload(media);
  },
});

export const updateMediaTranscript = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    transcript: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId || media.kind !== "audio") return null;
    const transcript = normalizeTranscript(args.transcript) ?? null;
    await ctx.db.patch(media._id, {
      transcript,
      processing: normalizeMediaProcessing({
        transcriptionStatus: transcript ? "ready" : "pending",
        transcriptSource: args.source ?? "manual",
        lastError: null,
      }, media.kind, transcript),
    });
    const updated = await ctx.db.get(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media.transcript_updated",
      targetId: media._id,
      metadata: {
        previousLength: media.transcript?.length ?? 0,
        transcriptLength: transcript?.length ?? 0,
      },
    });
    return publicMediaUpload(updated);
  },
});

export const updateMediaProcessing = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    processing: v.any(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId || media.kind !== "audio") return null;
    const processing = normalizeMediaProcessing(args.processing, media.kind, media.transcript ?? null);
    await ctx.db.patch(media._id, { processing });
    const updated = await ctx.db.get(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "system",
      action: "media.processing_updated",
      targetId: media._id,
      metadata: processing,
    });
    return publicMediaUpload(updated);
  },
});

export const getMediaForUser = gatewayQuery({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    return mediaForGateway(media);
  },
});

export const listMediaUploads = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db
      .query("mediaUploads")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return media.map(publicMediaUpload);
  },
});

export const listExpiredMediaUploads = gatewayQuery({
  args: {
    userId: v.string(),
    now: v.string(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db
      .query("mediaUploads")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return media
      .filter((item) => item.expiresAt && item.expiresAt <= args.now)
      .map(mediaForGateway);
  },
});

export const deleteMediaUpload = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    await ctx.db.delete(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media.deleted",
      targetId: media._id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        reason: args.reason ?? "manual",
      },
    });
    return publicMediaUpload(media);
  },
});

export const createAction = gatewayMutation({
  args: {
    userId: v.string(),
    type: v.string(),
    label: v.string(),
    payload: v.any(),
    targetMode: v.string(),
    environmentId: v.union(v.id("environments"), v.null()),
    threadId: v.union(v.string(), v.null()),
    steps: v.array(v.object({ actionId: v.id("actions"), continueOnFailure: v.boolean() })),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const timestamp = nowIso();
    const id = await ctx.db.insert("actions", {
      userExternalId: args.userId,
      type: args.type,
      label: args.label,
      payload: args.payload,
      targetMode: args.targetMode,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      steps: args.steps,
      disabled: args.disabled === true,
      disabledReason: args.disabled === true ? (args.disabledReason ?? null) : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const action = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.created",
      targetId: id,
      metadata: { label: args.label, type: args.type, stepCount: args.steps.length },
    });
    return publicAction(action);
  },
});

export const getActionForUser = gatewayQuery({
  args: { userId: v.string(), actionId: v.id("actions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    return action?.userExternalId === args.userId ? publicAction(action) : null;
  },
});

export const listActions = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const actions = await ctx.db
      .query("actions")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return actions.map(publicAction);
  },
});

export const updateAction = gatewayMutation({
  args: {
    userId: v.string(),
    actionId: v.id("actions"),
    type: v.optional(v.string()),
    label: v.optional(v.string()),
    payload: v.optional(v.any()),
    targetMode: v.optional(v.string()),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    steps: v.optional(v.array(v.object({ actionId: v.id("actions"), continueOnFailure: v.boolean() }))),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userExternalId !== args.userId) return null;
    const patch: any = { updatedAt: nowIso() };
    for (const key of ["type", "label", "payload", "targetMode", "steps", "disabled", "disabledReason"]) {
      if ((args as any)[key] !== undefined) patch[key] = (args as any)[key];
    }
    if (args.environmentId !== undefined) patch.environmentId = args.environmentId ?? undefined;
    if (args.threadId !== undefined) patch.threadId = args.threadId ?? undefined;
    await ctx.db.patch(action._id, patch);
    const updated = await ctx.db.get(action._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.updated",
      targetId: action._id,
      metadata: { label: updated?.label, type: updated?.type, stepCount: updated?.steps?.length ?? 0 },
    });
    return publicAction(updated);
  },
});

export const deleteAction = gatewayMutation({
  args: { userId: v.string(), actionId: v.id("actions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userExternalId !== args.userId) return null;
    const layouts = await ctx.db
      .query("deviceControls")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    const unassignedDeviceIds: string[] = [];
    for (const layout of layouts) {
      const items = (layout.items ?? []).filter((item: any) => String(item.actionId ?? "") !== String(action._id));
      if (items.length === (layout.items ?? []).length) continue;
      await ctx.db.patch(layout._id, { items, revision: layout.revision + 1, updatedAt: nowIso() });
      unassignedDeviceIds.push(String(layout.deviceId));
    }
    await ctx.db.delete(action._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.deleted",
      targetId: action._id,
      metadata: { label: action.label, type: action.type, unassignedDeviceIds },
    });
    return { action: publicAction(action), unassignedDeviceIds };
  },
});

export const recordActionRun = gatewayMutation({
  args: {
    userId: v.string(),
    actionId: v.string(),
    actorType: v.string(),
    actorId: v.optional(v.string()),
    status: v.string(),
    intentType: v.optional(v.union(v.string(), v.null())),
    commandIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType,
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: `action.run_${args.status}`,
      targetId: args.actionId,
      metadata: { intentType: args.intentType ?? null, commandIds: args.commandIds ?? [] },
    });
    return true;
  },
});

export const createMacroRun = gatewayMutation({
  args: {
    userId: v.string(), actionId: v.id("actions"), approvalCommandId: v.id("commands"),
    nextStepIndex: v.number(), runtime: v.any(), actor: v.any(), policyContext: v.any(),
    baseUrl: v.optional(v.union(v.string(), v.null())), executions: v.any(),
  },
  handler: async (ctx, args) => {
    const timestamp = nowIso();
    const id = await ctx.db.insert("macroRuns", {
      userExternalId: args.userId,
      actionId: args.actionId,
      approvalCommandId: args.approvalCommandId,
      nextStepIndex: args.nextStepIndex,
      runtime: args.runtime,
      actor: args.actor,
      policyContext: args.policyContext,
      baseUrl: args.baseUrl ?? null,
      executions: args.executions,
      status: "waiting_approval",
      resumeAttempts: 0,
      resumeClaimedAt: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const run = await ctx.db.get(id);
    return run ? { ...run, id: run._id, userId: run.userExternalId } : null;
  },
});

export const getMacroRunForApproval = gatewayQuery({
  args: { userId: v.string(), commandId: v.id("commands") },
  handler: async (ctx, args) => {
    const run = await ctx.db.query("macroRuns")
      .withIndex("byApprovalCommandId", (q) => q.eq("approvalCommandId", args.commandId))
      .first();
    return run?.userExternalId === args.userId ? { ...run, id: run._id, userId: run.userExternalId } : null;
  },
});

export const claimMacroRunForResume = gatewayMutation({
  args: { userId: v.string(), runId: v.id("macroRuns"), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.userExternalId !== args.userId) return null;
    const claimedAt = Date.parse(run.resumeClaimedAt ?? "");
    if (run.status === "resuming" && Number.isFinite(claimedAt)
      && Date.now() - claimedAt < (args.leaseMs ?? 30_000)) return null;
    if (!["waiting_approval", "resuming"].includes(run.status)) return null;
    const timestamp = nowIso();
    await ctx.db.patch(run._id, {
      status: "resuming",
      resumeAttempts: run.resumeAttempts + 1,
      resumeClaimedAt: timestamp,
      updatedAt: timestamp,
    });
    const updated = await ctx.db.get(run._id);
    return updated ? { ...updated, id: updated._id, userId: updated.userExternalId } : null;
  },
});

export const updateMacroRun = gatewayMutation({
  args: {
    userId: v.string(), runId: v.id("macroRuns"), approvalCommandId: v.optional(v.id("commands")),
    nextStepIndex: v.optional(v.number()), status: v.optional(v.string()), executions: v.optional(v.any()),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.userExternalId !== args.userId) return null;
    const patch: any = { updatedAt: nowIso() };
    for (const key of ["approvalCommandId", "nextStepIndex", "status", "executions", "result"]) {
      if ((args as any)[key] !== undefined) patch[key] = (args as any)[key];
    }
    if (args.status === "waiting_approval") patch.resumeClaimedAt = null;
    await ctx.db.patch(run._id, patch);
    const updated = await ctx.db.get(run._id);
    return updated ? { ...updated, id: updated._id, userId: updated.userExternalId } : null;
  },
});

export const getDeviceControls = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    return publicDeviceControls(controls ?? defaultDeviceControls(device));
  },
});

export const updateDeviceControls = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), items: v.any() },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const existing = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    const revision = (existing?.revision ?? 1) + 1;
    const timestamp = nowIso();
    const patch = { items: args.items, revision, updatedAt: timestamp };
    let controls;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      controls = await ctx.db.get(existing._id);
    } else {
      const id = await ctx.db.insert("deviceControls", {
        userExternalId: args.userId,
        deviceId: args.deviceId,
        ...patch,
        createdAt: timestamp,
      });
      controls = await ctx.db.get(id);
    }
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.controls_updated",
      targetId: args.deviceId,
      metadata: { revision, itemCount: args.items.length },
    });
    return publicDeviceControls(controls);
  },
});

export const acknowledgeDeviceControls = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    revision: v.number(),
    status: v.optional(v.string()),
    error: v.optional(v.union(v.string(), v.null())),
    appliedCount: v.optional(v.union(v.number(), v.null())),
    expectedCount: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const existing = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    const current = existing ?? defaultDeviceControls(device);
    if (!existing) return { controls: publicDeviceControls(current), reason: "no_explicit_layout" };
    let reason: string | null = null;
    if (args.revision > current.revision) reason = "future_revision";
    else if (args.revision < current.revision) reason = "stale_revision";
    else if (args.appliedCount !== null && args.appliedCount !== undefined
      && args.expectedCount !== null && args.expectedCount !== undefined
      && args.appliedCount !== args.expectedCount) reason = "count_mismatch";
    const timestamp = nowIso();
    const patch = reason ? {
      lastAckStatus: "rejected",
      lastAckError: reason === "count_mismatch"
        ? `Device applied ${args.appliedCount} controls; gateway resolved ${args.expectedCount}.`
        : `Device acknowledged revision ${args.revision}; current revision is ${current.revision}.`,
    } : {
      appliedRevision: Math.max(existing.appliedRevision ?? 0, args.revision),
      appliedAt: timestamp,
      lastAckStatus: args.status ?? "applied",
      lastAckError: args.error ?? null,
    };
    let controls;
    await ctx.db.patch(existing._id, patch);
    controls = await ctx.db.get(existing._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "device",
      actorId: args.deviceId,
      action: "device.controls_acknowledged",
      targetId: args.deviceId,
      metadata: {
        revision: args.revision,
        status: reason ? "rejected" : args.status ?? "applied",
        error: reason ?? args.error ?? null,
        appliedCount: args.appliedCount ?? null,
        expectedCount: args.expectedCount ?? null,
      },
    });
    return { controls: publicDeviceControls(controls), reason };
  },
});

export const getDeviceFirmwarePolicy = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    return device ? normalizeFirmwarePolicy({}, device.firmwarePolicy) : null;
  },
});

export const updateDeviceFirmwarePolicy = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    policy: v.any(),
    actorType: v.optional(v.string()),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const firmwarePolicy = normalizeFirmwarePolicy(args.policy, device.firmwarePolicy);
    await ctx.db.patch(device._id, { firmwarePolicy, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: args.actorType === "device" ? "device.firmware_reported" : "device.firmware_policy_updated",
      targetId: args.deviceId,
      metadata: firmwarePolicy,
    });
    return firmwarePolicy;
  },
});

export const createMacro = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    environmentId: v.union(v.id("environments"), v.null()),
    threadId: v.union(v.string(), v.null()),
    intent: v.any(),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("macros", {
      userExternalId: args.userId,
      label: args.label,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      intent: args.intent,
      disabled: args.disabled === true,
      disabledReason: args.disabled === true ? (args.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const macro = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "macro.created",
      targetId: id,
      metadata: {
        label: args.label,
        intentType: args.intent?.type,
        environmentId: args.environmentId,
      },
    });
    return publicMacro(macro);
  },
});

export const getMacroForUser = gatewayQuery({
  args: {
    userId: v.string(),
    macroId: v.id("macros"),
  },
  handler: async (ctx, args) => {
    const macro = await ctx.db.get(args.macroId);
    if (!macro || macro.userExternalId !== args.userId) return null;
    return macroForGateway(macro);
  },
});

export const listMacros = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const macros = await ctx.db
      .query("macros")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return macros.map(publicMacro);
  },
});

export const deleteMacro = gatewayMutation({
  args: {
    userId: v.string(),
    macroId: v.id("macros"),
  },
  handler: async (ctx, args) => {
    const macro = await ctx.db.get(args.macroId);
    if (!macro || macro.userExternalId !== args.userId) return null;
    await ctx.db.delete(macro._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "macro.deleted",
      targetId: macro._id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
      },
    });
    return publicMacro(macro);
  },
});

// User-defined device profiles. Built-in profiles live in src/profiles.mjs and are never stored.
// Capability *values* are validated on the Node side against DEVICE_CAPABILITIES — only shape,
// type, and non-emptiness are enforced here so the two never drift.
export const createDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
    label: v.string(),
    description: v.string(),
    capabilities: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const label = requireProfileLabel(args.label);
    const description = normalizeProfileDescription(args.description);
    const capabilities = normalizeProfileCapabilities(args.capabilities);
    // Conflict convention matches the rest of this file (see claimDevice): null, not a throw.
    // create has exactly one null path, so null here always means "profileId already taken".
    const existing = await findDeviceProfile(ctx, args.userId, profileId);
    if (existing) return null;
    const id = await ctx.db.insert("deviceProfiles", {
      userExternalId: args.userId,
      profileId,
      label,
      description,
      capabilities,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const profile = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.created",
      targetId: id,
      metadata: { profileId, label, capabilities },
    });
    return publicDeviceProfile(profile);
  },
});

// NOTE: named *Definition because `updateDeviceProfile` above is already taken — it assigns a
// profile to a device. This one edits a stored custom profile record.
export const updateDeviceProfileDefinition = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const profile = await findDeviceProfile(ctx, args.userId, profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (args.label !== undefined) patch.label = requireProfileLabel(args.label);
    if (args.description !== undefined) patch.description = normalizeProfileDescription(args.description);
    if (args.capabilities !== undefined) patch.capabilities = normalizeProfileCapabilities(args.capabilities);
    await ctx.db.patch(profile._id, patch);
    const updated = await ctx.db.get(profile._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.updated",
      targetId: profile._id,
      metadata: {
        profileId,
        label: updated?.label,
        previousCapabilities: profile.capabilities,
        capabilities: updated?.capabilities,
      },
    });
    return publicDeviceProfile(updated);
  },
});

export const listDeviceProfiles = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("deviceProfiles")
      .withIndex("byUserExternalIdAndProfileId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return profiles.map(publicDeviceProfile);
  },
});

export const deleteDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const profile = await findDeviceProfile(ctx, args.userId, profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    await ctx.db.delete(profile._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.deleted",
      targetId: profile._id,
      metadata: {
        profileId,
        label: profile.label,
        capabilities: profile.capabilities,
      },
    });
    return publicDeviceProfile(profile);
  },
});

export const createCommand = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    environmentId: v.id("environments"),
    threadId: v.union(v.string(), v.null()),
    intent: v.any(),
    normalized: v.any(),
    status: v.string(),
    risk: v.string(),
    result: v.any(),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("commands", {
      userExternalId: args.userId,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      environmentId: args.environmentId,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      intent: args.intent,
      normalized: args.normalized,
      status: args.status,
      risk: args.risk,
      result: args.result,
      metrics: normalizeCommandMetrics(args.metrics),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const command = await ctx.db.get(id);
    await createCommandEvent(ctx, {
      userExternalId: args.userId,
      commandId: id,
      deviceId: args.deviceId ?? undefined,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      status: args.status,
      risk: args.risk,
      result: args.result,
      metrics: normalizeCommandMetrics(args.metrics),
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      action: `command.${args.status}`,
      targetId: id,
      metadata: { intentType: args.intent?.type, risk: args.risk },
    });
    return publicCommand(command);
  },
});

export const getCommandForUser = gatewayQuery({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return null;
    return publicCommand(command);
  },
});

export const claimCommandApproval = gatewayMutation({
  args: { userId: v.string(), commandId: v.id("commands"), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId || command.status !== "approval_required") return null;
    const claimedAt = Date.parse(command.approvalClaimedAt ?? "");
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < (args.leaseMs ?? 30_000)) return null;
    await ctx.db.patch(command._id, { approvalClaimedAt: nowIso() });
    return publicCommand(await ctx.db.get(command._id));
  },
});

export const updateCommand = gatewayMutation({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
    status: v.optional(v.string()),
    normalized: v.optional(v.any()),
    result: v.optional(v.any()),
    risk: v.optional(v.string()),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return null;
    const previousStatus = command.status;
    const patch: any = { updatedAt: nowIso() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.normalized !== undefined) patch.normalized = args.normalized;
    if (args.result !== undefined) patch.result = args.result;
    if (args.risk !== undefined) patch.risk = args.risk;
    if (args.metrics !== undefined) patch.metrics = normalizeCommandMetrics(args.metrics);
    await ctx.db.patch(command._id, patch);
    const updated = await ctx.db.get(command._id);
    await createCommandEvent(ctx, {
      userExternalId: args.userId,
      commandId: command._id,
      deviceId: command.deviceId ?? undefined,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId ?? undefined,
      status: updated?.status ?? command.status,
      previousStatus,
      risk: updated?.risk ?? command.risk,
      result: updated?.result ?? null,
      metrics: updated?.metrics ?? null,
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId ?? undefined,
      action: `command.${updated?.status}`,
      targetId: command._id,
      metadata: {
        intentType: command.intent?.type,
        risk: updated?.risk,
        previousStatus,
      },
    });
    return publicCommand(updated);
  },
});

export const listCommands = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const commands = await ctx.db
      .query("commands")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return commands.map(publicCommand);
  },
});

export const listCommandEvents = gatewayQuery({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return [];
    const events = await ctx.db
      .query("commandEvents")
      .withIndex("byCommandId", (q) => q.eq("commandId", args.commandId))
      .collect();
    return events
      .filter((event) => event.userExternalId === args.userId)
      .map(publicCommandEvent);
  },
});

export const listAuditLogs = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("auditLogs")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return events.map(publicAuditLog);
  },
});

async function ensureUserRecord(ctx: any, userId: string, email?: string, name?: string) {
  const existing = await findUser(ctx, userId);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.privacy) patch.privacy = defaultPrivacySettings;
    if (!existing.onboarding) patch.onboarding = defaultOnboarding;
    if (email && existing.email !== email) patch.email = email;
    if (name && existing.name !== name) patch.name = name;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    return existing;
  }
  const id = await ctx.db.insert("users", {
    externalId: userId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    privacy: defaultPrivacySettings,
    onboarding: defaultOnboarding,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  await audit(ctx, {
    userExternalId: userId,
    actorType: "system",
    action: "user.created",
    targetId: userId,
    metadata: { email },
  });
  return await ctx.db.get(id);
}

async function findUser(ctx: any, userId: string) {
  return await ctx.db
    .query("users")
    .withIndex("byExternalId", (q: any) => q.eq("externalId", userId))
    .unique();
}

async function getDeviceForOwner(ctx: any, userId: string, deviceId: any) {
  const device = await ctx.db.get(deviceId);
  if (!device || device.userExternalId !== userId) return null;
  return device;
}

// Scoped by user in the index range itself, so one user's slug can never reach another's record.
async function findDeviceProfile(ctx: any, userId: string, profileId: string) {
  return await ctx.db
    .query("deviceProfiles")
    .withIndex("byUserExternalIdAndProfileId", (q: any) =>
      q.eq("userExternalId", userId).eq("profileId", profileId))
    .unique();
}

function requireProfileSlug(value: any) {
  const slug = normalizeNullableString(value);
  if (!slug) throw new Error("Device profile requires a non-empty profileId");
  if (slug.length > 64) throw new Error("Device profile profileId exceeds 64 characters");
  return slug;
}

function requireProfileLabel(value: any) {
  const label = normalizeNullableString(value);
  if (!label) throw new Error("Device profile requires a non-empty label");
  return label.slice(0, 120);
}

function normalizeProfileDescription(value: any) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("Device profile description must be a string");
  return value.trim().slice(0, 2000);
}

// Deliberately no capability whitelist: DEVICE_CAPABILITIES lives in src/profiles.mjs and is
// enforced there. Here we only guarantee a deduped array of non-empty strings.
function normalizeProfileCapabilities(value: any) {
  if (!Array.isArray(value)) throw new Error("Device profile capabilities must be an array");
  if (value.length > 32) throw new Error("Device profile lists too many capabilities");
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Device profile capabilities must be strings");
    const capability = entry.trim();
    if (!capability) throw new Error("Device profile capabilities must be non-empty strings");
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

async function audit(ctx: any, input: any) {
  await ctx.db.insert("auditLogs", {
    userExternalId: input.userExternalId,
    actorType: input.actorType,
    ...(input.actorId ? { actorId: String(input.actorId) } : {}),
    action: input.action,
    ...(input.targetId ? { targetId: String(input.targetId) } : {}),
    metadata: input.metadata ?? {},
    createdAt: nowIso(),
  });
}

function nowIso() {
  return new Date(Date.now()).toISOString();
}

function normalizeDeviceConfig(input: any = {}, existing: any = null) {
  const base = {
    ...defaultConfig,
    ...(existing ?? {}),
  };
  const next = { ...base };

  if (Object.hasOwn(input, "environmentId")) {
    next.environmentId = normalizeNullableString(input.environmentId) ?? undefined;
  }
  if (Object.hasOwn(input, "threadId")) {
    next.threadId = normalizeNullableString(input.threadId) ?? undefined;
  }
  if (Object.hasOwn(input, "gatewayAccessMode") && ["local", "tailscale", "online"].includes(input.gatewayAccessMode)) {
    next.gatewayAccessMode = input.gatewayAccessMode;
  }
  if (Object.hasOwn(input, "gatewayUrl")) {
    next.gatewayUrl = normalizeNullableString(input.gatewayUrl)?.replace(/\/+$/u, "") ?? null;
  }
  if (Object.hasOwn(input, "defaultPrompt")) {
    const value = normalizeNullableString(input.defaultPrompt);
    next.defaultPrompt = value || defaultConfig.defaultPrompt;
  }
  if (Object.hasOwn(input, "shellCommand")) {
    const value = normalizeNullableString(input.shellCommand);
    next.shellCommand = value || defaultConfig.shellCommand;
  }
  if (Object.hasOwn(input, "menu")) {
    const allowed = new Set(["status", "prompt", "shell", "macro", "approve", "reject", "media", "stop", "thread", "reset"]);
    const menu = Array.isArray(input.menu)
      ? input.menu
        .map((item: any) => normalizeNullableString(item))
        .filter((item: string | null) => item && allowed.has(item))
      : [];
    // 8 matches kMaxMenuItems in the firmware. Anything beyond it is dropped here
    // silently, so this cap must not be tighter than what the hardware can render.
    next.menu = [...new Set(menu)].slice(0, 8);
    if (next.menu.length === 0) next.menu = defaultConfig.menu;
  }

  return next;
}

function normalizeDeviceStatus(input: any = {}, existing: any = null, heartbeatAt: string | null = nowIso()) {
  const base = {
    ...defaultStatus,
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
      ? [...new Set(input.features.filter((feature: any) => typeof feature === "string" && feature.trim()).map((feature: string) => feature.trim()))].slice(0, 32)
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

function normalizeGatewayTelemetry(input: any) {
  const reportedStatus = input.switchStatus ?? input.state;
  const switchStatus = reportedStatus === "stable" ? "active"
    : reportedStatus === "pending" ? "probing"
      : ["active", "probing", "failed"].includes(reportedStatus) ? reportedStatus : "active";
  return {
    activeProfileId: normalizeNullableString(input.activeProfileId),
    activeUrl: normalizeNullableString(input.activeUrl),
    pendingProfileId: normalizeNullableString(input.pendingProfileId),
    pendingUrl: normalizeNullableString(input.pendingUrl),
    switchStatus,
    detail: normalizeNullableString(input.detail),
  };
}

function normalizeFirmwarePolicy(input: any = {}, existing: any = null) {
  const next: any = { ...defaultFirmwarePolicy, ...(existing ?? {}) };
  if (Object.hasOwn(input, "channel") && ["stable", "beta"].includes(input.channel)) next.channel = input.channel;
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

function normalizeNullableString(value: any) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnvironmentHealth(input: any = {}, existing: any = null) {
  const base = {
    ...defaultEnvironmentHealth,
    ...(existing ?? {}),
  };
  return {
    ...base,
    ...(Object.hasOwn(input, "lastCheckedAt") ? { lastCheckedAt: normalizeNullableString(input.lastCheckedAt) } : {}),
    ...(Object.hasOwn(input, "lastReachableAt") ? { lastReachableAt: normalizeNullableString(input.lastReachableAt) } : {}),
    ...(Object.hasOwn(input, "lastError") ? { lastError: normalizeNullableString(input.lastError) } : {}),
    ...(Object.hasOwn(input, "failureReason")
      ? { failureReason: environmentFailureReasons.has(input.failureReason) ? input.failureReason : null }
      : {}),
    ...(Object.hasOwn(input, "snapshot") ? { snapshot: input.snapshot ?? null } : {}),
    ...(Object.hasOwn(input, "compatibility") ? { compatibility: input.compatibility ?? null } : {}),
  };
}

function normalizeCommandMetrics(input: any = {}) {
  const metrics = input && typeof input === "object" ? input : {};
  return {
    acknowledgementDurationMs: normalizeOptionalNumber(metrics.acknowledgementDurationMs),
    dispatchDurationMs: normalizeOptionalNumber(metrics.dispatchDurationMs),
    completedAt: normalizeNullableString(metrics.completedAt),
    failureAt: normalizeNullableString(metrics.failureAt),
  };
}

function normalizePrivacySettings(input: any = {}, existing: any = defaultPrivacySettings) {
  const base = {
    ...defaultPrivacySettings,
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

function defaultSubscription(updatedAt: string) {
  return {
    tier: defaultSubscriptionTier,
    status: defaultSubscriptionStatus,
    provider: null as string | null,
    externalId: null as string | null,
    currentPeriodEnd: null as string | null,
    updatedAt,
  };
}

function normalizeSubscription(existing: any, fallbackUpdatedAt: any = null) {
  const base = defaultSubscription(normalizeNullableString(fallbackUpdatedAt) ?? nowIso());
  if (!existing || typeof existing !== "object") return base;
  const tier = normalizeSubscriptionEnum(existing.tier);
  const status = normalizeSubscriptionEnum(existing.status);
  return {
    ...base,
    tier: tier && subscriptionTiers.has(tier) ? tier : base.tier,
    status: status && subscriptionStatuses.has(status) ? status : base.status,
    provider: normalizeNullableString(existing.provider),
    externalId: normalizeNullableString(existing.externalId),
    currentPeriodEnd: normalizeNullableString(existing.currentPeriodEnd),
    updatedAt: normalizeNullableString(existing.updatedAt) ?? base.updatedAt,
  };
}

function normalizeSubscriptionEnum(value: any) {
  const normalized = normalizeNullableString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function requireSubscriptionTier(value: any) {
  const tier = normalizeSubscriptionEnum(value);
  if (!tier || !subscriptionTiers.has(tier)) {
    throw new Error(`Unsupported subscription tier: ${String(value)}`);
  }
  return tier;
}

function requireSubscriptionStatus(value: any) {
  const status = normalizeSubscriptionEnum(value);
  if (!status || !subscriptionStatuses.has(status)) {
    throw new Error(`Unsupported subscription status: ${String(value)}`);
  }
  return status;
}

function normalizeTranscript(value: any) {
  if (typeof value !== "string") return undefined;
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}

function normalizeMediaProcessing(input: any = null, kind = "image", transcript: any = null) {
  const now = nowIso();
  if (kind !== "audio") {
    return {
      transcriptionStatus: "not_applicable",
      transcriptSource: null,
      lastError: null,
      updatedAt: input?.updatedAt ?? now,
    };
  }
  const allowed = new Set(["pending", "processing", "ready", "failed", "unavailable"]);
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

function publicUser(user: any) {
  if (!user) return null;
  return {
    id: user.externalId,
    email: user.email,
    name: user.name ?? null,
    privacy: normalizePrivacySettings(user.privacy),
    onboarding: normalizeOnboarding(user.onboarding),
    createdAt: user.createdAt,
  };
}

function normalizeOnboarding(value: any) {
  const input = value && typeof value === "object" ? value : {};
  const provider = input.provider && typeof input.provider === "object" ? input.provider : {};
  const workspace = input.workspace && typeof input.workspace === "object" ? input.workspace : {};
  const device = input.device && typeof input.device === "object" ? input.device : {};
  return {
    ...defaultOnboarding,
    ...input,
    version: 2,
    provider: { ...defaultOnboarding.provider, ...provider },
    workspace: { ...defaultOnboarding.workspace, ...workspace },
    device: { ...defaultOnboarding.device, ...device },
  };
}

function normalizeOnboardingInput(value: any, previous: any) {
  const input = value && typeof value === "object" ? value : {};
  const now = nowIso();
  const onboarding = normalizeOnboarding({
    ...previous,
    ...input,
    provider: { ...previous.provider, ...(input.provider ?? {}) },
    workspace: { ...previous.workspace, ...(input.workspace ?? {}) },
    device: { ...previous.device, ...(input.device ?? {}) },
    updatedAt: now,
  });
  if (onboarding.status !== "not_started" && !onboarding.startedAt) onboarding.startedAt = now;
  if (onboarding.status === "paused") onboarding.pausedAt = now;
  if (onboarding.status === "in_progress") onboarding.pausedAt = null;
  if (onboarding.status === "completed") {
    onboarding.currentStep = "ready";
    onboarding.completedAt = onboarding.completedAt ?? now;
    onboarding.pausedAt = null;
  }
  return onboarding;
}

function publicUserToken(token: any) {
  if (!token) return null;
  return {
    id: token._id,
    userId: token.userExternalId,
    label: token.label,
    revokedAt: token.revokedAt ?? null,
    lastUsedAt: token.lastUsedAt ?? null,
    createdAt: token.createdAt,
  };
}

function publicDevice(device: any) {
  if (!device) return null;
  return {
    id: device._id,
    userId: device.userExternalId ?? null,
    label: device.label,
    profile: device.profile,
    claimedAt: device.claimedAt ?? null,
    claimCodeExpiresAt: device.claimCodeExpiresAt ?? null,
    revokedAt: device.revokedAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
    status: normalizeDeviceStatus({}, device.status, device.status?.lastHeartbeatAt ?? null),
    firmwarePolicy: normalizeFirmwarePolicy({}, device.firmwarePolicy),
    presence: buildDevicePresence(device),
    config: publicDeviceConfig(device.config),
    gatewaySelection: normalizeGatewaySelection(device.gatewaySelection),
    actions: deviceActions(device),
    createdAt: device.createdAt,
    claimed: Boolean(device.claimedAt),
  };
}

/**
 * Which owner operations this device can currently accept. Mirrors deviceActions() in
 * src/store.mjs — the memory store is the reference implementation, and a client that trusts this
 * field must get the same answer from either backend.
 */
function deviceActions(device: any) {
  const revoked = Boolean(device.revokedAt);
  return {
    rotateSecret: !revoked,
    transferReset: !revoked,
    updateConfig: !revoked,
    updateProfile: !revoked,
    revoke: !revoked,
    delete: revoked,
  };
}

function buildDevicePresence(device: any, now = Date.now()) {
  const lastSeenAt = normalizeNullableString(device.lastSeenAt);
  const lastHeartbeatAt = normalizeNullableString(device.status?.lastHeartbeatAt);
  const latestActivityAt = latestIso(lastSeenAt, lastHeartbeatAt);
  const ageMs = latestActivityAt ? Math.max(0, now - Date.parse(latestActivityAt)) : null;
  const online = ageMs !== null && ageMs <= deviceOnlineThresholdMs;
  return {
    state: online ? "online" : "offline",
    online,
    lastSeenAt,
    lastHeartbeatAt,
    latestActivityAt,
    ageMs,
    staleAfterMs: deviceOnlineThresholdMs,
  };
}

function latestIso(...values: any[]) {
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

function publicDeviceConfig(config: any = {}) {
  return {
    environmentId: config.environmentId ?? null,
    threadId: config.threadId ?? null,
    gatewayAccessMode: config.gatewayAccessMode ?? "local",
    gatewayUrl: config.gatewayUrl ?? null,
    defaultPrompt: config.defaultPrompt ?? defaultConfig.defaultPrompt,
    shellCommand: config.shellCommand ?? defaultConfig.shellCommand,
    menu: Array.isArray(config.menu) && config.menu.length > 0 ? config.menu : defaultConfig.menu,
  };
}

function publicEnvironment(environment: any) {
  if (!environment) return null;
  const gatewayEnvironment = environmentForGateway(environment);
  if (!gatewayEnvironment) return null;
  const { accessToken, ...output } = gatewayEnvironment;
  return output;
}

function environmentForGateway(environment: any) {
  if (!environment) return null;
  return {
    id: environment._id,
    userId: environment.userExternalId,
    label: environment.label,
    baseUrl: environment.baseUrl,
    accessToken: environment.accessToken,
    accessTokenExpiresAt: environment.accessTokenExpiresAt ?? null,
    scopes: environment.scopes,
    status: environment.status,
    health: normalizeEnvironmentHealth(environment.health),
    providerCatalogue: environment.providerCatalogue ?? null,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

function publicFirmwareRelease(release: any) {
  if (!release) return null;
  return {
    id: release._id,
    version: release.version,
    channel: release.channel ?? "stable",
    hardwareModel: release.hardwareModel,
    url: release.url,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    mandatory: release.mandatory,
    releaseNotes: release.releaseNotes,
    createdAt: release.createdAt,
  };
}

function publicGatewayProfile(profile: any) {
  if (!profile) return null;
  return { id: String(profile._id), userId: profile.userExternalId, label: profile.label,
    mode: profile.mode, url: profile.url, baseUrl: profile.url,
    createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

function normalizeGatewaySelection(input: any = null) {
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

function publicMediaUpload(media: any) {
  if (!media) return null;
  const gatewayMedia = mediaForGateway(media);
  if (!gatewayMedia) return null;
  const { storagePath, ...output } = gatewayMedia;
  return output;
}

function publicMacro(macro: any) {
  if (!macro) return null;
  return {
    id: macro._id,
    userId: macro.userExternalId,
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

function publicAction(action: any) {
  if (!action) return null;
  return {
    id: action._id,
    userId: action.userExternalId,
    type: action.type,
    label: action.label,
    payload: action.payload ?? {},
    targetMode: action.targetMode ?? "device-current",
    environmentId: action.environmentId ?? null,
    threadId: action.threadId ?? null,
    steps: action.steps ?? [],
    disabled: action.disabled === true,
    disabledReason: action.disabled === true ? (action.disabledReason ?? null) : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function defaultDeviceControls(device: any) {
  return {
    userExternalId: device.userExternalId,
    deviceId: device._id,
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

function publicDeviceControls(controls: any) {
  if (!controls) return null;
  return {
    deviceId: controls.deviceId,
    revision: controls.revision,
    explicit: controls._id ? true : controls.explicit === true,
    items: controls.items ?? [],
    appliedRevision: controls.appliedRevision ?? null,
    appliedAt: controls.appliedAt ?? null,
    lastAckStatus: controls.lastAckStatus ?? null,
    lastAckError: controls.lastAckError ?? null,
    updatedAt: controls.updatedAt,
  };
}

function publicDeviceProfile(profile: any) {
  if (!profile) return null;
  return {
    id: profile._id,
    userId: profile.userExternalId,
    profileId: profile.profileId,
    label: profile.label,
    description: profile.description,
    capabilities: Array.isArray(profile.capabilities) ? [...profile.capabilities] : [],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function macroForGateway(macro: any) {
  return publicMacro(macro);
}

function mediaForGateway(media: any) {
  if (!media) return null;
  return {
    id: media._id,
    userId: media.userExternalId,
    deviceId: media.deviceId ?? null,
    kind: media.kind,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256,
    storagePath: media.storagePath,
    originalName: media.originalName ?? null,
    transcript: media.transcript ?? null,
    processing: normalizeMediaProcessing(media.processing, media.kind, media.transcript ?? null),
    expiresAt: media.expiresAt ?? null,
    createdAt: media.createdAt,
  };
}

async function createCommandEvent(ctx: any, input: any) {
  await ctx.db.insert("commandEvents", {
    userExternalId: input.userExternalId,
    commandId: input.commandId,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    actorType: input.actorType,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    status: input.status,
    previousStatus: input.previousStatus ?? null,
    risk: input.risk,
    result: input.result ?? null,
    metrics: normalizeCommandMetrics(input.metrics),
    createdAt: nowIso(),
  });
}

function publicCommand(command: any) {
  if (!command) return null;
  return {
    id: command._id,
    userId: command.userExternalId,
    deviceId: command.deviceId ?? null,
    environmentId: command.environmentId,
    threadId: command.threadId ?? null,
    intent: command.intent,
    normalized: command.normalized,
    status: command.status,
    risk: command.risk,
    result: command.result ?? null,
    metrics: normalizeCommandMetrics(command.metrics),
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
  };
}

function publicCommandEvent(event: any) {
  if (!event) return null;
  return {
    id: event._id,
    userId: event.userExternalId,
    commandId: event.commandId,
    deviceId: event.deviceId ?? null,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    status: event.status,
    previousStatus: event.previousStatus ?? null,
    risk: event.risk,
    result: event.result ?? null,
    metrics: normalizeCommandMetrics(event.metrics),
    createdAt: event.createdAt,
  };
}

function publicAuditLog(event: any) {
  if (!event) return null;
  return {
    id: event._id,
    userId: event.userExternalId,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    action: event.action,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt,
  };
}
