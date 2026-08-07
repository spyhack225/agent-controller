import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";

test("onboarding API persists progress and completes only after operational readiness", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin === "https://t3.example") {
      return jsonResponse({
        projects: [{
          id: "project_1",
          title: "Agent Controller",
          workspaceRoot: "/work/agent-controller",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        }],
        threads: [],
      });
    }
    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const session = await request(baseUrl, "/v1/users/dev", {
    method: "POST",
    body: { userId: "user_onboarding", email: "onboarding@example.test" },
  });
  const headers = { authorization: `Bearer ${session.apiToken.secret}` };

  const initial = await request(baseUrl, "/v1/onboarding", { headers });
  assert.equal(initial.onboarding.status, "not_started");
  assert.equal(initial.readiness.ready, false);

  const paused = await request(baseUrl, "/v1/onboarding", {
    method: "PUT",
    headers,
    body: { status: "paused", currentStep: "host" },
  });
  assert.equal(paused.onboarding.status, "paused");
  assert.equal(paused.onboarding.currentStep, "host");

  const restored = await request(baseUrl, "/v1/onboarding", { headers });
  assert.equal(restored.onboarding.status, "paused");
  assert.equal(restored.onboarding.currentStep, "host");

  const resumed = await request(baseUrl, "/v1/onboarding", {
    method: "PUT",
    headers,
    body: { status: "in_progress", currentStep: "host" },
  });
  assert.equal(resumed.onboarding.status, "in_progress");
  assert.equal(resumed.onboarding.currentStep, "host");

  const prematureResponse = await fetch(new URL("/v1/onboarding", baseUrl), {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(prematureResponse.status, 409);

  const environment = await request(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: {
      label: "Onboarding T3",
      baseUrl: "https://t3.example",
      accessToken: "t3-access-token",
    },
  });
  await request(baseUrl, `/v1/t3/environments/${environment.environment.id}/check`, {
    method: "POST",
    headers,
    body: {},
  });

  const fakeCompletionResponse = await fetch(new URL("/v1/onboarding", baseUrl), {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      currentStep: "ready",
      networkMode: "local",
      networkUrl: "https://t3.example",
      provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
      workspace: {
        path: "/work/agent-controller",
        title: "Agent Controller",
        projectId: "project_1",
      },
      environmentId: environment.environment.id,
      firstThreadId: "thread_not_dispatched",
      device: { mode: "browser_only", deviceId: null, credentialConfirmed: false },
    }),
  });
  assert.equal(fakeCompletionResponse.status, 409);

  const launch = await request(
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/threads`,
    {
      method: "POST",
      headers,
      body: {
        projectId: "project_1",
        text: "Confirm onboarding readiness.",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      },
    },
  );
  assert.equal(launch.command.status, "dispatched");

  const completed = await request(baseUrl, "/v1/onboarding", {
    method: "PUT",
    headers,
    body: {
      status: "completed",
      currentStep: "ready",
      networkMode: "local",
      networkUrl: "https://t3.example",
      provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
      workspace: {
        path: "/work/agent-controller",
        title: "Agent Controller",
        projectId: "project_1",
      },
      environmentId: environment.environment.id,
      firstThreadId: launch.threadId,
      device: { mode: "browser_only", deviceId: null, credentialConfirmed: false },
    },
  });

  assert.equal(completed.onboarding.status, "completed");
  assert.equal(completed.onboarding.currentStep, "ready");
  assert.equal(completed.readiness.ready, true);

  const audit = await request(baseUrl, "/v1/audit", { headers });
  assert.equal(audit.events.some((event) => event.action === "user.onboarding_completed"), true);
});

async function request(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, payload?.error?.message);
  return payload;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}
