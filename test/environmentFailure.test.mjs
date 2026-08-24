import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  classifyEnvironmentFailure,
  isRetryableEnvironmentFailure,
} from "../src/environmentFailure.mjs";

test("classifies the transport failures a T3 host can produce", () => {
  assert.equal(classifyEnvironmentFailure(fetchFailure("ECONNREFUSED")), "process_not_running");
  assert.equal(classifyEnvironmentFailure(fetchFailure("ENOTFOUND")), "network_unreachable");
  assert.equal(classifyEnvironmentFailure(fetchFailure("EAI_AGAIN")), "network_unreachable");
  assert.equal(classifyEnvironmentFailure(fetchFailure("EHOSTUNREACH")), "network_unreachable");
  assert.equal(classifyEnvironmentFailure(fetchFailure("UND_ERR_CONNECT_TIMEOUT")), "timeout");
  assert.equal(classifyEnvironmentFailure(fetchFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "tls_error");
  assert.equal(classifyEnvironmentFailure(fetchFailure("ERR_TLS_CERT_ALTNAME_INVALID")), "tls_error");
  assert.equal(classifyEnvironmentFailure(fetchFailure("CERT_HAS_EXPIRED")), "tls_error");
  assert.equal(classifyEnvironmentFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), "timeout");
  assert.equal(classifyEnvironmentFailure(Object.assign(new Error("HTTP 401."), { status: 401 })), "authentication_failed");
  assert.equal(classifyEnvironmentFailure(Object.assign(new Error("HTTP 403."), { status: 403 })), "authentication_failed");
  assert.equal(classifyEnvironmentFailure(Object.assign(new Error("HTTP 404."), { status: 404 })), "contract_incompatible");
  assert.equal(classifyEnvironmentFailure(Object.assign(new Error("HTTP 501."), { status: 501 })), "contract_incompatible");
  assert.equal(classifyEnvironmentFailure(new Error("something else entirely")), "unknown");
  assert.equal(classifyEnvironmentFailure(null), "unknown");
});

test("only the failures the owner cannot fix by waiting stop the automatic retry", () => {
  for (const reason of ["process_not_running", "network_unreachable", "timeout", "tls_error", "unknown"]) {
    assert.equal(isRetryableEnvironmentFailure(reason), true, reason);
  }
  for (const reason of ["token_expired", "authentication_failed", "contract_incompatible"]) {
    assert.equal(isRetryableEnvironmentFailure(reason), false, reason);
  }
});

test("a self-referencing cause chain cannot loop the classifier", () => {
  const error = new Error("fetch failed");
  error.cause = error;
  assert.equal(classifyEnvironmentFailure(error), "unknown");
});

