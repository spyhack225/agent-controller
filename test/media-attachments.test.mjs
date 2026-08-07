import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createMediaAccessToken, verifyMediaAccessToken } from "../src/mediaLinks.mjs";

// A 1x1 PNG. Small enough to be inlined, real enough to round-trip byte for byte.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const MEDIA_CONFIG = {
  maxMediaBytes: 64 * 1024,
  mediaSigningKey: "test-media-signing-key",
  mediaLinkTtlSeconds: 900,
  mediaInlineMaxBytes: 256 * 1024,
  defaultMediaRetentionDays: 30,
  demoMode: false,
};

test("camera prompt delivers the image to T3 as a real attachment", async (t) => {
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

  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-attach-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "snapshot.png",
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_media",
      intent: {
        type: "camera_prompt",
        prompt: "What is in this photo?",
        mediaUploadId: upload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);

  const attachments = dispatches[0].message.attachments;
  assert.equal(attachments.length, 1, "the dispatched turn must carry exactly one attachment");

  const [attachment] = attachments;
  assert.equal(attachment.type, "image");
  assert.equal(attachment.mediaId, upload.media.id);
  assert.equal(attachment.contentType, "image/png");
  assert.equal(attachment.sha256, upload.media.sha256);
  assert.equal(attachment.name, "snapshot.png");

  // The agent must receive the actual bytes, not just metadata about them.
  assert.equal(attachment.dataBase64, PNG_BASE64);
  assert.ok(attachment.url, "attachment must carry a signed callback URL");
  assert.ok(attachment.urlExpiresAt);
});

test("signed media URL serves bytes without a session and rejects tampering", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-signed-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const upload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const token = createMediaAccessToken({
    mediaId: upload.media.id,
    userId: "user_dev",
    secret: MEDIA_CONFIG.mediaSigningKey,
    expiresAtMs: Date.now() + 60_000,
  });

  // No authorization header at all: this is what the T3 environment does.
  const contentUrl = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  contentUrl.searchParams.set("token", token);
  const response = await fetch(contentUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("base64"), PNG_BASE64);

  const tampered = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  tampered.searchParams.set("token", `${token.slice(0, -4)}AAAA`);
  assert.equal((await fetch(tampered)).status, 403);

  const missingToken = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  assert.equal((await fetch(missingToken)).status, 403);
});

test("a media token is scoped to one media id and expires", () => {
  const secret = "signing-secret";
  const token = createMediaAccessToken({
    mediaId: "media_a",
    userId: "user_1",
    secret,
    expiresAtMs: Date.now() + 60_000,
  });

  assert.deepEqual(
    verifyMediaAccessToken({ token, secret }),
    { mediaId: "media_a", userId: "user_1", expiresAtMs: verifyMediaAccessToken({ token, secret }).expiresAtMs },
  );
  assert.equal(verifyMediaAccessToken({ token, secret: "wrong-secret" }), null);
  assert.equal(
    verifyMediaAccessToken({ token, secret, now: Date.now() + 120_000 }),
    null,
    "an expired token must not verify",
  );

  const expired = createMediaAccessToken({
    mediaId: "media_b",
    userId: "user_1",
    secret,
    expiresAtMs: Date.now() - 1,
  });
  assert.equal(verifyMediaAccessToken({ token: expired, secret }), null);
});

test("stored command records omit media bytes and the signed URL", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") return jsonResponse({ status: "accepted" }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-redact-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_media",
      intent: { type: "camera_prompt", mediaUploadId: upload.media.id },
    },
  });

  const stored = dispatched.command.normalized.message.attachments[0];
  assert.equal(stored.mediaId, upload.media.id);
  assert.equal(stored.sha256, upload.media.sha256);
  assert.equal(stored.dataBase64, undefined, "media bytes must not be persisted on the command");
  assert.equal(stored.url, undefined, "a live signed URL must not be persisted on the command");
  assert.equal(stored.inlined, true);
  assert.equal(stored.urlIssued, true);

  const serialized = JSON.stringify(dispatched.command);
  assert.ok(!serialized.includes(PNG_BASE64), "command payload must not embed the image bytes");
});

test("text-only prompts still dispatch with no attachments", async (t) => {
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

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir: tmpdir() } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_text",
      intent: { type: "agent_prompt", text: "Run the tests." },
    },
  });

  assert.deepEqual(dispatches[0].message.attachments, []);
});

test("openai transcription provider transcribes stored audio", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ text: "  Deploy the staging branch.  " }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-stt-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-test",
      transcriptionUrl: "https://stt.example/v1/audio/transcriptions",
      transcriptionModel: "whisper-1",
      transcriptionTimeoutMs: 5000,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("fake audio bytes").toString("base64"),
      originalName: "clip.webm",
    },
  });

  const result = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.transcript, "Deploy the staging branch.");
  assert.equal(result.media.transcript, "Deploy the staging branch.");

  const [call] = calls;
  assert.equal(call.url, "https://stt.example/v1/audio/transcriptions");
  assert.equal(call.init.headers.authorization, "Bearer sk-test");
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.body.get("model"), "whisper-1");
});

test("transcription failures surface as 502 and record the error", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "rate limited" }, 429);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "agent-controller-stt-fail-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-test",
      transcriptionTimeoutMs: 5000,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("fake audio bytes").toString("base64"),
    },
  });

  const response = await originalFetch(new URL(`/v1/media/${upload.media.id}/transcribe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
  });
  assert.equal(response.status, 502);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const stored = listed.media.find((item) => item.id === upload.media.id);
  assert.equal(stored.processing.transcriptionStatus, "failed");
  assert.match(stored.processing.lastError, /HTTP 429/u);
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}: ${text}`);
  }
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
