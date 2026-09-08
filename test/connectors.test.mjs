import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("connector enrollment creates a separate tokenless environment credential realm", async (t) => {
  const store = createMemoryStore();
  const transportCalls = [];
  const connectorTransport = {
    async snapshot(environment) {
      transportCalls.push({ method: "snapshot", environment });
      return { projects: [{ id: "project_1" }], threads: [] };
    },
  };
  const { server } = createApp({
    store,
    t3TransportResolver: { forEnvironment: () => connectorTransport },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const minted = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Studio Mac" },
  });

  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST",
    body: {
      code: minted.code,
      protocolVersion: 1,
      connectorVersion: "0.1.0",
      platform: "darwin-arm64",
      capabilities: ["snapshot", "dispatch"],
    },
  });
  assert.equal(enrolled.session.status, "completed");
  assert.equal(enrolled.environment.transportMode, "connector");
  assert.equal(enrolled.environment.baseUrl, null);
  assert.equal(enrolled.environment.accessToken, undefined);
  assert.equal(enrolled.environment.connectorId, enrolled.connector.id);
  assert.deepEqual(enrolled.environment.scopes, ["orchestration:read", "orchestration:operate"]);
  assert.deepEqual(enrolled.connector.scopes, ["connector:connect", "t3:proxy"]);
  assert.ok(enrolled.secret.length >= 32);

  const state = store.exportState();
  assert.equal(state.connectors[0].secretHash.length, 64);
  assert.equal(JSON.stringify(state).includes(enrolled.secret), false, "standing secret must only be returned once");
  assert.equal("accessToken" in state.environments[0], false, "connector mode must not persist T3 tokens");

  const ticket = await requestJson(fetch, baseUrl, "/v1/connectors/ticket", {
    method: "POST",
    headers: { authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` },
  });
  assert.ok(ticket.ticket.length >= 32);
  assert.ok(Date.parse(ticket.expiresAt) > Date.now());
  assert.equal(JSON.stringify(store.exportState()).includes(ticket.ticket), false, "socket ticket must be hashed at rest");

  const listed = await requestJson(fetch, baseUrl, "/v1/connectors", { headers: authHeaders });
  assert.equal(listed.connectors.length, 1);
  assert.equal(listed.connectors[0].secretHash, undefined);
  assert.equal(listed.connectors[0].secretPrefix, enrolled.connector.secretPrefix);

  const snapshot = await requestJson(fetch, baseUrl, `/v1/t3/environments/${enrolled.environment.id}/snapshot`, {
    headers: authHeaders,
  });
  assert.deepEqual(snapshot.snapshot.projects, [{ id: "project_1" }]);
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].environment.baseUrl, null, "connector reads do not need a routable T3 URL");
});

test("connector enrollment rejects T3 credentials without consuming the code", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const minted = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: { label: "Private Mac" },
  });
  const rejected = await fetch(new URL("/v1/connectors/enroll", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code, protocolVersion: 1, accessToken: "must-stay-local" }),
  });
  assert.equal(rejected.status, 400);
  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: minted.code, protocolVersion: 1, capabilities: [] },
  });
  assert.equal(enrolled.session.status, "completed");
});

test("owners can revoke connectors and revoked credentials cannot mint tickets", async (t) => {
  const propagated = [];
  const { server } = createApp({ connectorRouter: { async revoke(input) { propagated.push(input); } } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const minted = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: {},
  });
  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: minted.code, protocolVersion: 1 },
  });
  const revoked = await requestJson(fetch, baseUrl, `/v1/connectors/${enrolled.connector.id}`, {
    method: "DELETE", headers: authHeaders,
  });
  assert.equal(revoked.connector.status, "revoked");
  assert.deepEqual(propagated, [{
    environmentId: enrolled.connector.environmentId,
    connectorId: enrolled.connector.id,
    reason: "revoked_by_user",
  }]);
  const repeated = await requestJson(fetch, baseUrl, `/v1/connectors/${enrolled.connector.id}`, {
    method: "DELETE", headers: authHeaders,
  });
  assert.equal(repeated.connector.status, "revoked");
  assert.equal(propagated.length, 2);
  const missing = await fetch(new URL("/v1/connectors/not_owned", baseUrl), { method: "DELETE", headers: authHeaders });
  assert.equal(missing.status, 404);
  assert.equal(propagated.length, 2);
  const denied = await fetch(new URL("/v1/connectors/ticket", baseUrl), {
    method: "POST",
    headers: { authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` },
  });
  assert.equal(denied.status, 401);
});

