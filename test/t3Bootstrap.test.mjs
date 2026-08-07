import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT3ServeArgs,
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
