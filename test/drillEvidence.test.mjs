import assert from "node:assert/strict";
import test from "node:test";

import {
  DRILL_SCHEMA,
  DrillError,
  configurationFailureEvidence,
  createRequester,
  drillId,
  emitEvidence,
  errorDetailCode,
  failed,
  finishEvidence,
  normalizeBaseUrl,
  opaqueRef,
  passed,
  parseDrillArguments,
  requireFresh,
  requireStatus,
  skipped,
} from "../scripts/drill-common.mjs";

test("a check detail can never overwrite the envelope that records the outcome", () => {
  const check = passed("example", 5, {
    status: "aborted",
    name: "someone else",
    durationMs: 999,
    code: "looks_like_a_failure",
    httpStatus: 200,
    sessionStatus: "aborted",
  });
  assert.equal(check.name, "example");
  assert.equal(check.status, "passed");
  assert.equal(check.durationMs, 5);
  assert.equal(check.code, undefined);
  assert.equal(check.sessionStatus, "aborted");
  // httpStatus stays a legitimate observation on a passing check.
  assert.equal(check.httpStatus, 200);
  // A failing check takes its code and status from the envelope, never from a payload.
  const failure = failed("example", 5, "boom", 502);
  assert.equal(failure.status, "failed");
  assert.equal(failure.code, "boom");
  assert.equal(failure.httpStatus, 502);
  assert.equal(skipped("example", "exercise_flag_required").status, "skipped");
});

test("a record with a skipped check is never reported as passing", () => {
  const now = () => 1_000;
  const evidence = finishEvidence({
    drill: "example",
    mode: "preflight",
    checks: [passed("ran", 1), skipped("did_not_run", "exercise_flag_required")],
    startedAtMs: 0,
    now,
    target: "https://staging.example.test",
  });
  assert.equal(evidence.schema, DRILL_SCHEMA);
  assert.equal(evidence.result, "failed");
  assert.deepEqual(evidence.summary, { passed: 1, failed: 0, skipped: 1 });
  assert.deepEqual(evidence.target, { origin: "https://staging.example.test" });

  const clean = finishEvidence({
    drill: "example",
    mode: "exercise",
    checks: [passed("ran", 1)],
    startedAtMs: 0,
    now,
    target: "https://staging.example.test",
  });
  assert.equal(clean.result, "passed");

  const broken = finishEvidence({
    drill: "example",
    mode: "exercise",
    checks: [failed("ran", 1, "boom", 502)],
    startedAtMs: 0,
    now,
    target: null,
  });
  assert.equal(broken.result, "failed");
  assert.equal(broken.target, null);
});

test("configuration failure evidence is a failed preflight record, not an empty pass", () => {
  const evidence = configurationFailureEvidence({ drill: "example", code: "base_url_required" });
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.mode, "preflight");
  assert.equal(evidence.checks[0].code, "base_url_required");
});

test("origin validation refuses credentials, queries, paths, and bare addresses in the target", () => {
  assert.equal(normalizeBaseUrl({ baseUrl: "https://staging.example.test" }).origin, "https://staging.example.test");
  for (const [baseUrl, code] of [
    ["", "base_url_required"],
    ["not a url", "base_url_invalid"],
    ["https://user:pass@staging.example.test", "base_url_must_be_origin"],
    ["https://staging.example.test/?token=abc", "base_url_must_be_origin"],
    ["https://staging.example.test/v1", "base_url_must_be_origin"],
    ["http://staging.example.test", "https_required"],
    ["https://203.0.113.10", "hostname_required"],
  ]) {
    assert.throws(() => normalizeBaseUrl({ baseUrl }), (error) => error.code === code, `${baseUrl} -> ${code}`);
  }
  assert.equal(normalizeBaseUrl({ baseUrl: "http://127.0.0.1:3996", allowHttpLoopback: true }).port, "3996");
  assert.throws(
    () => normalizeBaseUrl({ baseUrl: "http://staging.example.test", allowHttpLoopback: true }),
    (error) => error.code === "https_required",
  );
});

