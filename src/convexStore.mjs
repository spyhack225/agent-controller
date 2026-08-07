import { createHash, randomBytes } from "node:crypto";

import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_FUNCTIONS = {
  ensureUser: { type: "mutation", name: "gatewayStore:ensureUser" },
  getUserPrivacySettings: { type: "query", name: "gatewayStore:getUserPrivacySettings" },
  updateUserPrivacySettings: { type: "mutation", name: "gatewayStore:updateUserPrivacySettings" },
  getUserSubscription: { type: "query", name: "gatewayStore:getUserSubscription" },
  updateUserSubscription: { type: "mutation", name: "gatewayStore:updateUserSubscription" },
  getUserOnboarding: { type: "query", name: "gatewayStore:getUserOnboarding" },
  updateUserOnboarding: { type: "mutation", name: "gatewayStore:updateUserOnboarding" },
  createUserToken: { type: "mutation", name: "gatewayStore:createUserToken" },
  authenticateUserToken: { type: "mutation", name: "gatewayStore:authenticateUserToken" },
  createDevice: { type: "mutation", name: "gatewayStore:createDevice" },
  preprovisionDevice: { type: "mutation", name: "gatewayStore:preprovisionDevice" },
  claimDevice: { type: "mutation", name: "gatewayStore:claimDevice" },
  revokeDevice: { type: "mutation", name: "gatewayStore:revokeDevice" },
  deleteDevice: { type: "mutation", name: "gatewayStore:deleteDevice" },
  rotateDeviceSecret: { type: "mutation", name: "gatewayStore:rotateDeviceSecret" },
  updateDeviceProfile: { type: "mutation", name: "gatewayStore:updateDeviceProfile" },
  resetDeviceForTransfer: { type: "mutation", name: "gatewayStore:resetDeviceForTransfer" },
  ensureUnclaimedDeviceClaimCode: { type: "mutation", name: "gatewayStore:ensureUnclaimedDeviceClaimCode" },
  authenticateDevice: { type: "mutation", name: "gatewayStore:authenticateDevice" },
  recordDeviceHeartbeat: { type: "mutation", name: "gatewayStore:recordDeviceHeartbeat" },
  listDevices: { type: "query", name: "gatewayStore:listDevices" },
  getDeviceForUser: { type: "query", name: "gatewayStore:getDeviceForUser" },
  updateDeviceConfig: { type: "mutation", name: "gatewayStore:updateDeviceConfig" },
  upsertEnvironment: { type: "mutation", name: "gatewayStore:upsertEnvironment" },
  deleteEnvironment: { type: "mutation", name: "gatewayStore:deleteEnvironment" },
  updateEnvironmentHealth: { type: "mutation", name: "gatewayStore:updateEnvironmentHealth" },
  updateEnvironmentCatalogue: { type: "mutation", name: "gatewayStore:updateEnvironmentCatalogue" },
  getEnvironmentForUser: { type: "query", name: "gatewayStore:getEnvironmentForUser" },
  listEnvironments: { type: "query", name: "gatewayStore:listEnvironments" },
  createFirmwareRelease: { type: "mutation", name: "gatewayStore:createFirmwareRelease" },
  listFirmwareReleases: { type: "query", name: "gatewayStore:listFirmwareReleases" },
  getLatestFirmwareRelease: { type: "query", name: "gatewayStore:getLatestFirmwareRelease" },
  createMediaUpload: { type: "mutation", name: "gatewayStore:createMediaUpload" },
  getMediaForUser: { type: "query", name: "gatewayStore:getMediaForUser" },
  updateMediaTranscript: { type: "mutation", name: "gatewayStore:updateMediaTranscript" },
  updateMediaDescription: { type: "mutation", name: "gatewayStore:updateMediaDescription" },
  createDeviceProfile: { type: "mutation", name: "gatewayStore:createDeviceProfile" },
  listUserDeviceProfiles: { type: "query", name: "gatewayStore:listDeviceProfiles" },
  // Named to avoid colliding with updateDeviceProfile, which assigns a profile to a device.
  updateDeviceProfileDefinition: { type: "mutation", name: "gatewayStore:updateDeviceProfileDefinition" },
  deleteDeviceProfile: { type: "mutation", name: "gatewayStore:deleteDeviceProfile" },
  updateMediaProcessing: { type: "mutation", name: "gatewayStore:updateMediaProcessing" },
  listMediaUploads: { type: "query", name: "gatewayStore:listMediaUploads" },
  listExpiredMediaUploads: { type: "query", name: "gatewayStore:listExpiredMediaUploads" },
  deleteMediaUpload: { type: "mutation", name: "gatewayStore:deleteMediaUpload" },
  createMacro: { type: "mutation", name: "gatewayStore:createMacro" },
  getMacroForUser: { type: "query", name: "gatewayStore:getMacroForUser" },
  listMacros: { type: "query", name: "gatewayStore:listMacros" },
  deleteMacro: { type: "mutation", name: "gatewayStore:deleteMacro" },
  createCommand: { type: "mutation", name: "gatewayStore:createCommand" },
  getCommandForUser: { type: "query", name: "gatewayStore:getCommandForUser" },
  updateCommand: { type: "mutation", name: "gatewayStore:updateCommand" },
  listCommands: { type: "query", name: "gatewayStore:listCommands" },
  listCommandEvents: { type: "query", name: "gatewayStore:listCommandEvents" },
  listAuditLogs: { type: "query", name: "gatewayStore:listAuditLogs" },
};

