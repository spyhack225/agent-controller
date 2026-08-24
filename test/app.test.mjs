import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("device intent endpoint authenticates device and dispatches to T3", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Test controller", profile: "agent-controller" },
  });

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Run the tests." },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(typeof dispatched.command.metrics.acknowledgementDurationMs, "number");
  assert.equal(typeof dispatched.command.metrics.dispatchDurationMs, "number");
  assert.match(dispatched.command.metrics.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(dispatched.command.metrics.failureAt, null);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].type, "thread.turn.start");
  assert.equal(dispatches[0].message.text, "Run the tests.");
});

test("failed T3 dispatches are recorded with command metrics", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatchCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatchCalls += 1;
      return jsonResponse({ error: "temporary outage" }, 503);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Failing controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Failing T3",
      baseUrl: "https://failing-t3.example",
      accessToken: "mock-token",
    },
  });

  const response = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_fail",
      intent: { type: "agent_prompt", text: "This dispatch will fail." },
    }),
  });
  const failed = await response.json();

  assert.equal(response.status, 502);
  assert.equal(dispatchCalls, 1);
  assert.equal(failed.error.details.command.status, "failed");
  assert.equal(failed.error.details.command.result.error, "t3_dispatch_failed");
  assert.match(failed.error.details.command.result.message, /HTTP 503/u);
  assert.equal(typeof failed.error.details.command.metrics.acknowledgementDurationMs, "number");
  assert.equal(typeof failed.error.details.command.metrics.dispatchDurationMs, "number");
  assert.equal(failed.error.details.command.metrics.completedAt, null);
  assert.match(failed.error.details.command.metrics.failureAt, /^\d{4}-\d{2}-\d{2}T/u);

  const events = await requestJson(originalFetch, baseUrl, `/v1/commands/${failed.error.details.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].status, "failed");
  assert.equal(events.events[0].metrics.failureAt, failed.error.details.command.metrics.failureAt);
});

test("dangerous shell input requires user approval before T3 dispatch", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Shell controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const pending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_shell",
      intent: { type: "shell_input", command: "rm -rf build" },
    },
  });

  assert.equal(pending.command.status, "approval_required");
  assert.equal(pending.command.risk, "high");
  assert.equal(pending.policy.requiresApproval, true);
  assert.equal(dispatches.length, 0);

  const pendingEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(pendingEvents.events.length, 1);
  assert.equal(pendingEvents.events[0].status, "approval_required");
  assert.equal(pendingEvents.events[0].previousStatus, null);

  const commands = await requestJson(originalFetch, baseUrl, "/v1/commands", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].id, pending.command.id);

  const approved = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/approve`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(approved.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /rm -rf build/u);

  const approvedEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(approvedEvents.events.map((event) => event.status), ["approval_required", "dispatched"]);
  assert.equal(approvedEvents.events[1].previousStatus, "approval_required");

  const secondPending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_shell",
      intent: { type: "shell_input", command: "git push origin main" },
    },
  });
  assert.equal(secondPending.command.status, "approval_required");

  const rejected = await requestJson(originalFetch, baseUrl, `/v1/commands/${secondPending.command.id}/reject`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(rejected.command.status, "rejected");
  assert.equal(dispatches.length, 1);

  const rejectedEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${secondPending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(rejectedEvents.events.map((event) => event.status), ["approval_required", "rejected"]);
});

test("claimed devices can list, approve, and reject pending commands", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Approval controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const approvePending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: deviceHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_device_approval",
      intent: { type: "shell_input", command: "rm -rf build" },
    },
  });
  const rejectPending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: deviceHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_device_approval",
      intent: { type: "shell_input", command: "git push origin main" },
    },
  });

  const approvals = await requestJson(originalFetch, baseUrl, "/v1/device/approvals", {
    method: "GET",
    headers: deviceHeaders,
  });
  assert.equal(approvals.commands.length, 2);
  assert.equal(approvals.commands[0].status, "approval_required");

  const approved = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/device/approvals/${approvePending.command.id}/approve`,
    { method: "POST", headers: deviceHeaders, body: {} },
  );
  assert.equal(approved.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /rm -rf build/u);

  const rejected = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/device/approvals/${rejectPending.command.id}/reject`,
    { method: "POST", headers: deviceHeaders, body: {} },
  );
  assert.equal(rejected.command.status, "rejected");
  assert.equal(dispatches.length, 1);
});

test("status intent returns compressed T3 state", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }, { id: "t2" }] }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Test controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const status = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      intent: { type: "status" },
    },
  });

  assert.equal(status.screen.line1, "1 projects");
  assert.equal(status.screen.line2, "2 threads");
});

test("T3 environment health checks record reachable and unreachable status", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot" && parsed.hostname === "healthy-t3.example") {
      return jsonResponse({ projects: [{ id: "p1" }, { id: "p2" }], threads: [{ id: "t1" }] }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ error: "down" }, 503);
    }
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

  const healthy = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Healthy T3",
      baseUrl: "https://healthy-t3.example",
      accessToken: "mock-token",
    },
  });
  const unhealthy = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Unhealthy T3",
      baseUrl: "https://unhealthy-t3.example",
      accessToken: "mock-token",
    },
  });

  const reachable = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${healthy.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(reachable.environment.status, "reachable");
  assert.equal(reachable.environment.health.snapshot.line1, "2 projects");
  assert.equal(reachable.environment.health.snapshot.line2, "1 threads");
  assert.equal(reachable.environment.health.lastError, null);
  assert.match(reachable.environment.health.lastCheckedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(reachable.environment.health.lastReachableAt, reachable.environment.health.lastCheckedAt);

  const unreachable = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${unhealthy.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(unreachable.environment.status, "unreachable");
  assert.match(unreachable.error, /HTTP 503/u);
  assert.match(unreachable.environment.health.lastError, /HTTP 503/u);
  assert.equal(unreachable.environment.health.lastReachableAt, null);
  // A 503 is the host answering while it cannot serve; nothing about it names a cause.
  assert.equal(unreachable.reason, "unknown");
  assert.equal(unreachable.failure.retryable, true);

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(
    environments.environments.map((environment) => environment.status).sort(),
    ["reachable", "unreachable"],
  );
});

test("T3 environment snapshot exposes projects and threads for session selection", async (t) => {
  const originalFetch = globalThis.fetch;
  const snapshots = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      snapshots.push({
        origin: parsed.origin,
        authorization: init.headers?.authorization,
      });
      return jsonResponse({
        projects: [{ id: "project_1", title: "Agent Controller" }],
        threads: [{ id: "thread_1", title: "Implementation", projectId: "project_1" }],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Snapshot T3",
      baseUrl: "https://snapshot-t3.example",
      accessToken: "snapshot-token",
    },
  });

  const snapshot = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/snapshot`,
    {
      method: "GET",
      headers: authHeaders,
    },
  );

  assert.equal(snapshot.snapshot.projects[0].id, "project_1");
  assert.equal(snapshot.snapshot.threads[0].id, "thread_1");
  assert.equal(snapshot.screen.line1, "1 projects");
  assert.equal(snapshot.screen.line2, "1 threads");
  assert.equal(snapshot.environment.status, "reachable");
  assert.equal(snapshot.environment.health.snapshot.line2, "1 threads");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].origin, "https://snapshot-t3.example");
  assert.equal(snapshots[0].authorization, "Bearer snapshot-token");
});

test("T3 compatibility checks detect version changes and persist breaking-risk alerts", async (t) => {
  const originalFetch = globalThis.fetch;
  let serverVersion = "0.0.33";
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "registry.npmjs.org") {
      return jsonResponse({ version: "0.0.33" }, 200);
    }
    if (parsed.pathname === "/.well-known/t3/environment") {
      return jsonResponse({ serverVersion }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [], threads: [] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({
    config: { demoMode: false },
    t3CompatibilityRpc: async () => ({ providers: [] }),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Compatibility T3",
      baseUrl: "https://compatibility-t3.example",
      accessToken: "compatibility-token",
    },
  });

  const first = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(first.release.latestVersion, "0.0.33");
  assert.equal(first.release.status, "review_required");
  assert.equal(first.results[0].installedVersion, "0.0.33");
  assert.equal(first.results[0].versionChanged, false);

  serverVersion = "0.0.34";
  const changed = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(changed.results[0].previousVersion, "0.0.33");
  assert.equal(changed.results[0].versionChanged, true);
  assert.equal(changed.results[0].breakingRisk, true);

  const saved = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(saved.results[0].installedVersion, "0.0.34");
  assert.equal(saved.summary.breakingRisks, 1);

  const alerts = await requestJson(originalFetch, baseUrl, "/v1/observability/alerts", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(alerts.alerts.some((alert) => alert.id === "environment.t3_compatibility_breaking"), true);
});

test("web users can launch the first T3 thread with any provider instance", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{
          id: "project_tacs",
          title: "Tacs",
          workspaceRoot: "/projects/Tacs",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        }],
        threads: [],
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Launch T3",
      baseUrl: "https://launch-t3.example",
      accessToken: "launch-token",
    },
  });

  const launched = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/threads`,
    {
      method: "POST",
      headers: authHeaders,
      body: {
        projectId: "project_tacs",
        text: "Inspect the Tacs project and report that this remote session works.",
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
      },
    },
  );

  assert.match(launched.threadId, /^thread_/u);
  assert.equal(launched.command.status, "dispatched");
  assert.deepEqual(launched.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
  });
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].type, "thread.create");
  assert.equal(dispatches[0].threadId, launched.threadId);
  assert.equal(dispatches[0].projectId, "project_tacs");
  assert.equal(dispatches[0].modelSelection.instanceId, "claudeAgent");
  assert.equal(dispatches[1].type, "thread.turn.start");
  assert.equal(dispatches[1].threadId, launched.threadId);
});