test("connector self-revocation is credential-scoped, terminalizes tickets, and safely retries edge closure", async (t) => {
  const store = createMemoryStore();
  let edgeAttempts = 0;
  const propagated = [];
  const { server } = createApp({
    store,
    connectorRouter: {
      async revoke(input) {
        propagated.push(input);
        edgeAttempts += 1;
        if (edgeAttempts === 1) throw Object.assign(new Error("edge unavailable"), { status: 502 });
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const session = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", { method: "POST", headers: authHeaders, body: {} });
  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", { method: "POST", body: { code: session.code, protocolVersion: 1 } });
  const connectorHeaders = { authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` };
  const ticket = await requestJson(fetch, baseUrl, "/v1/connectors/ticket", { method: "POST", headers: connectorHeaders });

  const incomplete = await fetch(new URL("/v1/connectors/self/revoke", baseUrl), { method: "POST", headers: connectorHeaders });
  assert.equal(incomplete.status, 502);
  assert.equal((await store.consumeConnectorTicket({ ticket: ticket.ticket })).reason, "used");
  assert.equal(await store.authenticateConnector(enrolled.connector.id, enrolled.secret), null);

  const retried = await requestJson(fetch, baseUrl, "/v1/connectors/self/revoke", { method: "POST", headers: connectorHeaders });
  assert.equal(retried.connector.status, "revoked");
  assert.equal(propagated.length, 2);
  assert.deepEqual(propagated[1], {
    environmentId: enrolled.connector.environmentId,
    connectorId: enrolled.connector.id,
    reason: "revoked_by_connector",
  });
  const wrongRealm = await fetch(new URL("/v1/connectors/self/revoke", baseUrl), { method: "POST", headers: authHeaders });
  assert.equal(wrongRealm.status, 401);
  const state = store.exportState();
  assert.equal(JSON.stringify(state).includes(enrolled.secret), false);
  assert.equal(state.auditLogs.at(-1).actorType, "connector");
  assert.deepEqual(state.auditLogs.at(-1).metadata, { reason: "revoked_by_connector" });
});

test("revocation remains durable and retryable when live-session propagation fails", async (t) => {
  let fail = true;
  const { server } = createApp({
    connectorRouter: {
      async revoke() {
        if (fail) throw Object.assign(new Error("private detail"), { status: 503 });
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const minted = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", { method: "POST", headers: authHeaders, body: {} });
  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", { method: "POST", body: { code: minted.code, protocolVersion: 1 } });
  const failed = await fetch(new URL(`/v1/connectors/${enrolled.connector.id}`, baseUrl), { method: "DELETE", headers: authHeaders });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private detail/u);
  const denied = await fetch(new URL("/v1/connectors/ticket", baseUrl), {
    method: "POST",
    headers: { authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` },
  });
  assert.equal(denied.status, 401);
  fail = false;
  const retried = await requestJson(fetch, baseUrl, `/v1/connectors/${enrolled.connector.id}`, { method: "DELETE", headers: authHeaders });
  assert.equal(retried.connector.status, "revoked");
});

test("re-enrollment closes the old edge session before returning a replacement credential", async (t) => {
  const store = createMemoryStore();
  const propagated = [];
  const { server } = createApp({
    store,
    connectorRouter: {
      async revoke(input) {
        const current = await store.getConnectorForUser("user_test", input.connectorId);
        assert.notEqual(current?.status, "revoked", "edge closes before Store credential replacement");
        propagated.push(input);
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const firstSession = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: { label: "Studio Mac" },
  });
  const first = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: firstSession.code, protocolVersion: 1 },
  });
  const replacementSession = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { environmentId: first.environment.id, label: "Studio Mac" },
  });
  const replacement = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: replacementSession.code, protocolVersion: 1 },
  });

  assert.notEqual(replacement.connector.id, first.connector.id);
  assert.deepEqual(propagated, [{
    environmentId: first.environment.id,
    connectorId: first.connector.id,
    reason: "superseded_by_reenrollment",
  }]);
  assert.equal((await store.getConnectorForUser("user_test", first.connector.id)).status, "revoked");
  const denied = await fetch(new URL("/v1/connectors/ticket", baseUrl), {
    method: "POST",
    headers: { authorization: `Connector ${first.connector.id}.${first.secret}` },
  });
  assert.equal(denied.status, 401);
});

