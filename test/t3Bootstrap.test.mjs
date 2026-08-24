import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT3ServeArgs,
  connectGateway,
  parseT3StartupOutput,
  resolveHarness,
  selectedModel,
} from "../src/t3Bootstrap.mjs";

test("T3 bootstrap accepts built-in aliases and custom harnesses", () => {
  assert.equal(resolveHarness("codex").id, "openai");
  assert.equal(resolveHarness("claude-code").id, "anthropic");
  assert.equal(resolveHarness("cursor").instanceId, "cursor");
  assert.equal(resolveHarness("custom").instanceId, null);
});

test("T3 bootstrap keeps project setup optional and does not auto-add from cwd", () => {
  const args = buildT3ServeArgs({
    projectPath: null,
    baseDir: "/tmp/t3",
    port: 3773,
    tunnel: "local",
  });

  assert.deepEqual(args, [
    "serve",
    "--port",
    "3773",
    "--base-dir",
    "/tmp/t3",
    "--host",
    "127.0.0.1",
  ]);
  assert.equal(args.includes("--auto-bootstrap-project-from-cwd"), false);

  const tailscaleArgs = buildT3ServeArgs({
    projectPath: "/projects/example",
    baseDir: "/tmp/t3",
    port: 3773,
    tunnel: "tailscale",
  });
  assert.equal(tailscaleArgs.includes("--tailscale-serve"), true);
  assert.equal(tailscaleArgs.includes("--host"), false);
  assert.equal(tailscaleArgs.at(-1), "/projects/example");
});

test("T3 bootstrap parses headless startup details", () => {
  const parsed = parseT3StartupOutput(`
\u001b[32mT3 Code server is ready.\u001b[0m
Connection string: http://127.0.0.1:3775
Token: ABC123
Pairing URL: http://127.0.0.1:3775/pair#token=ABC123
`);

  assert.deepEqual(parsed, {
    connectionString: "http://127.0.0.1:3775",
    pairingToken: "ABC123",
    pairingUrl: "http://127.0.0.1:3775/pair#token=ABC123",
  });
});

test("selected harness can override T3's project default without restricting providers", () => {
  const project = {
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  };
  assert.deepEqual(selectedModel(resolveHarness("auto"), project), {
    instanceId: "codex",
    model: "gpt-5.4",
  });
  assert.deepEqual(selectedModel(resolveHarness("custom"), project, {
    instanceId: "my_provider",
    model: "my-model",
  }), {
    instanceId: "my_provider",
    model: "my-model",
  });
});

test("a connect code pairs the host without any platform credential", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {}, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      session: { id: "cxn_1", status: "completed" },
      environment: { id: "env_1", label: "Studio Mac", baseUrl: "https://mac.tailnet.ts.net" },
      catalogue: { instances: [] },
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const warnings = [];
  const result = await connectGateway({
    gatewayUrl: "https://gateway.example",
    connectCode: "ABCDE-FGHIJ",
    label: "Studio Mac",
    baseUrl: "https://mac.tailnet.ts.net",
    pairingToken: "pair_once",
    harness: "auto",
    // The platform realm is what launches a first thread, and a connect code deliberately does not
    // grant it — so this is a warning, not a silent no-op.
    initialPrompt: "Run the tests.",
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(requests.length, 1, "redeeming is the whole handoff; no follow-up call needs a token");
  assert.equal(requests[0].url, "https://gateway.example/v1/t3/connect-sessions/redeem");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.deepEqual(requests[0].body, {
    code: "ABCDE-FGHIJ",
    label: "Studio Mac",
    baseUrl: "https://mac.tailnet.ts.net",
    pairingToken: "pair_once",
  });
  assert.equal(result.gatewayToken, null);
  assert.equal(result.environment.id, "env_1");
  assert.equal(result.thread, null);
  assert.ok(warnings.some((message) => message.includes("--initial-prompt")));
});

test("connectGateway names the connect code as an authentication option", async () => {
  await assert.rejects(
    () => connectGateway({ gatewayUrl: "https://gateway.example", label: "Mac", baseUrl: "https://mac.example", harness: "auto" }),
    /--connect-code/u,
  );
});