test("expired T3 access tokens are blocked before snapshot or dispatch", async (t) => {
  const originalFetch = globalThis.fetch;
  let t3Calls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "expired-t3.example") {
      t3Calls += 1;
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Expired token controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Expired T3",
      baseUrl: "https://expired-t3.example",
      accessToken: "expired-token",
      accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
    },
  });
  assert.equal(environment.environment.accessTokenExpiresAt, "2000-01-01T00:00:00.000Z");

  const health = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(health.environment.status, "token_expired");
  assert.match(health.error, /expired/u);
  assert.equal(health.reason, "token_expired");
  assert.equal(health.failure.retryable, false);

  const snapshot = await originalFetch(new URL(`/v1/t3/environments/${environment.environment.id}/snapshot`, baseUrl), {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(snapshot.status, 409);

  const dispatch = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_expired",
      intent: { type: "agent_prompt", text: "This should not dispatch." },
    }),
  });
  const dispatchBody = await dispatch.json();
  assert.equal(dispatch.status, 409);
  assert.equal(dispatchBody.error.details.command.status, "blocked");
  assert.equal(t3Calls, 0);
});

test("T3 environments can be updated and removed", async (t) => {
  const originalFetch = globalThis.fetch;
  const snapshots = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      snapshots.push({
        origin: parsed.origin,
        authorization: init.headers?.authorization,
      });
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Environment controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Old T3",
      baseUrl: "https://old-t3.example",
      accessToken: "old-token",
    },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_env",
    },
  });

  const updated = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      label: "Updated T3",
      baseUrl: "https://new-t3.example",
      accessToken: "new-token",
    },
  });
  assert.equal(updated.environment.id, environment.environment.id);
  assert.equal(updated.environment.label, "Updated T3");
  assert.equal(updated.environment.baseUrl, "https://new-t3.example");
  assert.equal(updated.environment.accessToken, undefined);

  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.deepEqual(snapshots.at(-1), {
    origin: "https://new-t3.example",
    authorization: "Bearer new-token",
  });

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}`, {
    method: "DELETE",
    headers: authHeaders,
    body: {},
  });
  assert.equal(deleted.environment.id, environment.environment.id);

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(environments.environments, []);

  const config = await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(config.config.environmentId, null);
});

test("device can upload image media and reference it in a camera prompt", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Camera controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/device/media", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("not-really-a-png").toString("base64"),
      originalName: "snapshot.png",
    },
  });

  assert.equal(mediaUpload.media.kind, "image");
  assert.equal(mediaUpload.media.storagePath, undefined);
  assert.equal(mediaUpload.media.sizeBytes, 16);

  const fetchedMedia = await originalFetch(new URL(`/v1/media/${mediaUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(fetchedMedia.status, 200);
  assert.equal(fetchedMedia.headers.get("content-type"), "image/png");
  assert.equal(await fetchedMedia.text(), "not-really-a-png");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: {
        type: "camera_prompt",
        mediaUploadId: mediaUpload.media.id,
        prompt: "Use this snapshot as visual context.",
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Use this snapshot as visual context/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
  assert.match(dispatches[0].message.text, /contentType=image\/png/u);
});

test("audio media transcripts can be stored, updated, and used by audio prompts", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-audio-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("audio-bytes").toString("base64"),
      originalName: "prompt.webm",
      transcript: "Initial audio transcript.",
    },
  });
  assert.equal(mediaUpload.media.kind, "audio");
  assert.equal(mediaUpload.media.transcript, "Initial audio transcript.");
  assert.equal(mediaUpload.media.processing.transcriptionStatus, "ready");
  assert.equal(mediaUpload.media.processing.transcriptSource, "upload");

  const updatedTranscript = await requestJson(originalFetch, baseUrl, `/v1/media/${mediaUpload.media.id}/transcript`, {
    method: "PUT",
    headers: authHeaders,
    body: { transcript: "Continue from the current failing test and summarize the fix." },
  });
  assert.equal(updatedTranscript.media.transcript, "Continue from the current failing test and summarize the fix.");
  assert.equal(updatedTranscript.media.processing.transcriptionStatus, "ready");
  assert.equal(updatedTranscript.media.processing.transcriptSource, "manual");

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.media[0].transcript, "Continue from the current failing test and summarize the fix.");
  assert.equal(listed.media[0].storagePath, undefined);

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_audio",
      intent: {
        type: "audio_prompt",
        mediaUploadId: mediaUpload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Continue from the current failing test/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
  assert.match(dispatches[0].message.text, /contentType=audio\/webm/u);
});

test("audio media can be transcribed through the configured provider", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-transcribe-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, mediaJobRunner } = createApp({
    config: {
      mediaDir,
      maxMediaBytes: 1024,
      transcriptionProvider: "mock",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("audio-needing-transcript").toString("base64"),
      originalName: "needs-transcript.webm",
    },
  });
  assert.equal(mediaUpload.media.transcript, null);
  assert.equal(mediaUpload.media.processing.transcriptionStatus, "pending");

  // Transcription is a durable job now: the request enqueues, the worker runs it. The route no
  // longer holds the socket open for the length of an ASR call.
  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${mediaUpload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(queued.job.stage, "queued");
  assert.equal(queued.job.provider, "mock");
  assert.equal(queued.media.processing.transcriptionStatus, "processing");

  const { processed } = await mediaJobRunner.runOnce();
  assert.deepEqual(processed.map((entry) => entry.stage), ["dispatched"]);

  const job = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(job.job.stage, "dispatched");
  assert.match(job.job.rawTranscript, /Mock transcript/u);
  assert.match(job.job.normalizedTranscript, /Mock transcript/u);
  assert.equal(job.job.userEditedTranscript, null);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const transcribed = { media: listed.media.find((item) => item.id === mediaUpload.media.id) };
  assert.match(transcribed.media.transcript, /Mock transcript/u);
  assert.equal(transcribed.media.processing.transcriptionStatus, "ready");
  assert.equal(transcribed.media.processing.transcriptSource, "mock");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_audio",
      intent: {
        type: "audio_prompt",
        mediaUploadId: mediaUpload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Mock transcript for audio needs-transcript\.webm/u);
});