const healthCheckCases = [
  {
    name: "process_not_running",
    failure: () => { throw fetchFailure("ECONNREFUSED"); },
    reason: "process_not_running",
    retryable: true,
  },
  {
    name: "network_unreachable",
    failure: () => { throw fetchFailure("ENOTFOUND"); },
    reason: "network_unreachable",
    retryable: true,
  },
  {
    name: "timeout",
    failure: () => { throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" }); },
    reason: "timeout",
    retryable: true,
  },
  {
    name: "tls_error",
    failure: () => { throw fetchFailure("DEPTH_ZERO_SELF_SIGNED_CERT"); },
    reason: "tls_error",
    retryable: true,
  },
  {
    name: "authentication_failed",
    failure: () => jsonResponse({ error: "unauthorized" }, 401),
    reason: "authentication_failed",
    retryable: false,
  },
  {
    name: "contract_incompatible from a missing endpoint",
    failure: () => jsonResponse({ error: "not found" }, 404),
    reason: "contract_incompatible",
    retryable: false,
  },
  {
    name: "contract_incompatible from an unusable snapshot shape",
    failure: () => jsonResponse({ snapshotSequence: 4 }, 200),
    reason: "contract_incompatible",
    retryable: false,
  },
  {
    name: "unknown",
    failure: () => { throw new Error("something the gateway has never seen"); },
    reason: "unknown",
    retryable: true,
  },
];

for (const scenario of healthCheckCases) {
  test(`the health check reports ${scenario.name}`, async (t) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/orchestration/snapshot") return scenario.failure();
      return jsonResponse({ error: "not found" }, 404);
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const { server } = createApp();
    await listen(server);
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
    const environmentId = await createEnvironment(originalFetch, baseUrl, authHeaders);

    const health = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/check`, {
      method: "POST",
      headers: authHeaders,
      body: {},
    });

    assert.equal(health.reason, scenario.reason);
    assert.equal(health.failure.reason, scenario.reason);
    assert.equal(health.failure.retryable, scenario.retryable);
    assert.equal(health.failure.baseUrl, "https://mock-t3.example");
    assert.equal(health.environment.status, "unreachable");
    assert.equal(health.environment.health.failureReason, scenario.reason);
    assert.equal(typeof health.error, "string");
    assert.ok(!JSON.stringify(health).includes("mock-token"));
  });
}

test("a contract failure reports the installed and supported T3 versions", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "not found" }, 404);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environmentId = await createEnvironment(originalFetch, baseUrl, authHeaders);

  const health = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });

  assert.equal(health.failure.reason, "contract_incompatible");
  assert.equal(health.failure.minimumVersion, "0.0.28");
  assert.equal(typeof health.failure.maximumTestedVersion, "string");
  assert.equal(health.failure.installedVersion, null);
});

test("a reachable environment clears the recorded failure reason", async (t) => {
  const originalFetch = globalThis.fetch;
  let reachable = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname !== "/api/orchestration/snapshot") return jsonResponse({ error: "not found" }, 404);
    if (!reachable) throw fetchFailure("ECONNREFUSED");
    return jsonResponse({ projects: [], threads: [] }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environmentId = await createEnvironment(originalFetch, baseUrl, authHeaders);

  const down = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(down.environment.health.failureReason, "process_not_running");

  reachable = true;
  const up = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(up.reason, null);
  assert.equal(up.failure, null);
  assert.equal(up.environment.status, "reachable");
  assert.equal(up.environment.health.failureReason, null);
});

test("the snapshot route carries the failure reason to the console", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw fetchFailure("ECONNREFUSED");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environmentId = await createEnvironment(originalFetch, baseUrl, authHeaders);

  const response = await originalFetch(new URL(`/v1/t3/environments/${environmentId}/snapshot`, baseUrl), {
    headers: authHeaders,
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error.message, "T3 snapshot is unavailable.");
  assert.equal(body.error.details.reason, "process_not_running");
  assert.equal(body.error.details.failure.retryable, true);
  assert.equal(body.error.details.failure.baseUrl, "https://mock-t3.example");
  assert.equal(body.error.details.environment.health.failureReason, "process_not_running");
});

test("an expired token reaches the console as token_expired, not as a bare conflict", async (t) => {
  const originalFetch = globalThis.fetch;
  let t3Calls = 0;
  globalThis.fetch = async () => {
    t3Calls += 1;
    return jsonResponse({ projects: [], threads: [] }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environmentId = await createEnvironment(originalFetch, baseUrl, authHeaders, {
    accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
  });

  const health = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(health.reason, "token_expired");
  assert.equal(health.failure.retryable, false);
  assert.equal(health.environment.status, "token_expired");
  assert.equal(health.environment.health.failureReason, "token_expired");

  const response = await originalFetch(new URL(`/v1/t3/environments/${environmentId}/snapshot`, baseUrl), {
    headers: authHeaders,
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error.details.reason, "token_expired");
  assert.equal(body.error.details.failure.retryable, false);
  assert.equal(t3Calls, 0);
});

function fetchFailure(code) {
  // Node's fetch reports transport failures as a bare TypeError with the real code one level down.
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createEnvironment(fetchImpl, baseUrl, headers, extra = {}) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
      ...extra,
    },
  });
  return created.environment.id;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: {
      "content-type": "application/json",
      ...input.headers,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