export async function createConvexStore(config = {}, options = {}) {
  if (!config.convexUrl) {
    throw new Error("CONVEX_URL is required when STORAGE_PROVIDER=convex.");
  }
  const gatewaySecret = options.gatewaySecret ?? config.convexGatewaySecret;
  if (!gatewaySecret) {
    throw new Error("GATEWAY_CONVEX_SECRET is required when STORAGE_PROVIDER=convex.");
  }

  const client = options.client ?? await createConvexHttpClient(config.convexUrl, options);
  return createConvexStoreAdapter({
    client,
    functions: options.functions ?? DEFAULT_FUNCTIONS,
    gatewaySecret,
    t3TokenEncryptionKey: options.t3TokenEncryptionKey ?? config.t3TokenEncryptionKey ?? gatewaySecret,
  });
}

export function createConvexStoreAdapter({
  client,
  functions = DEFAULT_FUNCTIONS,
  gatewaySecret = null,
  t3TokenEncryptionKey = null,
}) {
  if (!client || typeof client.query !== "function" || typeof client.mutation !== "function") {
    throw new Error("Convex store adapter requires a client with query() and mutation() methods.");
  }
  if (!gatewaySecret) {
    throw new Error("Convex store adapter requires a gatewaySecret.");
  }
  const t3TokenBox = createSecretBox(t3TokenEncryptionKey);
  const listeners = new Set();

  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A broken subscriber must never fail the store write that triggered it.
      }
    }
  }

  async function call(method, args) {
    const fn = functions[method];
    const input = { ...(args ?? {}), gatewaySecret };
    if (!fn) {
      throw new Error(`Convex Store API function mapping is missing for ${method}.`);
    }
    if (fn.type === "query") return client.query(fn.name, input);
    if (fn.type === "mutation") {
      const result = await client.mutation(fn.name, input);
      // Convex holds the state, so there is no local store to diff. Emitting the affected user
      // on every mutation is what keeps live dashboard updates working under STORAGE_PROVIDER=convex.
      const userId = affectedUserId(args, result);
      if (userId) notify({ userId, action: method });
      return result;
    }
    throw new Error(`Convex Store API function ${method} has unsupported type ${fn.type}.`);
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportState: emptyState,
    ensureUser: (args) => call("ensureUser", args),
    getUserPrivacySettings: (userId) => call("getUserPrivacySettings", { userId }),
    updateUserPrivacySettings: (args) => call("updateUserPrivacySettings", args),
    getUserSubscription: (userId) => call("getUserSubscription", { userId }),
    updateUserSubscription: (args) => call("updateUserSubscription", args),
    getUserOnboarding: (userId) => call("getUserOnboarding", { userId }),
    updateUserOnboarding: (args) => call("updateUserOnboarding", args),
    createUserToken: async (args) => {
      const secret = createSecret();
      const token = await call("createUserToken", {
        ...args,
        tokenHash: hashSecret(secret),
      });
      return { token, secret };
    },
    authenticateUserToken: (secret) => call("authenticateUserToken", {
      tokenHash: hashSecret(secret),
    }),
    createDevice: async (args) => {
      const secret = createSecret();
      const device = await call("createDevice", {
        ...args,
        secretHash: hashSecret(secret),
      });
      return { device, secret };
    },
    preprovisionDevice: async (args) => {
      const secret = createSecret();
      const claimCode = createHumanCode();
      const device = await call("preprovisionDevice", {
        ...args,
        secretHash: hashSecret(secret),
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
        claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      });
      return { device, secret, claimCode };
    },
    claimDevice: (args) => call("claimDevice", {
      userId: args.userId,
      label: args.label,
      claimCodeHash: hashSecret(normalizeClaimCode(args.claimCode)),
    }),
    revokeDevice: (args) => call("revokeDevice", args),
    deleteDevice: (args) => call("deleteDevice", args),
    updateDeviceProfile: (args) => call("updateDeviceProfile", args),
    rotateDeviceSecret: async (args) => {
      const secret = createSecret();
      const device = await call("rotateDeviceSecret", {
        ...args,
        secretHash: hashSecret(secret),
      });
      return device ? { device, secret } : null;
    },
    resetDeviceForTransfer: async (args) => {
      const secret = createSecret();
      const claimCode = createHumanCode();
      const device = await call("resetDeviceForTransfer", {
        ...args,
        secretHash: hashSecret(secret),
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
        claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      });
      return device ? { device, secret, claimCode } : null;
    },
    // The candidate code is minted here and only its hash crosses to Convex, matching
    // `preprovisionDevice`. Convex decides whether the existing code is still live; when it is, it
    // ignores the candidate and reports `rotated: false`, so the plaintext is discarded unused.
    ensureUnclaimedDeviceClaimCode: async ({ deviceId, rotate = false }) => {
      const claimCode = createHumanCode();
      const result = await call("ensureUnclaimedDeviceClaimCode", {
        deviceId,
        rotate,
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
        claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      });
      if (!result) return null;
      return {
        device: result.device,
        claimCode: result.rotated ? claimCode : null,
        rotated: result.rotated,
        claimCodeExpiresAt: result.device?.claimCodeExpiresAt ?? null,
      };
    },
    authenticateDevice: (deviceId, secret) => call("authenticateDevice", {
      deviceId,
      secretHash: hashSecret(secret),
    }),
    recordDeviceHeartbeat: (args) => call("recordDeviceHeartbeat", args),
    listDevices: (userId) => call("listDevices", { userId }),
    getDeviceForUser: (userId, deviceId) => call("getDeviceForUser", { userId, deviceId }),
    updateDeviceConfig: (args) => call("updateDeviceConfig", args),
    upsertEnvironment: (args) => call("upsertEnvironment", {
      ...args,
      accessToken: t3TokenBox.seal(args.accessToken),
    }),
    deleteEnvironment: (args) => call("deleteEnvironment", args),
    updateEnvironmentHealth: (args) => call("updateEnvironmentHealth", args),
    updateEnvironmentCatalogue: (args) => call("updateEnvironmentCatalogue", args),
    getEnvironmentForUser: async (userId, environmentId) => {
      const environment = await call("getEnvironmentForUser", { userId, environmentId });
      if (!environment) return null;
      return {
        ...environment,
        accessToken: t3TokenBox.open(environment.accessToken),
      };
    },
    listEnvironments: (userId) => call("listEnvironments", { userId }),
    createFirmwareRelease: (args) => call("createFirmwareRelease", args),
    listFirmwareReleases: (args) => call("listFirmwareReleases", args ?? {}),
    getLatestFirmwareRelease: (args) => call("getLatestFirmwareRelease", args),
    createMediaUpload: (args) => call("createMediaUpload", args),
    getMediaForUser: (userId, mediaId) => call("getMediaForUser", { userId, mediaId }),
    updateMediaTranscript: (args) => call("updateMediaTranscript", args),
    updateMediaDescription: (args) => call("updateMediaDescription", args),
    createDeviceProfile: (args) => call("createDeviceProfile", args),
    listUserDeviceProfiles: (userId) => call("listUserDeviceProfiles", { userId }),
    getUserDeviceProfile: async (userId, profileId) => {
      const profiles = await call("listUserDeviceProfiles", { userId });
      return (profiles ?? []).find((profile) => profile.profileId === profileId) ?? null;
    },
    updateDeviceProfileDefinition: (args) => call("updateDeviceProfileDefinition", args),
    deleteDeviceProfile: (args) => call("deleteDeviceProfile", args),
    updateMediaProcessing: (args) => call("updateMediaProcessing", args),
    listMediaUploads: (userId) => call("listMediaUploads", { userId }),
    listExpiredMediaUploads: (args) => call("listExpiredMediaUploads", args),
    deleteMediaUpload: (args) => call("deleteMediaUpload", args),
    createMacro: (args) => call("createMacro", args),
    getMacroForUser: (userId, macroId) => call("getMacroForUser", { userId, macroId }),
    listMacros: (userId) => call("listMacros", { userId }),
    deleteMacro: (args) => call("deleteMacro", args),
    createCommand: (args) => call("createCommand", args),
    getCommandForUser: (userId, commandId) => call("getCommandForUser", { userId, commandId }),
    updateCommand: (args) => call("updateCommand", args),
    listCommands: (userId) => call("listCommands", { userId }),
    listCommandEvents: (args) => call("listCommandEvents", args),
    listAuditLogs: (userId) => call("listAuditLogs", { userId }),
  };
}