test("user can delete uploaded media metadata and stored bytes", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-delete-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const mediaUpload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("delete-me").toString("base64"),
      originalName: "delete-me.png",
    },
  });

  assert.equal(mediaUpload.media.kind, "image");
  assert.equal((await readdir(join(mediaDir, "user_dev"))).length, 1);

  const deleted = await requestJson(fetch, baseUrl, `/v1/media/${mediaUpload.media.id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleted.media.id, mediaUpload.media.id);
  assert.equal(deleted.media.storagePath, undefined);

  const mediaList = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(mediaList.media, []);
  assert.deepEqual(await readdir(join(mediaDir, "user_dev")), []);

  const fetchedAfterDelete = await fetch(new URL(`/v1/media/${mediaUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(fetchedAfterDelete.status, 404);
});

test("privacy settings apply media retention and purge expired stored bytes", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-retention-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const store = createMemoryStore();
  const { server } = createApp({
    store,
    config: { mediaDir, maxMediaBytes: 1024, defaultMediaRetentionDays: 30, demoMode: false },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const savedPrivacy = await requestJson(fetch, baseUrl, "/v1/settings/privacy", {
    method: "PUT",
    headers: authHeaders,
    body: { mediaRetentionDays: 1 },
  });
  assert.equal(savedPrivacy.privacy.mediaRetentionDays, 1);

  const readPrivacy = await requestJson(fetch, baseUrl, "/v1/settings/privacy", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(readPrivacy.privacy.mediaRetentionDays, 1);

  const freshUpload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("keep-me").toString("base64"),
      originalName: "keep-me.png",
    },
  });
  assert.match(freshUpload.media.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);

  const userMediaDir = join(mediaDir, "user_dev");
  await mkdir(userMediaDir, { recursive: true });
  const expiredPath = join(userMediaDir, "expired.png");
  await writeFile(expiredPath, "expired-by-retention");
  const expired = store.createMediaUpload({
    userId: "user_dev",
    deviceId: null,
    kind: "image",
    contentType: "image/png",
    sizeBytes: 20,
    sha256: "expired-sha",
    storagePath: expiredPath,
    originalName: "expired.png",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  const purged = await requestJson(fetch, baseUrl, "/v1/media/purge-expired", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(purged.count, 1);
  assert.equal(purged.purged[0].id, expired.id);
  assert.equal(purged.purged[0].storagePath, undefined);
  assert.deepEqual(await readdir(userMediaDir), [
    `${freshUpload.media.sha256}.png`,
  ]);

  const expiredAfterPurge = await fetch(new URL(`/v1/media/${expired.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(expiredAfterPurge.status, 404);

  const freshAfterPurge = await fetch(new URL(`/v1/media/${freshUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(freshAfterPurge.status, 200);
});

test("remote access settings report machine readiness without exposing command output", async (t) => {
  const { server } = createApp({
    config: {
      host: "0.0.0.0",
      port: 3996,
      publicBaseUrl: "https://gateway.example.test",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const result = await requestJson(fetch, baseUrl, "/v1/settings/remote-access?refresh=1", {
    method: "GET",
    headers: authHeaders,
  });

  assert.equal(result.remoteAccess.gateway.host, "0.0.0.0");
  assert.equal(result.remoteAccess.gateway.port, 3996);
  assert.equal(result.remoteAccess.gateway.publicBaseUrl, "https://gateway.example.test");
  assert.equal(typeof result.remoteAccess.tailscale.installed, "boolean");
  assert.equal(typeof result.remoteAccess.tailscale.connected, "boolean");
  assert.match(result.remoteAccess.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(Object.hasOwn(result.remoteAccess.tailscale, "rawStatus"), false);
});

test("support diagnostics bundle redacts prompts, shell commands, and secrets", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-diagnostics-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Diagnostics controller", profile: "agent-controller" },
  });
  const environment = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Diagnostics T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("diagnostics-image").toString("base64"),
      originalName: "diagnostics.png",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("diagnostics-audio").toString("base64"),
      originalName: "diagnostics.webm",
      transcript: "diagnostic transcript secret text",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Secret diagnostics macro",
      environmentId: environment.environment.id,
      threadId: "thread_diagnostics",
      intent: { type: "agent_prompt", text: "diagnostic macro secret text" },
    },
  });
  const command = await requestJson(fetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_diagnostics",
      intent: { type: "shell_input", command: "rm -rf very-secret-dir" },
    },
  });
  assert.equal(command.command.status, "approval_required");

  const diagnostics = await requestJson(fetch, baseUrl, "/v1/support/diagnostics", {
    method: "GET",
    headers: authHeaders,
  });
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.bundleVersion, 1);
  assert.equal(diagnostics.counts.devices, 1);
  assert.equal(diagnostics.counts.environments, 1);
  assert.equal(diagnostics.counts.media, 2);
  assert.equal(diagnostics.counts.macros, 1);
  assert.equal(diagnostics.observability.devices.total, 1);
  assert.equal(diagnostics.observability.commands.approvalRequired, 1);
  assert.equal(diagnostics.observability.media.failedProcessing, 0);
  assert.equal(diagnostics.macros[0].intent.text.redacted, true);
  assert.equal(diagnostics.recentCommands[0].intent.command.redacted, true);
  assert.equal(diagnostics.recentCommands[0].intent.command.length, "rm -rf very-secret-dir".length);
  assert.match(diagnostics.recentCommands[0].intent.command.sha256, /^[a-f0-9]{64}$/u);
  const audioMedia = diagnostics.media.find((media) => media.kind === "audio");
  assert.equal(audioMedia.transcript.redacted, true);
  assert.equal(audioMedia.transcript.length, "diagnostic transcript secret text".length);
  assert.equal(serialized.includes("rm -rf very-secret-dir"), false);
  assert.equal(serialized.includes("diagnostic macro secret text"), false);
  assert.equal(serialized.includes("diagnostic transcript secret text"), false);
  assert.equal(serialized.includes(created.secret), false);
  assert.equal(serialized.includes("mock-token"), false);
  assert.equal(serialized.includes(mediaDir), false);
});

test("serves the React dashboard and its built assets", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(new URL("/", baseUrl));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/u);
  assert.match(html, /Agent Controller/u);
  assert.match(html, /id="root"/u);
  assert.doesNotMatch(html, /Remote agent control plane/u);

  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/u)?.[1];
  assert.ok(assetPath);
  const assetResponse = await fetch(new URL(assetPath, baseUrl));
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("cache-control"), /immutable/u);
});

test("the pre-React dashboard assets are gone from every route", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The legacy dashboard was removed; the React build is the only client. These paths must 404
  // rather than fall through to the SPA and hand back index.html for a .js request.
  for (const path of ["/legacy/", "/legacy/app.js", "/app.js", "/styles.css"]) {
    const response = await fetch(new URL(path, baseUrl));
    assert.equal(response.status, 404, `${path} should be gone`);
  }
});

test("auth config exposes only public Clerk browser settings", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const config = await requestJson(fetch, baseUrl, "/v1/auth/config", {
    method: "GET",
    headers: {},
    body: undefined,
  });

  assert.deepEqual(config, {
    authProvider: "clerk",
    demoMode: false,
    developmentTokens: {
      enabled: false,
    },
    clerk: {
      enabled: true,
      publishableKey: "pk_test_public",
    },
  });
  assert.equal(JSON.stringify(config).includes("sk_test_secret"), false);
});

