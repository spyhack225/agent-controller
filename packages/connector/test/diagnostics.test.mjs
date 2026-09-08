import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { diagnose, tailscaleStatus } from "../src/diagnostics.mjs";

test("macOS Tailscale inspection uses a bounded read-only fallback and redacts peer data", async () => {
  const calls = [];
  const status = await tailscaleStatus({
    platform: "darwin",
    exec: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "tailscale") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { HostName: "private-mac", TailscaleIPs: ["100.64.0.1"] },
          Peer: { secret: { HostName: "private-peer" } },
          User: { 1: { LoginName: "private@example.com" } },
        }),
      };
    },
  });

  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    { executable: "tailscale", args: ["status", "--json"] },
    { executable: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", args: ["status", "--json"] },
  ]);
  assert.equal(calls[1].options.timeout, 3_000);
  assert.equal(calls[1].options.maxBuffer, 256 * 1024);
  assert.equal(calls[1].options.windowsHide, true);
  assert.deepEqual(status, {
    installed: true,
    connected: true,
    state: "running",
    optional: true,
    managedByConnector: false,
    serveManagedByConnector: false,
    guidance: [],
  });
  assert.doesNotMatch(JSON.stringify(status), /private-mac|private-peer|private@example|100\.64/u);
  assert.equal(calls.some(({ args }) => args.includes("up") || args.includes("serve") || args.includes("funnel")), false);
});

test("Windows Tailscale inspection returns static operator guidance without mutating the host", async () => {
  const calls = [];
  const status = await tailscaleStatus({
    platform: "win32",
    exec: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: JSON.stringify({ BackendState: "NeedsLogin", CurrentTailnet: { Name: "private-tailnet" } }) };
    },
  });

  assert.deepEqual(calls, [{ executable: "tailscale.exe", args: ["status", "--json"] }]);
  assert.equal(status.state, "needs_login");
  assert.equal(status.optional, true);
  assert.equal(status.guidance[0].operatorRequired, true);
  assert.match(status.guidance[0].message, /yourself/u);
  assert.doesNotMatch(JSON.stringify(status), /private-tailnet/u);
});

test("doctor treats missing Tailscale as optional and exposes safe setup guidance", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-tailscale-doctor-"));
  const commands = [];
  const report = await diagnose({
    stateDir,
    state: null,
    platform: "linux",
    exec: async (executable, args) => {
      commands.push([executable, ...args]);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.deepEqual(commands, [["tailscale", "status", "--json"]]);
  assert.equal(report.tailscale.state, "not_installed");
  assert.equal(report.tailscale.optional, true);
  assert.equal(report.tailscale.managedByConnector, false);
  assert.equal(report.tailscale.serveManagedByConnector, false);
  assert.deepEqual(report.checks.find((check) => check.id === "tailscale"), {
    id: "tailscale",
    ok: true,
    detail: "not_installed; optional and operator-managed",
  });
  assert.equal(report.healthy, false, "missing enrollment remains unhealthy even though Tailscale is optional");
});

test("malformed Tailscale JSON is reduced to a safe bounded state", async () => {
  const status = await tailscaleStatus({
    platform: "linux",
    exec: async () => ({ stdout: "not-json and not operator data" }),
  });
  assert.equal(status.installed, true);
  assert.equal(status.connected, false);
  assert.equal(status.state, "invalid_response");
  assert.equal(status.guidance[0].id, "inspect");
  assert.doesNotMatch(JSON.stringify(status), /not-json/u);
});