async function createConvexHttpClient(convexUrl, options = {}) {
  const client = new ConvexHttpGatewayClient(convexUrl, options.clientOptions ?? {});
  if (options.authToken) client.setAuth(options.authToken);
  if (options.adminAuth) client.setAdminAuth(options.adminAuth);
  return client;
}

// Mutations name their owner in different places: most take it directly, device and token
// mutations only reveal it in the result.
function affectedUserId(args, result) {
  if (typeof args?.userId === "string" && args.userId) return args.userId;
  if (typeof result?.userId === "string" && result.userId) return result.userId;
  if (typeof result?.device?.userId === "string" && result.device.userId) return result.device.userId;
  if (typeof result?.user?.id === "string" && result.user.id) return result.user.id;
  if (typeof result?.id === "string" && typeof result?.email === "string") return result.id;
  return null;
}

function emptyState() {
  return {
    version: 1,
    users: [],
    apiTokens: [],
    devices: [],
    environments: [],
    firmwareReleases: [],
    mediaUploads: [],
    macros: [],
    commands: [],
    auditLogs: [],
  };
}

class ConvexHttpGatewayClient {
  constructor(address, options = {}) {
    this.address = address.replace(/\/+$/u, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.authToken = options.authToken ?? null;
    this.adminAuth = options.adminAuth ?? null;
  }

  setAuth(token) {
    this.authToken = token;
    this.adminAuth = null;
  }

  setAdminAuth(token) {
    this.adminAuth = token;
    this.authToken = null;
  }

  query(name, args = {}) {
    return this.call("query", name, args);
  }

  mutation(name, args = {}) {
    return this.call("mutation", name, args);
  }

  async call(endpoint, name, args) {
    const headers = {
      "content-type": "application/json",
      "convex-client": "agent-controller-gateway",
    };
    if (this.adminAuth) headers.authorization = `Convex ${this.adminAuth}`;
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;

    const response = await this.fetch(`${this.address}/api/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: name,
        format: "convex_encoded_json",
        args: [encodeConvexJson(args)],
      }),
    });
    if (!response.ok && response.status !== 560) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    if (payload.status === "success") return decodeConvexJson(payload.value);
    if (payload.status === "error") throw new Error(payload.errorMessage ?? "Convex function failed.");
    throw new Error(`Invalid Convex response: ${JSON.stringify(payload)}`);
  }
}

function encodeConvexJson(value) {
  if (Array.isArray(value)) return value.map(encodeConvexJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, encodeConvexJson(entryValue)]),
    );
  }
  return value;
}

function decodeConvexJson(value) {
  if (Array.isArray(value)) return value.map(decodeConvexJson);
  if (value && typeof value === "object") {
    if (typeof value.$integer === "string") return Number.parseInt(value.$integer, 10);
    if (typeof value.$float === "string") return Number.parseFloat(value.$float);
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, decodeConvexJson(entryValue)]),
    );
  }
  return value;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
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

// Mirrors CLAIM_CODE_TTL_MS in store.mjs. Kept local because convexStore.mjs deliberately does not
// import the memory store, and the expiry is computed in Node so Convex never mints a timestamp.
function claimCodeExpiryFrom(issuedAtMs) {
  return new Date(issuedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString();
}