test("development token creation is disabled when Clerk auth is active", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(new URL("/v1/users/dev", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "attacker", email: "attacker@example.local" }),
  });
  const data = await response.json();

  assert.equal(response.status, 403);
  assert.match(data.error.message, /disabled/u);
});

test("development token creation can be explicitly enabled for local Clerk testing", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      devTokenCreationEnabled: true,
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "local_clerk_dev", email: "local-clerk@example.local" },
  });

  assert.equal(created.user.id, "local_clerk_dev");
  assert.ok(created.apiToken.secret);
});

test("user-authenticated web clients can upload media and dispatch prompts", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-web-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("web-image").toString("base64"),
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_web",
      intent: {
        type: "camera_prompt",
        mediaUploadId: mediaUpload.media.id,
        prompt: "Inspect this uploaded web image.",
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Inspect this uploaded web image/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
});

test("user saved macros can be created, run, listed, and deleted", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
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

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Macro T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const created = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Continue work",
      environmentId: environment.environment.id,
      threadId: "thread_macro",
      intent: { type: "agent_prompt", text: "Continue from the saved macro." },
    },
  });
  assert.equal(created.macro.label, "Continue work");
  assert.equal(created.macro.intent.text, "Continue from the saved macro.");

  const listed = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.macros.length, 1);
  assert.equal(listed.macros[0].id, created.macro.id);

  const run = await requestJson(originalFetch, baseUrl, `/v1/macros/${created.macro.id}/run`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(run.command.status, "dispatched");
  assert.equal(run.macro.id, created.macro.id);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].threadId, "thread_macro");
  assert.equal(dispatches[0].message.text, "Continue from the saved macro.");

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/macros/${created.macro.id}`, {
    method: "DELETE",
    headers: authHeaders,
    body: undefined,
  });
  assert.equal(deleted.macro.id, created.macro.id);

  const listedAfterDelete = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(listedAfterDelete.macros, []);
});

test("claimed devices can list and run saved macros", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
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

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Macro controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Device Macro T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  const macro = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Device macro",
      environmentId: environment.environment.id,
      threadId: "thread_device_macro",
      intent: { type: "agent_prompt", text: "Device macro prompt." },
    },
  });

  const deviceHeaders = {
    "x-device-id": device.device.id,
    "x-device-secret": device.secret,
  };
  const listed = await requestJson(originalFetch, baseUrl, "/v1/device/macros", {
    method: "GET",
    headers: deviceHeaders,
  });
  assert.equal(listed.macros.length, 1);
  assert.equal(listed.macros[0].id, macro.macro.id);

  const run = await requestJson(originalFetch, baseUrl, `/v1/device/macros/${macro.macro.id}/run`, {
    method: "POST",
    headers: deviceHeaders,
    body: {},
  });
  assert.equal(run.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].threadId, "thread_device_macro");
  assert.equal(dispatches[0].message.text, "Device macro prompt.");
});

test("display endpoints expose compact user and device state", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Display controller", profile: "agent-controller" },
  });

  const userDisplay = await requestJson(fetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(userDisplay.display.counts.devices, 1);
  assert.equal(userDisplay.display.title, "Agent Controller");

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceDisplay.display.title, "Display controller");
  assert.equal(deviceDisplay.display.device.id, created.device.id);

  const observability = await requestJson(fetch, baseUrl, "/v1/observability/summary", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(observability.summary.devices.total, 1);
  assert.equal(observability.summary.devices.online, 1);
  assert.equal(observability.summary.environments.total, 0);
  assert.equal(observability.summary.commands.total, 0);
});

test("device config is user-managed and used as device intent defaults", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Configurable controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const invalidConfig = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ environmentId: "env_missing" }),
  });
  assert.equal(invalidConfig.status, 404);

  const insecureRemoteConfig = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ gatewayAccessMode: "online", gatewayUrl: "http://gateway.example.com" }),
  });
  assert.equal(insecureRemoteConfig.status, 400);

  const saved = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      label: "Editing bay controller",
      environmentId: environment.environment.id,
      threadId: "thread_configured",
      gatewayAccessMode: "online",
      gatewayUrl: "https://gateway.example.com/",
      defaultPrompt: "Configured prompt from gateway.",
      shellCommand: "npm test -- --watch=false",
      menu: ["status", "prompt", "shell"],
    },
  });
  assert.equal(saved.config.environmentId, environment.environment.id);
  assert.equal(saved.device.label, "Editing bay controller");
  assert.equal(saved.config.threadId, "thread_configured");
  assert.equal(saved.config.gatewayAccessMode, "online");
  assert.equal(saved.config.gatewayUrl, "https://gateway.example.com");
  assert.equal(saved.config.shellCommand, "npm test -- --watch=false");
  assert.deepEqual(saved.config.menu, ["status", "prompt", "shell"]);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.devices[0].label, "Editing bay controller");

  const deviceConfig = await requestJson(originalFetch, baseUrl, "/v1/device/config", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceConfig.config.defaultPrompt, "Configured prompt from gateway.");
  assert.equal(deviceConfig.config.shellCommand, "npm test -- --watch=false");
  assert.equal(deviceConfig.config.gatewayAccessMode, "online");
  assert.equal(deviceConfig.config.gatewayUrl, "https://gateway.example.com");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      intent: { type: "agent_prompt", text: "Use configured environment and thread." },
    },
  });
  assert.equal(dispatched.command.environmentId, environment.environment.id);
  assert.equal(dispatched.command.threadId, "thread_configured");
  assert.equal(dispatches[0].threadId, "thread_configured");

  const shell = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      intent: { type: "shell_input", command: deviceConfig.config.shellCommand },
    },
  });
  assert.equal(shell.command.status, "dispatched");
  assert.match(dispatches.at(-1).message.text, /npm test -- --watch=false/u);
});

test("device profiles are discoverable, validated, and enforced", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const catalog = await requestJson(originalFetch, baseUrl, "/v1/device-profiles", {
    method: "GET",
    headers: {},
  });
  assert.ok(catalog.profiles.find((profile) => profile.id === "agent-controller").capabilities.includes("shell_input"));
  assert.deepEqual(catalog.profiles.find((profile) => profile.id === "read-only").capabilities, ["status"]);

  const invalidCreate = await originalFetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ label: "Invalid controller", profile: "unknown-profile" }),
  });
  assert.equal(invalidCreate.status, 400);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Profile controller", profile: "read-only" },
  });
  assert.equal(created.device.profile, "read-only");

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const blockedPrompt = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_profile",
      intent: { type: "agent_prompt", text: "Run tests." },
    }),
  });
  const blockedBody = await blockedPrompt.json();
  assert.equal(blockedPrompt.status, 403);
  assert.equal(blockedBody.error.details.command.status, "blocked");
  assert.equal(blockedBody.error.details.policy.risk, "blocked");
  assert.equal(dispatches.length, 0);

  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/profile`, {
    method: "PUT",
    headers: authHeaders,
    body: { profile: "agent-controller" },
  });
  assert.equal(updated.device.profile, "agent-controller");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_profile",
      intent: { type: "agent_prompt", text: "Run tests." },
    },
  });
  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
});

