import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createConvexStore, createConvexStoreAdapter } from "../src/convexStore.mjs";

test("Convex store adapter maps Store API calls to configured Convex functions", async () => {
  const calls = [];
  const client = {
    query: async (name, args) => {
      calls.push({ type: "query", name, args });
      return [{ id: "dev_1" }];
    },
    mutation: async (name, args) => {
      calls.push({ type: "mutation", name, args });
      if (name === "gatewayStore:createDevice") return { id: "dev_1" };
      if (name === "gatewayStore:createUserToken") return { id: "tok_1" };
      if (name === "gatewayStore:rotateDeviceSecret") return { id: "dev_1" };
      if (name === "gatewayStore:resetDeviceForTransfer") return { id: "dev_1" };
      if (name === "gatewayStore:ensureUnclaimedDeviceClaimCode") {
        return { device: { id: "dev_1", claimed: false }, rotated: true };
      }
      if (name === "gatewayStore:updateDeviceProfile") return { id: "dev_1", profile: args.profile };
      return { ok: true };
    },
  };
  const store = createConvexStoreAdapter({ client, gatewaySecret: "gateway-secret" });

  const created = await store.createDevice({
    userId: "user_1",
    label: "Controller",
    profile: "agent-controller",
  });
  const devices = await store.listDevices("user_1");
  const authed = await store.authenticateDevice("dev_1", "secret");
  const heartbeat = await store.recordDeviceHeartbeat({
    deviceId: "dev_1",
    status: { firmwareVersion: "0.1.7", wifiRssi: -61 },
  });
  const token = await store.createUserToken({ userId: "user_1", label: "Test token" });
  const privacy = await store.updateUserPrivacySettings({
    userId: "user_1",
    privacy: { mediaRetentionDays: 7 },
  });
  const privacyRead = await store.getUserPrivacySettings("user_1");
  const environmentHealth = await store.updateEnvironmentHealth({
    userId: "user_1",
    environmentId: "env_1",
    status: "reachable",
    health: { lastCheckedAt: "2026-06-14T23:20:00.000Z" },
  });
  const command = await store.getCommandForUser("user_1", "cmd_1");
  const updatedCommand = await store.updateCommand({
    userId: "user_1",
    commandId: "cmd_1",
    status: "dispatched",
    result: { status: "accepted" },
  });
  const expiredMedia = await store.listExpiredMediaUploads({
    userId: "user_1",
    now: "2026-06-14T23:40:00.000Z",
  });
  const updatedMediaTranscript = await store.updateMediaTranscript({
    userId: "user_1",
    mediaId: "media_1",
    transcript: "Audio transcript.",
  });
  const updatedMediaProcessing = await store.updateMediaProcessing({
    userId: "user_1",
    mediaId: "media_1",
    processing: { transcriptionStatus: "processing" },
  });
  const deletedMedia = await store.deleteMediaUpload({ userId: "user_1", mediaId: "media_1" });
  const macro = await store.createMacro({
    userId: "user_1",
    label: "Run tests",
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { type: "shell_input", command: "npm test" },
  });
  const macroRead = await store.getMacroForUser("user_1", "macro_1");
  const macros = await store.listMacros("user_1");
  const deletedMacro = await store.deleteMacro({ userId: "user_1", macroId: "macro_1" });
  const transferReset = await store.resetDeviceForTransfer({
    userId: "user_1",
    deviceId: "dev_1",
    label: "Transfer controller",
  });
  const profileUpdate = await store.updateDeviceProfile({
    userId: "user_1",
    deviceId: "dev_1",
    profile: "read-only",
  });
  const commandEvents = await store.listCommandEvents({ userId: "user_1", commandId: "cmd_1" });
  const deletedEnvironment = await store.deleteEnvironment({ userId: "user_1", environmentId: "env_1" });
  const setupCode = await store.ensureUnclaimedDeviceClaimCode({ deviceId: "dev_1" });

  assert.deepEqual(created.device, { id: "dev_1" });
  assert.match(created.secret, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(devices, [{ id: "dev_1" }]);
  assert.deepEqual(authed, { ok: true });
  assert.deepEqual(heartbeat, { ok: true });
  assert.deepEqual(token.token, { id: "tok_1" });
  assert.match(token.secret, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(privacy, { ok: true });
  assert.deepEqual(privacyRead, [{ id: "dev_1" }]);
  assert.deepEqual(environmentHealth, { ok: true });
  assert.deepEqual(command, [{ id: "dev_1" }]);
  assert.deepEqual(updatedCommand, { ok: true });
  assert.deepEqual(expiredMedia, [{ id: "dev_1" }]);
  assert.deepEqual(updatedMediaTranscript, { ok: true });
  assert.deepEqual(updatedMediaProcessing, { ok: true });
  assert.deepEqual(deletedMedia, { ok: true });
  assert.deepEqual(macro, { ok: true });
  assert.deepEqual(macroRead, [{ id: "dev_1" }]);
  assert.deepEqual(macros, [{ id: "dev_1" }]);
  assert.deepEqual(deletedMacro, { ok: true });
  assert.deepEqual(transferReset.device, { id: "dev_1" });
  assert.match(transferReset.secret, /^[A-Za-z0-9_-]+$/u);
  assert.match(transferReset.claimCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);
  assert.deepEqual(profileUpdate, { id: "dev_1", profile: "read-only" });
  assert.deepEqual(commandEvents, [{ id: "dev_1" }]);
  assert.deepEqual(deletedEnvironment, { ok: true });
  assert.deepEqual(setupCode.device, { id: "dev_1", claimed: false });
  assert.match(setupCode.claimCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);

  assert.equal(calls[0].type, "mutation");
  assert.equal(calls[0].name, "gatewayStore:createDevice");
  assert.equal(calls[0].args.userId, "user_1");
  assert.equal(calls[0].args.label, "Controller");
  assert.equal(calls[0].args.profile, "agent-controller");
  assert.equal(calls[0].args.gatewaySecret, "gateway-secret");
  assert.match(calls[0].args.secretHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(calls[0].args.secretHash, created.secret);

  assert.deepEqual(calls[1], {
    type: "query",
    name: "gatewayStore:listDevices",
    args: { userId: "user_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[2], {
    type: "mutation",
    name: "gatewayStore:authenticateDevice",
    args: {
      deviceId: "dev_1",
      secretHash: sha256("secret"),
      gatewaySecret: "gateway-secret",
    },
  });

  assert.deepEqual(calls[3], {
    type: "mutation",
    name: "gatewayStore:recordDeviceHeartbeat",
    args: {
      deviceId: "dev_1",
      status: { firmwareVersion: "0.1.7", wifiRssi: -61 },
      gatewaySecret: "gateway-secret",
    },
  });

  assert.equal(calls[4].name, "gatewayStore:createUserToken");
  assert.equal(calls[4].args.userId, "user_1");
  assert.equal(calls[4].args.label, "Test token");
  assert.equal(calls[4].args.gatewaySecret, "gateway-secret");
  assert.match(calls[4].args.tokenHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(calls[4].args.tokenHash, token.secret);

  assert.deepEqual(calls[5], {
    type: "mutation",
    name: "gatewayStore:updateUserPrivacySettings",
    args: {
      userId: "user_1",
      privacy: { mediaRetentionDays: 7 },
      gatewaySecret: "gateway-secret",
    },
  });

  assert.deepEqual(calls[6], {
    type: "query",
    name: "gatewayStore:getUserPrivacySettings",
    args: { userId: "user_1", gatewaySecret: "gateway-secret" },
  });

  assert.deepEqual(calls[7], {
    type: "mutation",
    name: "gatewayStore:updateEnvironmentHealth",
    args: {
      userId: "user_1",
      environmentId: "env_1",
      status: "reachable",
      health: { lastCheckedAt: "2026-06-14T23:20:00.000Z" },
      gatewaySecret: "gateway-secret",
    },
  });

  assert.deepEqual(calls[8], {
    type: "query",
    name: "gatewayStore:getCommandForUser",
    args: { userId: "user_1", commandId: "cmd_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[9], {
    type: "mutation",
    name: "gatewayStore:updateCommand",
    args: {
      userId: "user_1",
      commandId: "cmd_1",
      status: "dispatched",
      result: { status: "accepted" },
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[10], {
    type: "query",
    name: "gatewayStore:listExpiredMediaUploads",
    args: {
      userId: "user_1",
      now: "2026-06-14T23:40:00.000Z",
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[11], {
    type: "mutation",
    name: "gatewayStore:updateMediaTranscript",
    args: {
      userId: "user_1",
      mediaId: "media_1",
      transcript: "Audio transcript.",
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[12], {
    type: "mutation",
    name: "gatewayStore:updateMediaProcessing",
    args: {
      userId: "user_1",
      mediaId: "media_1",
      processing: { transcriptionStatus: "processing" },
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[13], {
    type: "mutation",
    name: "gatewayStore:deleteMediaUpload",
    args: { userId: "user_1", mediaId: "media_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[14], {
    type: "mutation",
    name: "gatewayStore:createMacro",
    args: {
      userId: "user_1",
      label: "Run tests",
      environmentId: "env_1",
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[15], {
    type: "query",
    name: "gatewayStore:getMacroForUser",
    args: { userId: "user_1", macroId: "macro_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[16], {
    type: "query",
    name: "gatewayStore:listMacros",
    args: { userId: "user_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[17], {
    type: "mutation",
    name: "gatewayStore:deleteMacro",
    args: { userId: "user_1", macroId: "macro_1", gatewaySecret: "gateway-secret" },
  });
  assert.equal(calls[18].type, "mutation");
  assert.equal(calls[18].name, "gatewayStore:resetDeviceForTransfer");
  assert.equal(calls[18].args.userId, "user_1");
  assert.equal(calls[18].args.deviceId, "dev_1");
  assert.equal(calls[18].args.label, "Transfer controller");
  assert.equal(calls[18].args.gatewaySecret, "gateway-secret");
  assert.match(calls[18].args.secretHash, /^[a-f0-9]{64}$/u);
  assert.match(calls[18].args.claimCodeHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(calls[18].args.secretHash, transferReset.secret);
  assert.notEqual(calls[18].args.claimCodeHash, transferReset.claimCode);
  assert.deepEqual(calls[19], {
    type: "mutation",
    name: "gatewayStore:updateDeviceProfile",
    args: {
      userId: "user_1",
      deviceId: "dev_1",
      profile: "read-only",
      gatewaySecret: "gateway-secret",
    },
  });
  assert.deepEqual(calls[20], {
    type: "query",
    name: "gatewayStore:listCommandEvents",
    args: { userId: "user_1", commandId: "cmd_1", gatewaySecret: "gateway-secret" },
  });
  assert.deepEqual(calls[21], {
    type: "mutation",
    name: "gatewayStore:deleteEnvironment",
    args: { userId: "user_1", environmentId: "env_1", gatewaySecret: "gateway-secret" },
  });
  assert.equal(calls[22].type, "mutation");
  assert.equal(calls[22].name, "gatewayStore:ensureUnclaimedDeviceClaimCode");
  assert.equal(calls[22].args.deviceId, "dev_1");
  assert.equal(calls[22].args.gatewaySecret, "gateway-secret");
  assert.equal(calls[22].args.rotate, false);
  assert.match(calls[22].args.claimCodeHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(calls[22].args.claimCodeHash, setupCode.claimCode);
  // The expiry is computed in Node, like every other timestamp the adapter sends.
  assert.match(calls[22].args.claimCodeExpiresAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("Convex store requires CONVEX_URL", async () => {
  await assert.rejects(
    () => createConvexStore({}),
    /CONVEX_URL is required/u,
  );
});

test("Convex store requires a gateway service secret", async () => {
  await assert.rejects(
    () => createConvexStore({ convexUrl: "https://convex.example" }),
    /GATEWAY_CONVEX_SECRET is required/u,
  );
});

test("Convex store adapter encrypts T3 access tokens at rest", async () => {
  let storedEnvironment = null;
  const client = {
    query: async (name, args) => {
      if (name === "gatewayStore:getEnvironmentForUser") {
        return {
          id: args.environmentId,
          accessToken: storedEnvironment.accessToken,
          accessTokenExpiresAt: storedEnvironment.accessTokenExpiresAt,
        };
      }
      return null;
    },
    mutation: async (name, args) => {
      if (name === "gatewayStore:upsertEnvironment") {
        storedEnvironment = args;
        return { id: "env_1", label: args.label };
      }
      return { ok: true };
    },
  };
  const store = createConvexStoreAdapter({
    client,
    gatewaySecret: "gateway-secret",
    t3TokenEncryptionKey: "test-token-encryption-key",
  });

  await store.upsertEnvironment({
    userId: "user_1",
    label: "Encrypted T3",
    baseUrl: "https://encrypted-t3.example",
    accessToken: "raw-t3-access-token",
    accessTokenExpiresAt: "2026-06-15T00:00:00.000Z",
    scopes: ["orchestration:read"],
    status: "paired",
  });
  assert.match(storedEnvironment.accessToken, /^v1:/u);
  assert.notEqual(storedEnvironment.accessToken, "raw-t3-access-token");
  assert.equal(storedEnvironment.accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");

  const environment = await store.getEnvironmentForUser("user_1", "env_1");
  assert.equal(environment.accessToken, "raw-t3-access-token");
  assert.equal(environment.accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");
});

test("Convex store uses direct HTTP endpoints without the Convex runtime package", async () => {
  const requests = [];
  const store = await createConvexStore(
    { convexUrl: "https://convex.example", convexGatewaySecret: "gateway-secret" },
    {
      adminAuth: "deploy-token",
      clientOptions: {
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            method: init.method,
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: JSON.parse(init.body),
          });
          return jsonResponse({
            status: "success",
            value: [
              {
                id: "dev_1",
                count: { $integer: "2" },
              },
            ],
          });
        },
      },
    },
  );

  const devices = await store.listDevices("user_1");

  assert.deepEqual(devices, [{ id: "dev_1", count: 2 }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://convex.example/api/query");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, "Convex deploy-token");
  assert.equal(requests[0].headers["convex-client"], "agent-controller-gateway");
  assert.deepEqual(requests[0].body, {
    path: "gatewayStore:listDevices",
    format: "convex_encoded_json",
    args: [{ userId: "user_1", gatewaySecret: "gateway-secret" }],
  });
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
