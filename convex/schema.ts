import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    externalId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    privacy: v.optional(v.object({
      mediaRetentionDays: v.union(v.number(), v.null()),
    })),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byExternalId", ["externalId"]),

  apiTokens: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    tokenHash: v.string(),
    revokedAt: v.optional(v.string()),
    lastUsedAt: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byTokenHash", ["tokenHash"]),

  devices: defineTable({
    userExternalId: v.optional(v.string()),
    label: v.string(),
    profile: v.string(),
    secretHash: v.string(),
    claimCodeHash: v.optional(v.string()),
    claimedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    lastSeenAt: v.optional(v.string()),
    status: v.optional(v.object({
      lastHeartbeatAt: v.union(v.string(), v.null()),
      firmwareVersion: v.union(v.string(), v.null()),
      hardwareModel: v.union(v.string(), v.null()),
      ipAddress: v.union(v.string(), v.null()),
      wifiRssi: v.union(v.number(), v.null()),
      freeHeap: v.union(v.number(), v.null()),
      uptimeMs: v.union(v.number(), v.null()),
      batteryMv: v.union(v.number(), v.null()),
      batteryPercent: v.union(v.number(), v.null()),
    })),
    config: v.object({
      environmentId: v.optional(v.string()),
      threadId: v.optional(v.string()),
      defaultPrompt: v.string(),
      shellCommand: v.optional(v.string()),
      menu: v.array(v.string()),
    }),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byClaimCodeHash", ["claimCodeHash"]),

  environments: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    baseUrl: v.string(),
    accessToken: v.string(),
    accessTokenExpiresAt: v.optional(v.union(v.string(), v.null())),
    scopes: v.array(v.string()),
    status: v.string(),
    health: v.optional(v.object({
      lastCheckedAt: v.union(v.string(), v.null()),
      lastReachableAt: v.union(v.string(), v.null()),
      lastError: v.union(v.string(), v.null()),
      snapshot: v.any(),
    })),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  mediaUploads: defineTable({
    userExternalId: v.string(),
    deviceId: v.optional(v.id("devices")),
    kind: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    storagePath: v.string(),
    originalName: v.optional(v.string()),
    transcript: v.optional(v.union(v.string(), v.null())),
    processing: v.optional(v.any()),
    expiresAt: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  macros: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    environmentId: v.optional(v.id("environments")),
    threadId: v.optional(v.string()),
    intent: v.any(),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  commands: defineTable({
    userExternalId: v.string(),
    deviceId: v.optional(v.id("devices")),
    environmentId: v.id("environments"),
    threadId: v.optional(v.string()),
    intent: v.any(),
    normalized: v.any(),
    status: v.string(),
    risk: v.string(),
    result: v.any(),
    metrics: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  commandEvents: defineTable({
    userExternalId: v.string(),
    commandId: v.id("commands"),
    deviceId: v.optional(v.id("devices")),
    actorType: v.string(),
    actorId: v.optional(v.string()),
    status: v.string(),
    previousStatus: v.optional(v.union(v.string(), v.null())),
    risk: v.string(),
    result: v.any(),
    metrics: v.optional(v.any()),
    createdAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byCommandId", ["commandId"]),

  firmwareReleases: defineTable({
    version: v.string(),
    hardwareModel: v.string(),
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    mandatory: v.boolean(),
    releaseNotes: v.string(),
    createdAt: v.string(),
  }).index("byHardwareModel", ["hardwareModel"]),

  auditLogs: defineTable({
    userExternalId: v.string(),
    actorType: v.string(),
    actorId: v.optional(v.string()),
    action: v.string(),
    targetId: v.optional(v.string()),
    metadata: v.any(),
    createdAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),
});