test("SSE user event stream emits state changes", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());

  const streamResponse = await fetch(
    new URL(`/v1/events?token=${encodeURIComponent(auth.apiToken.secret)}`, baseUrl),
    { signal: controller.signal },
  );
  assert.equal(streamResponse.status, 200);

  await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiToken.secret}` },
    body: { label: "SSE controller", profile: "agent-controller" },
  });

  const text = await readStreamUntil(streamResponse.body, "state.changed");
  assert.match(text, /event: connected/u);
  assert.match(text, /event: state.changed/u);
  assert.match(text, /"devices":1/u);
});

test("factory preprovisioned devices must be claimed before control and support rotation/revocation", async (t) => {
  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const preprovisioned = await requestJson(fetch, baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Factory controller", profile: "agent-controller" },
  });
  assert.equal(preprovisioned.device.claimed, false);
  assert.ok(preprovisioned.claimCode);
  assert.ok(preprovisioned.secret);

  const unclaimedHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(unclaimedHeartbeat.device.claimed, false);

  const unclaimedDisplay = await fetch(new URL("/v1/device/display", baseUrl), {
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
  });
  assert.equal(unclaimedDisplay.status, 403);

  // Firmware asks for a setup code on its first 403, seconds after boot. That must not invalidate
  // the code printed on the box at manufacture, so the request reports the existing code as still
  // valid and mints nothing.
  const setupCode = await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(setupCode.device.id, preprovisioned.device.id);
  assert.equal(setupCode.device.claimed, false);
  assert.equal(setupCode.setup.claimed, false);
  assert.equal(setupCode.setup.rotated, false);
  assert.equal(setupCode.setup.claimCode, null);
  assert.ok(Date.parse(setupCode.setup.claimCodeExpiresAt) > Date.now());

  // Repeating it — the device polls — still does not move the code.
  await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });

  const claimed = await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: authHeaders,
    body: { claimCode: preprovisioned.claimCode, label: "Claimed controller" },
  });
  assert.equal(claimed.device.claimed, true);
  assert.equal(claimed.device.label, "Claimed controller");

  const claimedSetupCode = await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(claimedSetupCode.setup.claimed, true);
  assert.equal(claimedSetupCode.setup.claimCode, null);

  const heartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {
      firmwareVersion: "0.1.7",
      hardwareModel: "e213-esp32-s3r8",
      ipAddress: "192.168.4.20",
      wifiRssi: -61,
      freeHeap: 184320,
      uptimeMs: 120000,
      batteryPercent: 87,
    },
  });
  assert.equal(heartbeat.device.status.firmwareVersion, "0.1.7");
  assert.equal(heartbeat.device.status.hardwareModel, "e213-esp32-s3r8");
  assert.equal(heartbeat.device.status.ipAddress, "192.168.4.20");
  assert.equal(heartbeat.device.status.wifiRssi, -61);
  assert.equal(heartbeat.device.status.freeHeap, 184320);
  assert.equal(heartbeat.device.status.uptimeMs, 120000);
  assert.equal(heartbeat.device.status.batteryPercent, 87);
  assert.match(heartbeat.device.status.lastHeartbeatAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(heartbeat.device.presence.state, "online");
  assert.equal(heartbeat.device.presence.online, true);
  assert.equal(heartbeat.device.presence.lastHeartbeatAt, heartbeat.device.status.lastHeartbeatAt);

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(devices.devices[0].status.firmwareVersion, "0.1.7");
  assert.equal(devices.devices[0].presence.state, "online");

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
  });
  assert.equal(deviceDisplay.display.device.id, preprovisioned.device.id);
  assert.equal(deviceDisplay.display.device.status.firmwareVersion, "0.1.7");
  assert.equal(deviceDisplay.display.device.presence.state, "online");

  const rotated = await requestJson(fetch, baseUrl, `/v1/devices/${preprovisioned.device.id}/rotate-secret`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.notEqual(rotated.secret, preprovisioned.secret);

  const oldSecretHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(oldSecretHeartbeat.status, 401);

  await requestJson(fetch, baseUrl, `/v1/devices/${preprovisioned.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });

  const revokedHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": rotated.secret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(revokedHeartbeat.status, 401);
});

test("owners can reset claimed devices for transfer to a new account", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: ownerHeaders,
    body: { label: "Transfer controller", profile: "agent-controller" },
  });

  const reset = await requestJson(fetch, baseUrl, `/v1/devices/${created.device.id}/transfer-reset`, {
    method: "POST",
    headers: ownerHeaders,
    body: {},
  });
  assert.equal(reset.device.id, created.device.id);
  assert.equal(reset.device.claimed, false);
  assert.equal(reset.device.userId, null);
  assert.ok(reset.claimCode);
  assert.ok(reset.secret);
  assert.notEqual(reset.secret, created.secret);

  const oldSecretHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(oldSecretHeartbeat.status, 401);

  const ownerDevices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: ownerHeaders,
  });
  assert.deepEqual(ownerDevices.devices, []);

  const newOwner = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_new_owner", email: "new-owner@example.local" },
  });
  const newOwnerHeaders = { authorization: `Bearer ${newOwner.apiToken.secret}` };
  const claimed = await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: newOwnerHeaders,
    body: { claimCode: reset.claimCode, label: "New owner controller" },
  });
  assert.equal(claimed.device.id, created.device.id);
  assert.equal(claimed.device.claimed, true);
  assert.equal(claimed.device.userId, "user_new_owner");
  assert.equal(claimed.device.label, "New owner controller");

  const newOwnerHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": reset.secret,
    },
    body: { firmwareVersion: "0.1.8" },
  });
  assert.equal(newOwnerHeartbeat.device.userId, "user_new_owner");
  assert.equal(newOwnerHeartbeat.device.status.firmwareVersion, "0.1.8");
});