test("failed re-enrollment propagation does not revoke the old connector or mint a replacement", async (t) => {
  const store = createMemoryStore();
  let failPropagation = false;
  const { server } = createApp({
    store,
    connectorRouter: {
      async revoke() {
        if (failPropagation) throw Object.assign(new Error("private router detail"), { status: 503 });
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const firstSession = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: {},
  });
  const first = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", {
    method: "POST", body: { code: firstSession.code, protocolVersion: 1 },
  });
  const replacementSession = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: { environmentId: first.environment.id },
  });
  failPropagation = true;
  const failed = await fetch(new URL("/v1/connectors/enroll", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: replacementSession.code, protocolVersion: 1 }),
  });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private router detail/u);
  assert.notEqual((await store.getConnectorForUser("user_test", first.connector.id)).status, "revoked");
  assert.equal((await store.listConnectors("user_test")).length, 1);
  const stillValid = await fetch(new URL("/v1/connectors/ticket", baseUrl), {
    method: "POST",
    headers: { authorization: `Connector ${first.connector.id}.${first.secret}` },
  });
  assert.equal(stillValid.status, 201);
});

test("credential rotation overlaps until the staged ticket commits and then retires the old generation", async () => {
  const store = createMemoryStore();
  const environment = await store.upsertEnvironment({
    userId: "user_1", label: "Studio Mac", transportMode: "connector", scopes: [], status: "paired",
  });
  const enrolled = await store.createConnector({
    userId: "user_1", environmentId: environment.id, scopes: ["connector:connect"], protocolVersion: 1, capabilities: [],
  });
  const oldTicket = await store.createConnectorTicket({ connectorId: enrolled.connector.id, credentialVersion: 1 });
  const rotation = await store.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });

  const oldAuthDuringOverlap = await store.authenticateConnector(enrolled.connector.id, enrolled.secret);
  const pendingAuth = await store.authenticateConnector(enrolled.connector.id, rotation.secret);
  assert.equal(oldAuthDuringOverlap.credentialState, "active");
  assert.equal(pendingAuth.credentialState, "pending");
  assert.equal(pendingAuth.authenticatedCredentialVersion, 2);

  const pendingTicket = await store.createConnectorTicket({
    connectorId: enrolled.connector.id,
    credentialVersion: pendingAuth.authenticatedCredentialVersion,
    rotationId: pendingAuth.authenticatedRotationId,
  });
  const committed = await store.consumeConnectorTicket({ ticket: pendingTicket.ticket });
  assert.equal(committed.connector.credentialState, "rotated");
  assert.equal(committed.connector.credentialVersion, 2);
  assert.equal(await store.authenticateConnector(enrolled.connector.id, enrolled.secret), null);
  assert.equal((await store.authenticateConnector(enrolled.connector.id, rotation.secret)).credentialState, "active");
  assert.equal((await store.consumeConnectorTicket({ ticket: oldTicket.ticket })).reason, "used");

  const exported = JSON.stringify(store.exportState());
  assert.equal(exported.includes(enrolled.secret), false);
  assert.equal(exported.includes(rotation.secret), false);
});

