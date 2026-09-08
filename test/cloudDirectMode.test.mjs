import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("cloud mode hides direct redeem before code consumption or outbound fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (...args) => {
    outbound.push(args);
    throw new Error("cloud mode attempted a direct outbound fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const checks = [];
  const store = createMemoryStore();
  const { server } = createApp({
    store,
    config: cloudConfig(),
    rateLimiter: recordingRateLimiter(checks),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(originalFetch, baseUrl, "user_cloud_redeem");
  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers,
    body: { label: "Cloud Mac" },
  });

  const rejected = await originalFetch(new URL("/v1/t3/connect-sessions/redeem", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: minted.code,
      baseUrl: "http://169.254.169.254/latest/meta-data",
      pairingToken: "must-not-leave-the-machine",
    }),
  });
  assert.equal(rejected.status, 404);
  assert.equal((await rejected.json()).error.details.reason, "direct_t3_disabled");
  assert.equal(outbound.length, 0);
  assert.ok(checks.some((input) => input.key.startsWith("t3:connect-redeem:")), "redeem remains rate limited");

  // The cloud rejection happens before claimConnectSession(), so the intended connector path can
  // still redeem exactly the same one-time code.
  const enrolled = await requestJson(originalFetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST",
    body: { code: minted.code, protocolVersion: 1, capabilities: ["snapshot"] },
  });
  assert.equal(enrolled.session.status, "completed");
  assert.equal(enrolled.environment.transportMode, "connector");
  assert.equal(enrolled.environment.baseUrl, null);

  const state = store.exportState();
  assert.equal(outbound.length, 0);
  assert.equal(JSON.stringify(state).includes("must-not-leave-the-machine"), false);
  assert.equal("accessToken" in state.environments[0], false);
  assert.equal("accessTokenCiphertext" in state.environments[0], false);
});

test("cloud mode rejects direct create before parsing credentials or fetching while preserving auth and rate limits", async (t) => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (...args) => {
    outbound.push(args);
    throw new Error("cloud mode attempted a direct outbound fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const checks = [];
  const store = createMemoryStore();
  const { server } = createApp({
    store,
    config: cloudConfig(),
    rateLimiter: recordingRateLimiter(checks),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthenticated = await originalFetch(new URL("/v1/t3/environments", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://attacker.example", accessToken: "secret" }),
  });
  // Dev auth's established missing-token contract is 400 (Clerk deployments use their own 401);
  // either way, the request must fail at authentication rather than at the cloud-mode gate.
  assert.equal(unauthenticated.status, 400, "cloud gating must not bypass the platform-user realm");

  const headers = await createAuthHeaders(originalFetch, baseUrl, "user_cloud_create");
  const rejected = await originalFetch(new URL("/v1/t3/environments", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      label: "Forbidden direct host",
      baseUrl: "http://169.254.169.254/latest/meta-data",
      pairingToken: "pairing-secret",
      accessToken: "access-secret",
    }),
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.details.reason, "connector_required");
  assert.equal(outbound.length, 0);
  assert.ok(checks.some((input) => input.key.startsWith("user:write:user_cloud_create")), "create remains actor-rate-limited");
  assert.deepEqual(store.exportState().environments, []);
  assert.doesNotMatch(JSON.stringify(store.exportState()), /pairing-secret|access-secret/u);
});

test("cloud connector environments allow label edits but reject transport and credential mutation", async (t) => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (...args) => {
    outbound.push(args);
    throw new Error("cloud mode attempted a direct outbound fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const checks = [];
  const store = createMemoryStore();
  const { server } = createApp({
    store,
    config: cloudConfig(),
    rateLimiter: recordingRateLimiter(checks),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await createAuthHeaders(originalFetch, baseUrl, "user_cloud_owner");
  const stranger = await createAuthHeaders(originalFetch, baseUrl, "user_cloud_stranger");
  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: owner, body: { label: "Studio Mac" },
  });
  const enrolled = await requestJson(originalFetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: minted.code, protocolVersion: 1 },
  });
  const environmentPath = `/v1/t3/environments/${enrolled.environment.id}`;

  const notOwned = await originalFetch(new URL(environmentPath, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...stranger },
    body: JSON.stringify({ baseUrl: "https://not-owned.example", accessToken: "not-owned-token" }),
  });
  assert.equal(notOwned.status, 404, "ownership is checked before mutation-field disclosure");

  const forbidden = await originalFetch(new URL(environmentPath, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({
      transportMode: "direct",
      baseUrl: "http://169.254.169.254/latest/meta-data",
      accessToken: "cloud-must-not-store-this",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      pairingToken: "cloud-must-not-exchange-this",
      scopes: ["terminal:operate"],
    }),
  });
  assert.equal(forbidden.status, 409);
  const forbiddenBody = await forbidden.json();
  assert.equal(forbiddenBody.error.details.reason, "connector_metadata_only");
  assert.deepEqual(forbiddenBody.error.details.rejectedFields, [
    "accessToken",
    "accessTokenExpiresAt",
    "baseUrl",
    "pairingToken",
    "scopes",
    "transportMode",
  ]);
  assert.equal(outbound.length, 0);

  const renamed = await requestJson(originalFetch, baseUrl, environmentPath, {
    method: "PUT", headers: owner, body: { label: "Renamed Studio Mac" },
  });
  assert.equal(renamed.environment.label, "Renamed Studio Mac");
  assert.equal(renamed.environment.transportMode, "connector");
  assert.equal(renamed.environment.connectorId, enrolled.connector.id);
  assert.equal(renamed.environment.baseUrl, null);
  assert.deepEqual(renamed.environment.scopes, ["orchestration:read", "orchestration:operate"]);

  const persisted = store.exportState().environments[0];
  assert.equal(persisted.transportMode, "connector");
  assert.equal(persisted.connectorId, enrolled.connector.id);
  assert.equal(persisted.baseUrl, null);
  assert.equal("accessToken" in persisted, false);
  assert.equal("accessTokenCiphertext" in persisted, false);
  assert.doesNotMatch(JSON.stringify(store.exportState()), /cloud-must-not-store-this|cloud-must-not-exchange-this/u);
  assert.equal(outbound.length, 0);
  assert.ok(checks.filter((input) => input.key.startsWith("user:write:user_cloud_owner")).length >= 2);
});