test("factory batch provisioning returns flash configs and firmware manifests are device-polled", async (t) => {
  const { server } = createApp({
    config: {
      factoryToken: "factory-secret",
      otaSigningKey: "test-ota-signing-key",
      defaultHardwareModel: "e213-esp32-s3r8",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const batch = await requestJson(fetch, baseUrl, "/v1/factory/batches", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      count: 2,
      labelPrefix: "Batch controller",
      gatewayBaseUrl: "https://gateway.example.com",
      firmwareVersion: "0.1.0",
      shellCommand: "npm test -- --runInBand",
      enableOtaApply: true,
      requireOtaSignature: true,
      otaManifestVerifyKey: "test-ota-signing-key",
    },
  });

  assert.equal(batch.batch.count, 2);
  assert.equal(batch.devices.length, 2);
  assert.match(batch.devices[0].claimCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);
  assert.match(batch.devices[0].flashConfig, /#define GATEWAY_BASE_URL "https:\/\/gateway\.example\.com"/u);
  assert.match(batch.devices[0].flashConfig, new RegExp(`#define DEVICE_ID "${batch.devices[0].device.id}"`, "u"));
  // Break 1: the factory cannot know the customer's network, so a baked-in SSID guaranteed that
  // no shipped unit could connect. Wi-Fi now comes from the owner via the on-device portal.
  // The generated header still names them in a comment explaining where they went, so this
  // asserts on the definition rather than the substring.
  assert.doesNotMatch(batch.devices[0].flashConfig, /#define\s+WIFI_SSID/u);
  assert.doesNotMatch(batch.devices[0].flashConfig, /#define\s+WIFI_PASSWORD/u);

  // The NVS seed is what lets one signed image serve a whole batch.
  assert.equal(batch.devices[0].nvsSeedFilename, `${batch.devices[0].device.id}.nvs.csv`);
  assert.match(batch.devices[0].nvsSeed, /^key,type,encoding,value$/mu);
  assert.match(batch.devices[0].nvsSeed, /^agentctl,namespace,,$/mu);
  assert.match(batch.devices[0].nvsSeed, new RegExp(`^dev_id,data,string,${batch.devices[0].device.id}$`, "mu"));
  assert.match(batch.devices[0].nvsSeed, /^gw_url,data,string,https:\/\/gateway\.example\.com$/mu);
  assert.ok(batch.devices[0].nvsSeed.includes(batch.devices[0].secret));
  // The claim code ships in the seed so the on-screen code matches the printed label from first
  // boot; the gateway will not reissue a still-live code's plaintext later.
  assert.ok(batch.devices[0].nvsSeed.includes(`claim_code,data,string,${batch.devices[0].claimCode}`));
  assert.ok(batch.devices[0].nvsSeed.includes("claim_exp,data,string,"));
  // Wi-Fi stays absent: the factory cannot know the customer's network.
  assert.ok(!batch.devices[0].nvsSeed.includes("wifi_ssid"));
  assert.match(batch.devices[0].flashConfig, /#define DEFAULT_SHELL_COMMAND "npm test -- --runInBand"/u);
  assert.match(batch.devices[0].flashConfig, /#define ENABLE_OTA_APPLY 1/u);
  assert.match(batch.devices[0].flashConfig, /#define REQUIRE_OTA_SIGNATURE 1/u);
  assert.match(batch.devices[0].flashConfig, /#define OTA_MANIFEST_VERIFY_KEY "test-ota-signing-key"/u);

  await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: authHeaders,
    body: { claimCode: batch.devices[0].claimCode, label: "Claimed batch controller" },
  });

  const release = await requestJson(fetch, baseUrl, "/v1/factory/firmware/releases", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      version: "0.2.0",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/firmware/agent-controller-0.2.0.bin",
      sha256: "a".repeat(64),
      sizeBytes: 901385,
      mandatory: false,
      releaseNotes: "Config polling firmware.",
    },
  });

  assert.equal(release.release.version, "0.2.0");
  assert.equal(release.manifest.version, "0.2.0");
  assert.equal(release.manifest.channel, "stable");
  assert.match(release.manifest.signature, /^[a-f0-9]{64}$/u);

  await requestJson(fetch, baseUrl, "/v1/factory/firmware/releases", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      version: "0.3.0-beta.1",
      channel: "beta",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/firmware/agent-controller-0.3.0-beta.1.bin",
      sha256: "b".repeat(64),
      sizeBytes: 905000,
      mandatory: false,
      releaseNotes: "Beta controls firmware.",
    },
  });

  await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { updateMode: "automatic" },
  });

  const update = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(update.updateAvailable, true);
  assert.equal(update.installation, "automatic");
  assert.equal(update.manifest.version, "0.2.0");
  assert.equal(update.manifest.sha256, "a".repeat(64));

  const current = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.2.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.reason, "current");

  const manualBetaPolicy = await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { channel: "beta", updateMode: "manual" },
  });
  assert.equal(manualBetaPolicy.latestVersion, "0.3.0-beta.1");
  assert.deepEqual(manualBetaPolicy.availableVersions, ["0.3.0-beta.1"]);

  const legacyManualBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(legacyManualBeta.updateAvailable, false);
  assert.equal(legacyManualBeta.reason, "manual_or_notify");

  await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
    body: {
      protocolVersion: 2,
      firmwareVersion: "0.1.0",
      hardwareModel: "e213-esp32-s3r8",
      features: ["ota", "ota_confirm"],
    },
  });

  const manualBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(manualBeta.updateAvailable, true);
  assert.equal(manualBeta.installation, "confirm");
  assert.equal(manualBeta.manifest.version, "0.3.0-beta.1");

  await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { desiredVersion: "0.3.0-beta.1" },
  });
  const requestedBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(requestedBeta.updateAvailable, true);
  assert.equal(requestedBeta.installation, "automatic");
  assert.equal(requestedBeta.manifest.version, "0.3.0-beta.1");
  assert.equal(requestedBeta.manifest.channel, "beta");
});

test("rate limits protect user and device write paths", async (t) => {
  const { server } = createApp({
    config: {
      demoMode: false,
      rateLimits: {
        windowMs: 60_000,
        auth: 100,
        factoryWrite: 100,
        userRead: 100,
        userWrite: 1,
        deviceHeartbeat: 1,
        deviceRead: 100,
        deviceWrite: 1,
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Limited controller", profile: "agent-controller" },
  });

  const secondDevice = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ label: "Blocked controller", profile: "agent-controller" }),
  });
  assert.equal(secondDevice.status, 429);
  assert.equal(secondDevice.headers.get("x-ratelimit-limit"), "1");
  assert.equal(secondDevice.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(secondDevice.headers.get("retry-after"));

  const heartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {},
  });
  assert.equal(heartbeat.ok, true);

  const secondHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: "{}",
  });
  assert.equal(secondHeartbeat.status, 429);
});

test("Clerk auth mode maps bearer sessions to platform users", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      demoMode: false,
      rateLimits: {
        windowMs: 60_000,
        auth: 100,
        factoryWrite: 100,
        userRead: 100,
        userWrite: 100,
        deviceHeartbeat: 100,
        deviceRead: 100,
        deviceWrite: 100,
      },
    },
    clerkAuth: async (req) => {
      assert.equal(req.headers.authorization, "Bearer clerk-session");
      return { id: "user_clerk_123" };
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: { authorization: "Bearer clerk-session" },
    body: { label: "Clerk controller", profile: "agent-controller" },
  });
  assert.equal(created.device.userId, "user_clerk_123");

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: { authorization: "Bearer clerk-session" },
    body: undefined,
  });
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].id, created.device.id);
});

test("Clerk cookie sessions synchronize the real user profile", async (t) => {
  const { server, store } = createApp({
    config: {
      authProvider: "clerk",
      demoMode: false,
    },
    clerkAuth: async (req) => {
      assert.equal(req.headers.cookie, "__session=clerk-cookie-session");
      return {
        id: "user_clerk_cookie",
        email: "operator@example.com",
        name: "Gateway Operator",
      };
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: { cookie: "__session=clerk-cookie-session" },
    body: undefined,
  });

  assert.deepEqual(devices.devices, []);
  assert.deepEqual(
    store.exportState().users.map(({ id, email, name }) => ({ id, email, name })),
    [{
      id: "user_clerk_cookie",
      email: "operator@example.com",
      name: "Gateway Operator",
    }],
  );
});

test("gateway routes support async Store API implementations", async (t) => {
  const store = createAsyncStore(createMemoryStore());
  const { server } = createApp({ store });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Async controller", profile: "agent-controller" },
  });
  const environment = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Async T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  await requestJson(fetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_async",
      menu: ["status", "prompt"],
    },
  });

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(devices.devices.length, 1);

  const userDisplay = await requestJson(fetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(userDisplay.display.counts.devices, 1);
  assert.equal(userDisplay.display.counts.environments, 1);

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceDisplay.display.selectedEnvironmentId, environment.environment.id);
});

