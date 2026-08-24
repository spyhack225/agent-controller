import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.mjs";
import { collectProviderCatalogue } from "../src/t3Bootstrap.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// The real provider caches captured from a live T3 host.
const CACHES = JSON.parse(readFileSync(join(FIXTURES, "t3-provider-caches.json"), "utf8"));
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, "t3-snapshot.json"), "utf8"));

async function writeCacheDir(caches = CACHES) {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-base-"));
  await mkdir(join(baseDir, "caches"), { recursive: true });
  for (const cache of caches) {
    await writeFile(join(baseDir, "caches", `${cache.instanceId}.json`), JSON.stringify(cache, null, 2));
  }
  return baseDir;
}

test("the host collector reads T3's real provider cache directory", async (t) => {
  const baseDir = await writeCacheDir();
  t.after(() => rm(baseDir, { recursive: true, force: true }));

  const collected = await collectProviderCatalogue(baseDir);
  assert.equal(collected.length, 5);
  assert.deepEqual(
    collected.map((entry) => entry.instanceId).sort(),
    ["claudeAgent", "codex", "cursor", "grok", "opencode"],
  );
  assert.equal(collected.find((entry) => entry.instanceId === "codex").models.length, 8);
});

test("a missing or unreadable cache directory degrades instead of failing pairing", async (t) => {
  assert.deepEqual(await collectProviderCatalogue(join(tmpdir(), "definitely-not-a-t3-base-dir")), []);

  const baseDir = await writeCacheDir([]);
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(join(baseDir, "caches", "broken.json"), "{ not json");
  await writeFile(join(baseDir, "caches", "notes.txt"), "ignored");
  assert.deepEqual(await collectProviderCatalogue(baseDir), []);
});

test("the filename supplies the instance id when a cache omits it", async (t) => {
  const baseDir = await writeCacheDir([]);
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(
    join(baseDir, "caches", "legacyProvider.json"),
    JSON.stringify({ displayName: "Legacy", status: "ready", models: [] }),
  );

  const [collected] = await collectProviderCatalogue(baseDir);
  assert.equal(collected.instanceId, "legacyProvider");
});

test("registering the catalogue makes real harnesses and models available", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/orchestration/snapshot") {
      return jsonResponse(SNAPSHOT, 200);
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
    body: { label: "Mac T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const environmentId = environment.environment.id;

  // Before registration only what the snapshot revealed is visible.
  const before = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/harnesses`, {
    headers: authHeaders,
  });
  assert.equal(before.catalogueSource, "snapshot-only");
  assert.deepEqual(before.harnesses.map((harness) => harness.instanceId), ["codex"]);

  const registered = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
    method: "PUT",
    headers: authHeaders,
    body: { source: "setup-script", instances: CACHES },
  });
  assert.equal(registered.catalogue.instances.length, 5);

  const after = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/harnesses`, {
    headers: authHeaders,
  });
  assert.equal(after.catalogueSource, "registered");
  assert.deepEqual(after.usable, ["codex", "claudeAgent"]);

  const codex = after.harnesses.find((harness) => harness.instanceId === "codex");
  assert.equal(codex.label, "Codex");
  assert.ok(codex.models.some((model) => model.slug === "gpt-5.6-sol"));
  assert.equal(codex.models.find((model) => model.slug === "gpt-5.6-sol").options[0].id, "reasoningEffort");

  const grok = after.harnesses.find((harness) => harness.instanceId === "grok");
  assert.equal(grok.available, false);
  assert.equal(grok.unavailableReason, "Not installed on the T3 host.");

  // The failed sessions on this environment are now visible instead of silent.
  assert.equal(after.sessionFailures.length, 3);
  assert.match(after.sessionFailures[0].message, /not supported when using Codex/u);
});

test("launching with a model T3 does not offer automatically uses the provider's latest model", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/orchestration/snapshot") return jsonResponse(SNAPSHOT, 200);
    if (path === "/api/orchestration/dispatch") {
      dispatched += 1;
      return jsonResponse({ sequence: dispatched }, 200);
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
    body: { label: "Mac T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const environmentId = environment.environment.id;
  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
    method: "PUT",
    headers: authHeaders,
    body: { instances: CACHES },
  });

  const projectId = SNAPSHOT.projects[0].id;

  // This is the exact selection that silently failed on the real environment.
  const response = await originalFetch(new URL(`/v1/t3/environments/${environmentId}/threads`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ projectId, text: "hi", modelSelection: { instanceId: "codex", model: "gpt-5..6" } }),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.modelSelection.model, "gpt-5.6-sol");
  assert.deepEqual(body.modelRecovery.requested, { instanceId: "codex", model: "gpt-5..6" });
  assert.equal(body.modelRecovery.selected.model, "gpt-5.6-sol");
  assert.match(body.modelRecovery.reason, /Unknown model "gpt-5\.\.6"/u);
  assert.equal(dispatched, 2, "only the recovered model reaches T3");

  // A real model still launches.
  const ok = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/threads`, {
    method: "POST",
    headers: authHeaders,
    body: { projectId, text: "hi", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } },
  });
  assert.equal(ok.command.status, "dispatched");
  assert.equal(dispatched, 4, "each launch dispatches thread.create plus thread.turn.start");

  // Omitting the selection also chooses the first model in T3's ordered Codex catalogue instead
  // of the project's older saved default.
  const automatic = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/threads`, {
    method: "POST",
    headers: authHeaders,
    body: { projectId, text: "use the current default" },
  });
  assert.equal(automatic.modelSelection.model, "gpt-5.6-sol");
  assert.equal(automatic.modelRecovery, null);
  assert.equal(dispatched, 6);
});

test("re-pairing an environment keeps the registered catalogue", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mac T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const environmentId = created.environment.id;

  await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
    method: "PUT",
    headers: authHeaders,
    body: { instances: CACHES },
  });

  const updated = await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}`, {
    method: "PUT",
    headers: authHeaders,
    body: { label: "Renamed T3" },
  });
  assert.equal(updated.environment.label, "Renamed T3");

  const catalogue = await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
    headers: authHeaders,
  });
  assert.equal(catalogue.catalogue.instances.length, 5, "the catalogue must survive an update");
});

test("catalogue registration rejects a malformed body", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mac T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const path = `/v1/t3/environments/${created.environment.id}/catalogue`;

  for (const body of [{}, { instances: "nope" }, { instances: [{ noInstanceId: true }] }]) {
    const response = await fetch(new URL(path, baseUrl), {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    await response.text();
    assert.equal(response.status, 400);
  }
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