test("a replaced or expired staged rotation cannot reuse its credential generation", async () => {
  const store = createMemoryStore();
  const environment = await store.upsertEnvironment({ userId: "user_1", label: "Studio", transportMode: "connector", scopes: [], status: "paired" });
  const enrolled = await store.createConnector({ userId: "user_1", environmentId: environment.id, scopes: [], protocolVersion: 1, capabilities: [] });
  const first = await store.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });
  const firstAuth = await store.authenticateConnector(enrolled.connector.id, first.secret);
  const second = await store.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });

  assert.equal(await store.authenticateConnector(enrolled.connector.id, first.secret), null);
  assert.equal(await store.createConnectorTicket({
    connectorId: enrolled.connector.id,
    credentialVersion: firstAuth.authenticatedCredentialVersion,
    rotationId: firstAuth.authenticatedRotationId,
  }), null);
  assert.equal((await store.authenticateConnector(enrolled.connector.id, enrolled.secret)).credentialState, "active");
  assert.equal((await store.authenticateConnector(enrolled.connector.id, second.secret)).credentialState, "pending");

  const expired = await store.beginConnectorCredentialRotation({
    userId: "user_1", connectorId: enrolled.connector.id, expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(await store.authenticateConnector(enrolled.connector.id, expired.secret), null);
  assert.equal((await store.authenticateConnector(enrolled.connector.id, enrolled.secret)).credentialState, "active");
});

test("revocation immediately clears both sides of an in-progress rotation", async () => {
  const store = createMemoryStore();
  const environment = await store.upsertEnvironment({ userId: "user_1", label: "Studio", transportMode: "connector", scopes: [], status: "paired" });
  const enrolled = await store.createConnector({ userId: "user_1", environmentId: environment.id, scopes: [], protocolVersion: 1, capabilities: [] });
  const rotation = await store.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });
  const pending = await store.authenticateConnector(enrolled.connector.id, rotation.secret);
  const pendingTicket = await store.createConnectorTicket({
    connectorId: enrolled.connector.id,
    credentialVersion: pending.authenticatedCredentialVersion,
    rotationId: pending.authenticatedRotationId,
  });
  const revoked = await store.revokeConnector({ userId: "user_1", connectorId: enrolled.connector.id });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.rotationPending, false);
  assert.equal(await store.authenticateConnector(enrolled.connector.id, enrolled.secret), null);
  assert.equal(await store.authenticateConnector(enrolled.connector.id, rotation.secret), null);
  assert.equal((await store.consumeConnectorTicket({ ticket: pendingTicket.ticket })).reason, "used");
});

