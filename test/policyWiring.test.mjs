import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { classifyNetworkLocation } from "../src/networkTrust.mjs";

test("network classification stays inert until trusted ranges are configured", () => {
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(classifyNetworkLocation(req, {}), undefined);
  assert.equal(classifyNetworkLocation(req, { trustedNetworks: [] }), undefined);
  assert.equal(classifyNetworkLocation(req, { trustedNetworks: undefined }), undefined);
});

test("network classification matches exact addresses, CIDR ranges and loopback", () => {
  const from = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });

  assert.equal(classifyNetworkLocation(from("127.0.0.1"), { trustedNetworks: ["loopback"] }), "trusted");
  assert.equal(classifyNetworkLocation(from("::1"), { trustedNetworks: ["loopback"] }), "trusted");
  assert.equal(classifyNetworkLocation(from("10.1.2.3"), { trustedNetworks: ["10.0.0.0/8"] }), "trusted");
  assert.equal(classifyNetworkLocation(from("11.1.2.3"), { trustedNetworks: ["10.0.0.0/8"] }), "untrusted");
  assert.equal(classifyNetworkLocation(from("192.168.1.7"), { trustedNetworks: ["192.168.1.7"] }), "trusted");
  assert.equal(classifyNetworkLocation(from("192.168.1.8"), { trustedNetworks: ["192.168.1.7"] }), "untrusted");

  // Dual-stack sockets report IPv4 as ::ffff:x.x.x.x
  assert.equal(classifyNetworkLocation(from("::ffff:10.1.2.3"), { trustedNetworks: ["10.0.0.0/8"] }), "trusted");

  // The left-most x-forwarded-for entry is the original client.
  assert.equal(
    classifyNetworkLocation(from("172.16.0.1", { "x-forwarded-for": "10.1.2.3, 172.16.0.1" }), {
      trustedNetworks: ["10.0.0.0/8"],
    }),
    "trusted",
  );
});

test("shell input from an untrusted network is held for approval instead of dispatched", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/orchestration/dispatch") {
      dispatched += 1;
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // The test client connects from loopback, which is outside this range.
  const { server } = createApp({ config: { demoMode: false, trustedNetworks: ["10.0.0.0/8"] } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const output = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
    },
  });

  assert.equal(output.command.status, "approval_required");
  assert.equal(output.policy.dimension, "network_location");
  assert.equal(dispatched, 0, "an untrusted-origin shell command must not reach T3 unapproved");
  assert.equal(output.command.result.dimension, "network_location");
  assert.ok(output.command.result.matchedRule);
});

test("the same shell input from a trusted network dispatches normally", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/orchestration/dispatch") {
      dispatched += 1;
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false, trustedNetworks: ["loopback"] } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const output = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
    },
  });

  assert.equal(output.command.status, "dispatched");
  assert.equal(dispatched, 1);
});

test("a blocked command records which policy dimension and rule decided", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const environment = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Read only controller", profile: "read-only" },
  });

  const response = await fetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "do the thing" },
    }),
  });

  assert.equal(response.status, 403);
  const payload = await response.json();
  const command = payload.error.details.command;
  assert.equal(command.status, "blocked");
  assert.equal(command.result.dimension, "device");
  assert.equal(command.result.matchedRule, "device.profile.read-only");
  assert.match(command.result.reason, /read-only/u);
});

test("a configured global time window gates dispatch", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/orchestration/dispatch") {
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // A window that cannot contain the current local hour, whatever it is.
  const hour = new Date().getHours();
  const closedStart = (hour + 2) % 24;
  const closedEnd = (hour + 3) % 24;

  const { server } = createApp({
    config: { demoMode: false, policyAllowedHours: [closedStart, closedEnd] },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const response = await originalFetch(new URL("/v1/intents", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "after hours" },
    }),
  });

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error.details.command.result.dimension, "time_window");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}: ${text}`);
  return JSON.parse(text);
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const auth = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${auth.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