test("the shared parser exposes flags, env defaults, and file sources without secret-bearing options", () => {
  const options = {
    environment: { EXAMPLE_TOKEN: "env-token" },
    envDefaults: { accessToken: "EXAMPLE_TOKEN" },
    valueOptions: { "--base-url": "baseUrl" },
    flagOptions: { "--exercise": "exercise" },
    fileOptions: {
      "--access-token-file": { valueKey: "accessToken", pathKey: "accessTokenFile", conflictCode: "one_access_token_source_required" },
    },
  };
  const parsed = parseDrillArguments(["--base-url", "https://staging.example.test"], options);
  assert.equal(parsed.accessToken, "env-token");
  assert.equal(parsed.exercise, false);
  assert.equal(parseDrillArguments(["--exercise"], options).exercise, true);
  assert.equal(parseDrillArguments(["-h"], options).help, true);
  assert.throws(
    () => parseDrillArguments(["--access-token-file", "/tmp/t"], options),
    (error) => error.code === "one_access_token_source_required",
  );
  assert.throws(() => parseDrillArguments(["--nope"], options), (error) => error.code === "unknown_option");
  assert.throws(() => parseDrillArguments(["--base-url", "--exercise"], options), (error) => error.code === "option_value_required");
});

test("bounded helpers hide upstream detail and expose only opaque references", () => {
  assert.match(opaqueRef("env_private_identifier"), /^sha256:[0-9a-f]{16}$/u);
  assert.notEqual(opaqueRef("a"), opaqueRef("b"));
  assert.match(drillId("drill-x"), /^drill-x-[0-9a-f]{24}$/u);

  assert.equal(errorDetailCode({ error: { details: { code: "idempotency_conflict" } } }), "idempotency_conflict");
  assert.equal(errorDetailCode({ error: { message: "private detail" } }), null);
  assert.equal(errorDetailCode(null), null);

  assert.throws(() => requireStatus({ status: 500 }, 200, "boom"), (error) => error.code === "boom" && error.httpStatus === 500);
  assert.doesNotThrow(() => requireStatus({ status: 202 }, [200, 202], "boom"));

  const now = Date.now();
  assert.doesNotThrow(() => requireFresh(new Date(now - 1_000).toISOString(), 60_000, now, "stale"));
  assert.throws(() => requireFresh(new Date(now - 120_000).toISOString(), 60_000, now, "stale"), (error) => error.code === "stale");
  assert.throws(() => requireFresh("not a date", 60_000, now, "stale"), (error) => error.code === "stale");
});

test("the requester bounds the response, never follows a redirect, and reports a timeout as a code", async () => {
  const oversized = createRequester({
    baseUrl: new URL("https://staging.example.test"),
    fetchImpl: async () => new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024) } }),
  });
  await assert.rejects(() => oversized.request("/v1/commands"), (error) => error.code === "response_too_large");

  const broken = createRequester({
    baseUrl: new URL("https://staging.example.test"),
    fetchImpl: async () => new Response("not json", { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => broken.request("/v1/commands"), (error) => error.code === "invalid_json_response");

  const aborted = createRequester({
    baseUrl: new URL("https://staging.example.test"),
    fetchImpl: async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await assert.rejects(() => aborted.request("/v1/commands"), (error) => error.code === "request_timeout");

  const refused = createRequester({
    baseUrl: new URL("https://staging.example.test"),
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 203.0.113.1:443 with private host detail");
    },
  });
  await assert.rejects(() => refused.request("/v1/commands"), (error) => (
    error instanceof DrillError && error.code === "request_failed" && !error.message.includes("203.0.113.1")
  ));

  let seen = null;
  const inspected = createRequester({
    baseUrl: new URL("https://staging.example.test"),
    fetchImpl: async (url, init) => {
      seen = { url: url.toString(), init };
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  await inspected.request("/v1/media/uploads", { method: "PUT", rawBody: Buffer.from([1, 2, 3]), contentType: "image/png" });
  assert.equal(seen.url, "https://staging.example.test/v1/media/uploads");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers["content-type"], "image/png");
});

test("evidence is emitted as pretty JSON on the caller's writer", async () => {
  const written = [];
  const evidence = await emitEvidence({ schema: DRILL_SCHEMA, result: "passed" }, (text) => written.push(text));
  assert.equal(evidence.result, "passed");
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).schema, DRILL_SCHEMA);
  assert.ok(written[0].endsWith("\n"));
});