test("rotation HTTP ceremony keeps one connector id and old auth cannot mint after socket-ticket acknowledgement", async (t) => {
  const store = createMemoryStore();
  const routerCalls = [];
  const { server } = createApp({ store, connectorRouter: { async revoke(input) { routerCalls.push(input); } } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);
  const enrollment = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", { method: "POST", headers: authHeaders, body: {} });
  const enrolled = await requestJson(fetch, baseUrl, "/v1/connectors/enroll", { method: "POST", body: { code: enrollment.code, protocolVersion: 1 } });
  const authorization = { authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` };
  const unrelated = await requestJson(fetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST", headers: authHeaders, body: { environmentId: enrolled.connector.environmentId },
  });
  const crossPurpose = await fetch(new URL(`/v1/connectors/${enrolled.connector.id}/rotate`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authorization },
    body: JSON.stringify({ code: unrelated.code }),
  });
  assert.equal(crossPurpose.status, 403);
  const ceremony = await requestJson(fetch, baseUrl, `/v1/connectors/${enrolled.connector.id}/rotation-sessions`, {
    method: "POST", headers: authHeaders, body: {},
  });
  assert.equal(ceremony.session.purpose, "connector_rotation");
  assert.match(ceremony.command, /connector rotate/u);
  assert.match(ceremony.command, /--yes/u);
  assert.equal(ceremony.command.includes(enrolled.secret), false);
  const rotated = await requestJson(fetch, baseUrl, `/v1/connectors/${enrolled.connector.id}/rotate`, {
    method: "POST", headers: authorization, body: { code: ceremony.code },
  });
  assert.equal(rotated.connector.id, enrolled.connector.id);
  assert.equal(rotated.connector.rotationPending, true);
  assert.deepEqual(routerCalls, []);

  const oldOverlap = await fetch(new URL("/v1/connectors/ticket", baseUrl), { method: "POST", headers: authorization });
  assert.equal(oldOverlap.status, 201);
  const pendingTicket = await requestJson(fetch, baseUrl, "/v1/connectors/ticket", {
    method: "POST", headers: { authorization: `Connector ${enrolled.connector.id}.${rotated.secret}` }, body: {},
  });
  const committed = await store.consumeConnectorTicket({ ticket: pendingTicket.ticket });
  assert.equal(committed.connector.credentialState, "rotated");

  const retired = await fetch(new URL("/v1/connectors/ticket", baseUrl), { method: "POST", headers: authorization });
  assert.equal(retired.status, 401);
  const current = await fetch(new URL("/v1/connectors/ticket", baseUrl), {
    method: "POST", headers: { authorization: `Connector ${enrolled.connector.id}.${rotated.secret}` },
  });
  assert.equal(current.status, 201);
});

test("file store persists only connector and ticket hashes and ticket consumption is single-use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-controller-connectors-"));
  const file = join(directory, "store.json");
  const first = await createFileStore(file);
  const environment = await first.upsertEnvironment({
    userId: "user_1",
    label: "Studio Mac",
    transportMode: "connector",
    scopes: ["orchestration:read"],
    status: "paired",
  });
  const enrolled = await first.createConnector({
    userId: "user_1",
    environmentId: environment.id,
    scopes: ["orchestration:read"],
    protocolVersion: 1,
    capabilities: ["snapshot"],
  });
  const minted = await first.createConnectorTicket({ connectorId: enrolled.connector.id });
  await first.flush();
  const persisted = await readFile(file, "utf8");
  assert.equal(persisted.includes(enrolled.secret), false);
  assert.equal(persisted.includes(minted.ticket), false);

  const second = await createFileStore(file);
  assert.equal((await second.authenticateConnector(enrolled.connector.id, enrolled.secret)).id, enrolled.connector.id);
  const consumed = await second.consumeConnectorTicket({ ticket: minted.ticket });
  assert.equal(consumed.connector.id, enrolled.connector.id);
  assert.equal(consumed.ticket.environmentId, environment.id);
  assert.equal((await second.consumeConnectorTicket({ ticket: minted.ticket })).reason, "used");

  const rotation = await second.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });
  const pendingAuth = await second.authenticateConnector(enrolled.connector.id, rotation.secret);
  const pendingTicket = await second.createConnectorTicket({
    connectorId: enrolled.connector.id,
    credentialVersion: pendingAuth.authenticatedCredentialVersion,
    rotationId: pendingAuth.authenticatedRotationId,
  });
  await second.flush();
  const third = await createFileStore(file);
  assert.equal((await third.authenticateConnector(enrolled.connector.id, enrolled.secret)).credentialState, "active");
  assert.equal((await third.authenticateConnector(enrolled.connector.id, rotation.secret)).credentialState, "pending");
  assert.equal((await third.consumeConnectorTicket({ ticket: pendingTicket.ticket })).connector.credentialState, "rotated");
  assert.equal(await third.authenticateConnector(enrolled.connector.id, enrolled.secret), null);
});

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

async function createAuthHeaders(fetchImpl, baseUrl, userId = "user_test") {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST", body: { userId, email: `${userId}@example.local` },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}