test("cloud transport refuses persisted legacy direct environments before network I/O", async (t) => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (...args) => {
    outbound.push(args);
    throw new Error("cloud mode attempted a direct outbound fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = createMemoryStore();
  const legacy = await store.upsertEnvironment({
    userId: "user_legacy_cloud",
    label: "Imported legacy host",
    baseUrl: "http://169.254.169.254/latest/meta-data",
    accessToken: "legacy-token",
    scopes: ["orchestration:read"],
    status: "paired",
  });
  const { server } = createApp({ store, config: cloudConfig() });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(originalFetch, baseUrl, "user_legacy_cloud");

  const snapshot = await originalFetch(new URL(`/v1/t3/environments/${legacy.id}/snapshot`, baseUrl), { headers });
  assert.equal(snapshot.status, 409);
  assert.equal((await snapshot.json()).error.details.reason, "connector_required");
  assert.equal(outbound.length, 0);

  const edit = await originalFetch(new URL(`/v1/t3/environments/${legacy.id}`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ label: "Still direct" }),
  });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).error.details.reason, "connector_required");
  assert.equal(outbound.length, 0);
});

test("auth config declares cloud deployment mode for connector-first console behavior", async (t) => {
  const { server } = createApp({ config: cloudConfig() });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await requestJson(fetch, baseUrl, "/v1/auth/config");
  assert.equal(response.deploymentMode, "cloud");
});

function cloudConfig() {
  return loadConfig({ DEPLOYMENT_MODE: "cloud", DEMO_MODE: "1" });
}

function recordingRateLimiter(checks) {
  return {
    async check(input) {
      checks.push(input);
      return {
        allowed: true,
        limit: input.limit ?? 0,
        remaining: input.limit ?? Number.POSITIVE_INFINITY,
        resetAt: Date.now() + 60_000,
      };
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function createAuthHeaders(fetchImpl, baseUrl, userId) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    body: { userId, email: `${userId}@example.local` },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}
