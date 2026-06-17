import { createHash, randomBytes } from "node:crypto";

import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_FUNCTIONS = {
  ensureUser: { type: "mutation", name: "gatewayStore:ensureUser" },
  getUserPrivacySettings: { type: "query", name: "gatewayStore:getUserPrivacySettings" },
  updateUserPrivacySettings: { type: "mutation", name: "gatewayStore:updateUserPrivacySettings" },
  createUserToken: { type: "mutation", name: "gatewayStore:createUserToken" },
  authenticateUserToken: { type: "mutation", name: "gatewayStore:authenticateUserToken" },
  createDevice: { type: "mutation", name: "gatewayStore:createDevice" },
  preprovisionDevice: { type: "mutation", name: "gatewayStore:preprovisionDevice" },
  claimDevice: { type: "mutation", name: "gatewayStore:claimDevice" },
  revokeDevice: { type: "mutation", name: "gatewayStore:revokeDevice" },
  rotateDeviceSecret: { type: "mutation", name: "gatewayStore:rotateDeviceSecret" },
  updateDeviceProfile: { type: "mutation", name: "gatewayStore:updateDeviceProfile" },
  resetDeviceForTransfer: { type: "mutation", name: "gatewayStore:resetDeviceForTransfer" },
  rotateUnclaimedDeviceClaimCode: { type: "mutation", name: "gatewayStore:rotateUnclaimedDeviceClaimCode" },
  authenticateDevice: { type: "mutation", name: "gatewayStore:authenticateDevice" },
  recordDeviceHeartbeat: { type: "mutation", name: "gatewayStore:recordDeviceHeartbeat" },
  listDevices: { type: "query", name: "gatewayStore:listDevices" },
  getDeviceForUser: { type: "query", name: "gatewayStore:getDeviceForUser" },
  updateDeviceConfig: { type: "mutation", name: "gatewayStore:updateDeviceConfig" },
  upsertEnvironment: { type: "mutation", name: "gatewayStore:upsertEnvironment" },
  deleteEnvironment: { type: "mutation", name: "gatewayStore:deleteEnvironment" },
  updateEnvironmentHealth: { type: "mutation", name: "gatewayStore:updateEnvironmentHealth" },
  getEnvironmentForUser: { type: "query", name: "gatewayStore:getEnvironmentForUser" },
  listEnvironments: { type: "query", name: "gatewayStore:listEnvironments" },
  createFirmwareRelease: { type: "mutation", name: "gatewayStore:createFirmwareRelease" },
  listFirmwareReleases: { type: "query", name: "gatewayStore:listFirmwareReleases" },
  getLatestFirmwareRelease: { type: "query", name: "gatewayStore:getLatestFirmwareRelease" },
  createMediaUpload: { type: "mutation", name: "gatewayStore:createMediaUpload" },
  getMediaForUser: { type: "query", name: "gatewayStore:getMediaForUser" },
  updateMediaTranscript: { type: "mutation", name: "gatewayStore:updateMediaTranscript" },
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

  function call(method, args) {
    const fn = functions[method];
    const input = { ...(args ?? {}), gatewaySecret };
    if (!fn) {
      throw new Error(`Convex Store API function mapping is missing for ${method}.`);
    }
    if (fn.type === "query") return client.query(fn.name, input);
    if (fn.type === "mutation") return client.mutation(fn.name, input);
    throw new Error(`Convex Store API function ${method} has unsupported type ${fn.type}.`);
  }

  return {
    subscribe: () => () => {},
    exportState: emptyState,
    ensureUser: (args) => call("ensureUser", args),
    getUserPrivacySettings: (userId) => call("getUserPrivacySettings", { userId }),
    updateUserPrivacySettings: (args) => call("updateUserPrivacySettings", args),
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
      });
      return { device, secret, claimCode };
    },
    claimDevice: (args) => call("claimDevice", {
      userId: args.userId,
      label: args.label,
      claimCodeHash: hashSecret(normalizeClaimCode(args.claimCode)),
    }),
    revokeDevice: (args) => call("revokeDevice", args),
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
      });
      return device ? { device, secret, claimCode } : null;
    },
    rotateUnclaimedDeviceClaimCode: async (args) => {
      const claimCode = createHumanCode();
      const device = await call("rotateUnclaimedDeviceClaimCode", {
        ...args,
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
      });
      return device ? { device, claimCode } : null;
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
