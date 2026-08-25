import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Per-environment provider catalogue: the T3 provider instances (agent harnesses) and
// their models, collected on the T3 host and registered with the gateway. Cached
// reference data only — it carries no credentials, and the strict object validators
// below reject any extra field a future T3 build might add.
export const providerCatalogueValidator = v.object({
  updatedAt: v.string(),
  source: v.string(),
  instances: v.array(v.object({
    instanceId: v.string(),
    label: v.string(),
    badge: v.union(v.string(), v.null()),
    version: v.union(v.string(), v.null()),
    status: v.string(),
    enabled: v.boolean(),
    installed: v.boolean(),
    auth: v.object({
      status: v.string(),
      type: v.union(v.string(), v.null()),
      label: v.union(v.string(), v.null()),
    }),
    models: v.array(v.object({
      slug: v.string(),
      name: v.string(),
      isCustom: v.boolean(),
      options: v.array(v.object({
        id: v.string(),
        label: v.string(),
        type: v.string(),
        currentValue: v.union(v.string(), v.null()),
        choices: v.array(v.object({
          id: v.string(),
          label: v.string(),
          isDefault: v.boolean(),
        })),
      })),
    })),
  })),
});

export default defineSchema({
  users: defineTable({
    externalId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    privacy: v.optional(v.object({
      mediaRetentionDays: v.union(v.number(), v.null()),
    })),
    subscription: v.optional(v.object({
      tier: v.string(),
      status: v.string(),
      provider: v.union(v.string(), v.null()),
      externalId: v.union(v.string(), v.null()),
      currentPeriodEnd: v.union(v.string(), v.null()),
      updatedAt: v.string(),
    })),
    onboarding: v.optional(v.any()),
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
    hardwareModel: v.optional(v.union(v.string(), v.null())),
    secretHash: v.string(),
    claimCodeHash: v.optional(v.string()),
    claimCodeExpiresAt: v.optional(v.string()),
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
      protocolVersion: v.optional(v.number()),
      features: v.optional(v.array(v.string())),
      limits: v.optional(v.any()),
      gateway: v.optional(v.any()),
    })),
    firmwarePolicy: v.optional(v.any()),
    gatewaySelection: v.optional(v.any()),
    // This device's auto-send answer. `ownerChoice` is the only field an owner writes — true,
    // false, or null for "never said" — and the rest is derived from it plus whether the hardware
    // has ever reported a microphone. Rows written before the three-state model carry only
    // `enabled`, which is why every field but that one is optional.
    voiceAutoSend: v.optional(v.object({
      enabled: v.boolean(),
      ownerChoice: v.optional(v.union(v.boolean(), v.null())),
      source: v.optional(v.string()),
      audioCapable: v.optional(v.boolean()),
      enabledBy: v.union(v.string(), v.null()),
      enabledAt: v.union(v.string(), v.null()),
    })),
    config: v.object({
      environmentId: v.optional(v.string()),
      projectId: v.optional(v.string()),
      threadId: v.optional(v.string()),
      gatewayAccessMode: v.optional(v.union(v.literal("local"), v.literal("tailscale"), v.literal("online"))),
      gatewayUrl: v.optional(v.union(v.string(), v.null())),
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
      failureReason: v.optional(v.union(v.string(), v.null())),
      snapshot: v.any(),
      compatibility: v.optional(v.any()),
    })),
    providerCatalogue: v.optional(providerCatalogueValidator),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  // Short-lived, single-use enrollment codes for console-first pairing. Only the hash is stored;
  // the plaintext is generated in Node and shown once. See src/connectSession.mjs.
  connectSessions: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    accessMode: v.string(),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    status: v.string(),
    codeHash: v.union(v.string(), v.null()),
    expiresAt: v.string(),
    baseUrl: v.optional(v.union(v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
    completedAt: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byCodeHash", ["codeHash"]),

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
    // Vision descriptions had no column, so updateMediaDescription wrote a field the serialiser
    // then dropped: the whole vision path read back null on the live backend.
    description: v.optional(v.union(v.string(), v.null())),
    processing: v.optional(v.any()),
    expiresAt: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  // Durable media processing jobs. Transcription runs here rather than inside the HTTP request,
  // so a restart mid-ASR-call resumes the job instead of losing it. The transcript is kept as
  // versions — raw ASR output, the normalized cleanup, and the reviewed value — never one
  // overwritten string.
  //
  // `byStage` exists because the worker enumerates runnable jobs across all users; that is the one
  // place in this schema where a global scan is the point rather than a mistake.
  mediaJobs: defineTable({
    userExternalId: v.string(),
    mediaId: v.id("mediaUploads"),
    kind: v.string(),
    stage: v.string(),
    // Which controller recorded the capture, and where a finished transcript would be sent.
    deviceId: v.optional(v.union(v.id("devices"), v.null())),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    // The dispatch outcome. Separate from lastError/failureKind because transcription succeeding
    // and the send being refused are independent, and a device has to tell them apart.
    autoSend: v.optional(v.boolean()),
    dispatchStatus: v.optional(v.union(v.string(), v.null())),
    dispatchError: v.optional(v.union(v.string(), v.null())),
    commandId: v.optional(v.union(v.id("commands"), v.null())),
    provider: v.optional(v.union(v.string(), v.null())),
    model: v.optional(v.union(v.string(), v.null())),
    language: v.optional(v.union(v.string(), v.null())),
    rawTranscript: v.optional(v.union(v.string(), v.null())),
    normalizedTranscript: v.optional(v.union(v.string(), v.null())),
    userEditedTranscript: v.optional(v.union(v.string(), v.null())),
    attempts: v.number(),
    maxAttempts: v.number(),
    reviewRequired: v.boolean(),
    leaseOwner: v.optional(v.union(v.string(), v.null())),
    leaseExpiresAt: v.optional(v.union(v.string(), v.null())),
    lastError: v.optional(v.union(v.string(), v.null())),
    failureKind: v.optional(v.union(v.string(), v.null())),
    // Why a terminal failure was terminal — configuration, input, provider, unknown. Separate from
    // failureKind, which only says whether an identical retry was worth making: this is what the
    // owner-driven configuration-retry path selects on.
    failureCause: v.optional(v.union(v.string(), v.null())),
    requeueCount: v.optional(v.number()),
    requeuedAt: v.optional(v.union(v.string(), v.null())),
    requeuedBy: v.optional(v.union(v.string(), v.null())),
    timings: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byMediaId", ["mediaId"])
    .index("byStage", ["stage"]),

  macros: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    environmentId: v.optional(v.id("environments")),
    threadId: v.optional(v.string()),
    intent: v.any(),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  actions: defineTable({
    userExternalId: v.string(),
    type: v.string(),
    label: v.string(),
    payload: v.any(),
    targetMode: v.string(),
    environmentId: v.optional(v.id("environments")),
    threadId: v.optional(v.string()),
    steps: v.array(v.object({
      actionId: v.id("actions"),
      continueOnFailure: v.boolean(),
    })),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalId", ["userExternalId"]),

  deviceControls: defineTable({
    userExternalId: v.string(),
    deviceId: v.id("devices"),
    revision: v.number(),
    items: v.any(),
    appliedRevision: v.optional(v.union(v.number(), v.null())),
    appliedAt: v.optional(v.union(v.string(), v.null())),
    lastAckStatus: v.optional(v.union(v.string(), v.null())),
    lastAckError: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byUserExternalId", ["userExternalId"])
    .index("byDeviceId", ["deviceId"]),

  macroRuns: defineTable({
    userExternalId: v.string(),
    actionId: v.id("actions"),
    approvalCommandId: v.id("commands"),
    nextStepIndex: v.number(),
    runtime: v.any(),
    actor: v.any(),
    policyContext: v.any(),
    baseUrl: v.optional(v.union(v.string(), v.null())),
    executions: v.any(),
    status: v.string(),
    resumeAttempts: v.number(),
    resumeClaimedAt: v.optional(v.union(v.string(), v.null())),
    result: v.any(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("byApprovalCommandId", ["approvalCommandId"])
    .index("byUserExternalId", ["userExternalId"]),

  // User-defined device profiles (roadmap Phase 8 profile editor). The three built-in profiles
  // in src/profiles.mjs stay in code and are never stored here — this table only holds custom
  // ones. Capability *values* are validated in Node against DEVICE_CAPABILITIES; storing a
  // whitelist here would drift from it.
  deviceProfiles: defineTable({
    userExternalId: v.string(),
    profileId: v.string(),
    label: v.string(),
    description: v.string(),
    capabilities: v.array(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("byUserExternalIdAndProfileId", ["userExternalId", "profileId"]),

  gatewayProfiles: defineTable({
    userExternalId: v.string(),
    label: v.string(),
    mode: v.string(),
    url: v.string(),
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
    approvalClaimedAt: v.optional(v.string()),
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
    channel: v.optional(v.string()),
    hardwareModel: v.string(),
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    mandatory: v.boolean(),
    releaseNotes: v.string(),
    artifactKey: v.optional(v.string()),
    artifactProvider: v.optional(v.string()),
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