test("removing a T3 environment previews, repairs, and reports every dependency", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "thread_env" }] }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") return jsonResponse({ accepted: true }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(originalFetch, baseUrl);

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Dependency controller", profile: "agent-controller" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Doomed T3", baseUrl: "https://doomed-t3.example", accessToken: "doomed-token" },
  });
  const environmentId = environment.environment.id;
  await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "PUT",
    headers,
    body: { environmentId, threadId: "thread_env" },
  });
  const action = await requestJson(originalFetch, baseUrl, "/v1/actions", {
    method: "POST",
    headers,
    body: {
      type: "prompt",
      label: "Ship it",
      payload: { text: "Continue the task." },
      targetMode: "fixed",
      environmentId,
      threadId: "thread_env",
    },
  });
  assert.equal(action.action.disabled, false);
  const macro = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers,
    body: {
      label: "Nightly sweep",
      environmentId,
      threadId: "thread_env",
      intent: { type: "agent_prompt", text: "Sweep the repo." },
    },
  });
  await requestJson(originalFetch, baseUrl, "/v1/onboarding", {
    method: "PUT",
    headers,
    body: { status: "in_progress", currentStep: "workspace", environmentId, firstThreadId: "thread_env" },
  });

  const preview = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/dependencies`, {
    method: "GET",
    headers,
  });
  assert.deepEqual(preview.counts, { devices: 1, actions: 1, macros: 1, onboarding: 1 });
  assert.deepEqual(preview.dependencies.actions, [{ id: action.action.id, label: "Ship it" }]);
  assert.deepEqual(preview.dependencies.macros, [{ id: macro.macro.id, label: "Nightly sweep" }]);
  assert.deepEqual(preview.dependencies.devices, [{ id: device.device.id, label: "Dependency controller" }]);
  assert.equal(preview.dependencies.onboarding, true);

  const removed = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(removed.environment.id, environmentId);
  assert.equal(removed.alreadyRemoved, false);
  assert.deepEqual(removed.removed, {
    devices: [device.device.id],
    actions: [action.action.id],
    macros: [macro.macro.id],
    onboarding: true,
  });

  const config = await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "GET",
    headers,
  });
  assert.equal(config.config.environmentId, null);

  const orphanedAction = await requestJson(originalFetch, baseUrl, `/v1/actions/${action.action.id}`, {
    method: "GET",
    headers,
  });
  assert.equal(orphanedAction.action.disabled, true);
  assert.equal(orphanedAction.action.disabledReason, "environment_removed");
  assert.equal(orphanedAction.action.environmentId, null);
  assert.equal(orphanedAction.action.targetMode, "device-current");

  const macros = await requestJson(originalFetch, baseUrl, "/v1/macros", { method: "GET", headers });
  assert.equal(macros.macros[0].disabled, true);
  assert.equal(macros.macros[0].disabledReason, "environment_removed");
  assert.equal(macros.macros[0].environmentId, null);

  const onboarding = await requestJson(originalFetch, baseUrl, "/v1/onboarding", { method: "GET", headers });
  assert.equal(onboarding.onboarding.environmentId, null);
  assert.equal(onboarding.onboarding.firstThreadId, null);

  // A disabled record is refused before anything tries to resolve the environment that is gone.
  const actionRun = await originalFetch(new URL(`/v1/actions/${action.action.id}/run`, baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const actionRunBody = await actionRun.json();
  assert.equal(actionRun.status, 409);
  assert.match(actionRunBody.error.message, /environment was removed/u);

  const macroRun = await originalFetch(new URL(`/v1/macros/${macro.macro.id}/run`, baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(macroRun.status, 409);

  const repeated = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(repeated.environment, null);
  assert.equal(repeated.alreadyRemoved, true);
  assert.deepEqual(repeated.removed, { devices: [], actions: [], macros: [], onboarding: false });

  // Saving the action again is the only thing that re-enables it.
  const rescued = await requestJson(originalFetch, baseUrl, `/v1/actions/${action.action.id}`, {
    method: "PUT",
    headers,
    body: { label: "Ship it later" },
  });
  assert.equal(rescued.action.disabled, false);
  assert.equal(rescued.action.disabledReason, null);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
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

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createAsyncStore(store) {
  const syncMethods = new Set(["subscribe", "exportState", "flush"]);
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || syncMethods.has(property)) return value;
      return async (...args) => value.apply(target, args);
    },
  });
}

async function readStreamUntil(body, pattern) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (includesCompletedEvent(output, pattern)) {
      await reader.cancel();
      return output;
    }
  }
  await reader.cancel();
  throw new Error(`Timed out waiting for ${pattern}. Received: ${output}`);
}

// SSE events are terminated by a blank line. Only treat the pattern as found once
// its whole event has arrived; matching mid-event returns while the `event:` line
// has been read but the `data:` payload is still in flight.
function includesCompletedEvent(output, pattern) {
  const boundary = output.lastIndexOf("\n\n");
  return boundary !== -1 && output.slice(0, boundary).includes(pattern);
}

// --- device-scoped thread selection ---------------------------------------
//
// A device may change which thread it drives, but only within the environment its
// owner bound. The owner keeps the boundary that matters; the hardware gets the
// autonomy that is actually useful at a five-key bezel.

async function threadSelectionFixture(t, { threads, snapshotError = null } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      if (snapshotError) throw snapshotError;
      return jsonResponse({
        projects: [{ id: "p1" }],
        threads: threads ?? [
          { id: "thread_a", title: "Alpha", session: { status: "stopped" } },
          {
            id: "thread_b",
            title: "Beta",
            session: { status: "stopped" },
            latestTurn: { state: "running" },
          },
        ],
      }, 200);
    }
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

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bezel controller", profile: "agent-controller" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bound T3", baseUrl: "https://bound-t3.example", accessToken: "tok" },
  });

  return { originalFetch, baseUrl, authHeaders, created, deviceHeaders, environment };
}

test("a device lists titled thread status and the current selection from its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_a" },
  });

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.environmentId, f.environment.environment.id);
  assert.deepEqual(listed.threads, [
    { id: "thread_a", title: "Alpha", status: "stopped", selected: true },
    { id: "thread_b", title: "Beta", status: "running", selected: false },
  ]);
  assert.equal(listed.threadId, "thread_a");
});

test("device thread listing supplies safe title and status fallbacks", async (t) => {
  const f = await threadSelectionFixture(t, {
    threads: [
      { id: "thread_named", name: "Named by provider" },
      { id: "thread_untitled" },
      { title: "Missing identity", session: { status: "running" } },
    ],
  });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.deepEqual(listed.threads, [
    { id: "thread_named", title: "Named by provider", status: "idle", selected: false },
    { id: "thread_untitled", title: "Untitled thread", status: "idle", selected: false },
  ]);
});

test("a device reads only its selected thread response through bounded pages", async (t) => {
  const f = await threadSelectionFixture(t, {
    threads: [{
      id: "thread_output",
      title: "Response task",
      session: { status: "stopped" },
      messages: [{
        id: "message_output",
        role: "assistant",
        createdAt: "2026-08-08T20:00:00.000Z",
        text: "Implemented the hardware response display with paging and safe action validation. <!--AC_FOLLOWUPS:[\"invented_action\"]-->",
      }],
    }],
  });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_output" },
  });

  const output = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/thread-output?page=0", {
    headers: f.deviceHeaders,
  });
  assert.equal(output.thread.id, "thread_output");
  assert.equal(output.response.messageId, "message_output");
  assert.equal(output.response.state, "complete");
  assert.ok(output.response.lines.every((line) => line.length <= 31));
  assert.doesNotMatch(output.response.lines.join(" "), /AC_FOLLOWUPS/u);
  assert.deepEqual(output.suggestions, [], "unassigned model output never becomes a device action");

  const waiting = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/thread-output?page=0&after=2026-08-08T21%3A00%3A00.000Z", {
    headers: f.deviceHeaders,
  });
  assert.equal(waiting.response.state, "waiting");
  assert.equal(waiting.response.messageId, null);

  const invalid = await f.originalFetch(new URL("/v1/device/thread-output?page=-1", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(invalid.status, 400);
});

test("device thread listing reports a bound T3 host outage as an actionable gateway error", async (t) => {
  const f = await threadSelectionFixture(t, { snapshotError: new Error("connect ECONNREFUSED") });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const response = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.message, "T3 environment is unavailable.");
  assert.equal(body.error.details.code, "t3_unreachable");
  assert.equal(body.error.details.environmentId, f.environment.environment.id);
});

test("a device can select a thread inside its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const updated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { threadId: "thread_b" },
  });
  assert.equal(updated.config.threadId, "thread_b");
  // The bound environment must survive a thread change.
  assert.equal(updated.config.environmentId, f.environment.environment.id);

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_b", "the choice is durable");

  const relisted = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(relisted.threadId, "thread_b");
  assert.equal(relisted.threads.find((thread) => thread.id === "thread_b")?.selected, true);

  const audit = await requestJson(f.originalFetch, f.baseUrl, "/v1/audit", { headers: f.authHeaders });
  const event = audit.events.findLast((entry) => (
    entry.action === "device.config_updated" && entry.metadata?.threadId === "thread_b"
  ));
  assert.equal(event?.actorType, "device");
  assert.equal(event?.actorId, f.created.device.id);
  assert.equal(event?.targetId, f.created.device.id);
});

test("a device cannot select a thread that is not in its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_a" },
  });

  const response = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_from_another_environment" }),
  });
  assert.equal(response.status, 404);

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_a", "the rejected write changed nothing");
});

test("device thread selection rejects missing or blank thread ids", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  for (const body of [{}, { threadId: "   " }]) {
    const response = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
      method: "POST",
      headers: { ...f.deviceHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test("thread selection is refused when the owner bound no environment", async (t) => {
  const f = await threadSelectionFixture(t);

  const listed = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.status, 409);

  const wrote = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 409);
});

test("a device may only write threadId, never widen its own scope", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, shellCommand: "npm test" },
  });

  // Everything except threadId must be ignored, including an attempt to repoint the
  // device at another environment or hand itself a more permissive shell command.
  await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {
      threadId: "thread_a",
      environmentId: "env_somewhere_else",
      shellCommand: "sudo rm -rf /",
      menu: ["status", "prompt", "shell", "macro", "media", "stop", "approve"],
    },
  });

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_a");
  assert.equal(reread.config.environmentId, f.environment.environment.id, "environment is owner-only");
  assert.equal(reread.config.shellCommand, "npm test", "shell command is owner-only");
});

test("an unclaimed device cannot list or select threads", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provisioned = await requestJson(originalFetch, baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Unclaimed", profile: "agent-controller" },
  });
  const headers = {
    "x-device-id": provisioned.device.id,
    "x-device-secret": provisioned.secret,
  };

  const listed = await originalFetch(new URL("/v1/device/threads", baseUrl), { headers });
  assert.equal(listed.status, 403);
  const wrote = await originalFetch(new URL("/v1/device/config/thread", baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 403);
});

test("invalid device credentials cannot read or change thread selection", async (t) => {
  const f = await threadSelectionFixture(t);
  const badHeaders = {
    "x-device-id": f.created.device.id,
    "x-device-secret": "wrong-secret",
  };

  const listed = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), { headers: badHeaders });
  assert.equal(listed.status, 401);
  const wrote = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...badHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 401);
});

test("the device display payload carries the owner's configured menu, not a generic one", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Menu controller", profile: "agent-controller" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu: ["status", "thread", "stop"] },
  });

  // Firmware applies the display menu every few seconds and the config menu once a
  // minute, so a generic menu here would quietly undo the owner's choice.
  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: deviceHeaders,
  });
  assert.deepEqual(display.display.menu, ["status", "thread", "stop"]);
});

test("a full device menu round-trips without silently dropping entries", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Full menu controller", profile: "agent-controller" },
  });

  // Seven entries: previously capped at six, which dropped "stop" off the end with
  // no error, quietly removing the ability to halt a session from the hardware.
  const menu = ["status", "prompt", "shell", "macro", "thread", "media", "stop"];
  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu },
  });
  assert.deepEqual(updated.config.menu, menu);

  // And the device must be served the same list it was configured with.
  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
  });
  assert.deepEqual(display.display.menu, menu);
});

test("the destructive reset entry is assignable to a device menu", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Resettable controller", profile: "agent-controller" },
  });

  // "reset" opens an on-device confirmation screen that wipes Wi-Fi, the config cache, the cached
  // claim code and any gateway override. It is owner-assigned rather than always present, so an
  // accidental dial press cannot reach a factory wipe on a device that was never given the entry.
  const menu = ["status", "prompt", "thread", "reset"];
  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu },
  });
  assert.deepEqual(updated.config.menu, menu);

  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
  });
  assert.deepEqual(display.display.menu, menu);
});

test("devices declare which owner operations the gateway will accept", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Actionable controller", profile: "agent-controller" },
  });
  assert.deepEqual(created.device.actions, {
    rotateSecret: true,
    transferReset: true,
    updateConfig: true,
    updateProfile: true,
    revoke: true,
    // Deleting is the inverse: unavailable until the credential is dead.
    delete: false,
  });

  const revoked = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  // Every one of these is refused once revoked, so a client that trusts this field cannot render a
  // control that returns 404 — which is the whole point of the server declaring it.
  assert.deepEqual(revoked.device.actions, {
    rotateSecret: false,
    transferReset: false,
    updateConfig: false,
    updateProfile: false,
    revoke: false,
    delete: true,
  });

  // The declaration has to match what the routes actually do, or it is just a second thing to
  // keep in sync. These are the guards it stands in for.
  for (const [path, body] of [
    [`/v1/devices/${created.device.id}/rotate-secret`, {}],
    [`/v1/devices/${created.device.id}/transfer-reset`, {}],
  ]) {
    const response = await originalFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 404, `${path} must refuse a revoked device`);
  }
  const config = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_x" }),
  });
  assert.equal(config.status, 404, "config updates must refuse a revoked device");
});

test("a revoked device can be deleted, and an active one cannot", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Retired controller", profile: "agent-controller" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };
  assert.equal(created.device.actions.delete, false, "an active device is not deletable");

  // Deleting before revoking would drop the record while the credential still authenticates,
  // leaving hardware in the field the owner can no longer see or revoke.
  const premature = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(premature.status, 409);

  const revoked = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(revoked.device.actions.delete, true, "revoking is what unlocks deletion");

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.device.id, created.device.id);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/devices", { headers: authHeaders });
  assert.equal(listed.devices.length, 0, "the device is gone from the inventory");

  // The credential dies with the record rather than falling back to unclaimed-but-valid.
  const orphaned = await originalFetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: { ...deviceHeaders, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(orphaned.status, 401);

  const again = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(again.status, 404, "deleting twice is a 404, not a second success");

  // Deleting the controller must not erase the record of what it did.
  const audit = await requestJson(originalFetch, baseUrl, "/v1/audit", { headers: authHeaders });
  const actions = audit.events.map((event) => event.action);
  assert.ok(actions.includes("device.deleted"), "the deletion itself is audited");
  assert.ok(actions.includes("device.revoked"), "earlier history survives the delete");
});

test("one owner cannot delete another owner's revoked device", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = async (userId) => {
    const created = await requestJson(originalFetch, baseUrl, "/v1/users/dev", {
      method: "POST",
      headers: {},
      body: { userId, email: `${userId}@example.local` },
    });
    return { authorization: `Bearer ${created.apiToken.secret}` };
  };
  const owner = await tokenFor("user_owner");
  const stranger = await tokenFor("user_stranger");

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: owner,
    body: { label: "Owned controller", profile: "agent-controller" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: owner,
    body: {},
  });

  const attempt = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: stranger,
  });
  assert.equal(attempt.status, 404);

  const stillThere = await requestJson(originalFetch, baseUrl, "/v1/devices", { headers: owner });
  assert.equal(stillThere.devices.length, 1, "the owner's device survives a stranger's delete");
});

test("the discovery endpoint identifies the gateway without authentication", async (t) => {
  // A controller has no credentials at the moment it needs this: it is deciding whether a
  // candidate address, from a UDP reply or a typed URL, is a gateway at all.
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/v1/discovery`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "agent-controller");
  assert.equal(body.claimRequired, true);
  assert.equal(typeof body.name, "string");
});
