import assert from "node:assert/strict";
import test from "node:test";
import { CompletedRequestCache, decodeCloudFrame, encodeFrame, MAX_FRAME_BYTES } from "../src/protocol.mjs";
import { redact } from "../src/redact.mjs";

test("protocol parser rejects invalid versions and oversized frames", () => {
  assert.throws(() => decodeCloudFrame(JSON.stringify({ protocolVersion: 2, type: "welcome", connectionId: "x", body: {} })), /invalid protocol/);
  assert.throws(() => encodeFrame({ protocolVersion: 1, type: "event", connectionId: "x", body: { eventId: "event", environmentId: "env", payload: "x".repeat(MAX_FRAME_BYTES) } }), /exceeds/);
  assert.throws(() => encodeFrame({ protocolVersion: 1, type: "response.failed", connectionId: "x", body: { requestId: "request", code: "failed", retryable: true } }), /failedAt/);
});

test("completed request cache is bounded and expires", () => {
  let now = 1;
  const cache = new CompletedRequestCache({ maxEntries: 2, ttlMs: 10, now: () => now });
  cache.set("a", { value: 1 }); cache.set("b", { value: 2 }); cache.set("c", { value: 3 });
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b").value, 2);
  now = 20;
  assert.equal(cache.get("c"), null);
});

test("redaction recursively removes credentials", () => {
  assert.deepEqual(redact({ token: "abc", nested: { authorization: "Bearer abc", detail: "Connector id.secret" } }), {
    token: "[REDACTED]", nested: { authorization: "[REDACTED]", detail: "[REDACTED:CREDENTIAL]" },
  });
});
