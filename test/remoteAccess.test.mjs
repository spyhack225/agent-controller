import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTailscaleTunnelArgs,
  classifyTailscaleTunnelStatus,
  configurePrivateTailscaleServe,
  inspectRemoteAccess,
  publicTunnelAllowed,
  tailscaleConnection,
  tailscaleHttpsUrl,
  updateRemoteAccessEnv,
} from "../src/remoteAccess.mjs";

test("plain Tailscale status distinguishes private Serve from misleading shared JSON", async () => {
  assert.equal(classifyTailscaleTunnelStatus("https://host.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3996"), "serve");
  assert.equal(classifyTailscaleTunnelStatus("Funnel on: available on the internet"), "funnel");
  const calls = [];
  await configurePrivateTailscaleServe({ enabled: true, gatewayPort: 3996 }, {
    findExecutable: async () => "/usr/bin/tailscale",
    runCommand: async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return { stdout: JSON.stringify({ BackendState: "Running",
        Self: { DNSName: "host.example.ts.net.", TailscaleIPs: ["100.64.0.1"] } }) };
      if (args.join(" ") === "serve status") return { stdout: "https://host.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3996" };
      return { stdout: "" };
    },
  });
  assert.deepEqual(calls, [
    ["status", "--json"],
    ["funnel", "--https=443", "off"],
    ["serve", "--bg", "--https=443", "http://127.0.0.1:3996"],
    ["serve", "status"],
  ]);
});

test("Tailscale Serve and Funnel proxy only the loopback gateway", () => {
  assert.deepEqual(buildTailscaleTunnelArgs({ mode: "serve", gatewayPort: 3996 }), [
    "serve",
    "--bg",
    "--https=443",
    "http://127.0.0.1:3996",
  ]);
  assert.deepEqual(buildTailscaleTunnelArgs({ mode: "funnel", gatewayPort: 4996, httpsPort: 8443 }), [
    "funnel",
    "--bg",
    "--https=8443",
    "http://127.0.0.1:4996",
  ]);
  assert.deepEqual(buildTailscaleTunnelArgs({ mode: "serve-off" }), [
    "serve",
    "--https=443",
    "off",
  ]);
});

test("Tailscale status becomes a stable HTTPS endpoint without leaking raw state", () => {
  const status = {
    BackendState: "Running",
    Self: {
      DNSName: "studio-mac.example.ts.net.",
      TailscaleIPs: ["100.64.0.4"],
    },
  };
  assert.deepEqual(tailscaleConnection(status), {
    connected: true,
    backendState: "Running",
    ips: ["100.64.0.4"],
    dnsName: "studio-mac.example.ts.net",
  });
  assert.equal(tailscaleHttpsUrl(status), "https://studio-mac.example.ts.net");
  assert.equal(tailscaleHttpsUrl(status, 8443), "https://studio-mac.example.ts.net:8443");
});

test("remote access env updates preserve existing values and append Clerk origin once", () => {
  const source = [
    "HOST=0.0.0.0",
    "PUBLIC_BASE_URL=http://192.168.1.25:3996",
    "CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:3996",
    "SECRET=keep-me",
    "",
  ].join("\n");

  const updated = updateRemoteAccessEnv(source, {
    publicBaseUrl: "https://studio-mac.example.ts.net/path-is-ignored",
  });
  assert.match(updated, /^PUBLIC_BASE_URL=https:\/\/studio-mac\.example\.ts\.net$/mu);
  assert.match(
    updated,
    /^CLERK_AUTHORIZED_PARTIES=http:\/\/127\.0\.0\.1:3996,https:\/\/studio-mac\.example\.ts\.net$/mu,
  );
  assert.match(updated, /^SECRET=keep-me$/mu);
  assert.equal(
    updateRemoteAccessEnv(updated, { publicBaseUrl: "https://studio-mac.example.ts.net" }),
    updated,
  );
});

test("public Funnel requires production authentication unless explicitly acknowledged", () => {
  assert.deepEqual(publicTunnelAllowed({ AUTH_PROVIDER: "clerk" }), {
    allowed: true,
    authProvider: "clerk",
  });
  assert.deepEqual(publicTunnelAllowed({ AUTH_PROVIDER: "dev" }), {
    allowed: false,
    authProvider: "dev",
  });
  assert.equal(publicTunnelAllowed({ AUTH_PROVIDER: "dev" }, { allowPublic: true }).allowed, true);
});

test("remote access inspection reports the exact missing machine step", async () => {
  const missing = await inspectRemoteAccess({ port: 3996 }, {
    findExecutable: async () => null,
    now: () => new Date("2026-08-08T17:00:00.000Z"),
  });
  assert.equal(missing.tailscale.installed, false);
  assert.equal(missing.tailscale.nextStep, "install");
  assert.equal(missing.tailscale.ready, false);

  const runCommand = async (_executable, args) => {
    if (args[0] === "status") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: {
            DNSName: "studio-mac.example.ts.net.",
            TailscaleIPs: ["100.64.0.4"],
          },
        }),
      };
    }
    if (args[0] === "serve") {
      return { stdout: JSON.stringify({ TCP: { "443": { Web: { Handlers: { "/": { Proxy: "http://127.0.0.1:3996" } } } } } }) };
    }
    return { stdout: "{}" };
  };
  const ready = await inspectRemoteAccess({
    port: 3996,
    publicBaseUrl: "https://studio-mac.example.ts.net",
  }, {
    findExecutable: async () => "/usr/bin/tailscale",
    runCommand,
    now: () => new Date("2026-08-08T17:00:00.000Z"),
  });
  assert.equal(ready.tailscale.connected, true);
  assert.equal(ready.tailscale.serve.active, true);
  assert.equal(ready.tailscale.funnel.active, false);
  assert.equal(ready.tailscale.nextStep, "ready");
  assert.equal(ready.tailscale.ready, true);
});
