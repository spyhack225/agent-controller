import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const TAILSCALE_TUNNEL_MODES = new Set([
  "serve",
  "funnel",
  "serve-off",
  "funnel-off",
]);

export function buildTailscaleTunnelArgs({ mode, gatewayPort = 3996, httpsPort = 443 }) {
  if (!TAILSCALE_TUNNEL_MODES.has(mode)) {
    throw new Error(`Unsupported tunnel mode '${mode}'.`);
  }
  assertPort(gatewayPort, "gateway port");
  assertPort(httpsPort, "HTTPS port");

  const command = mode.startsWith("funnel") ? "funnel" : "serve";
  if (mode.endsWith("-off")) {
    return [command, `--https=${httpsPort}`, "off"];
  }
  return [
    command,
    "--bg",
    `--https=${httpsPort}`,
    `http://127.0.0.1:${gatewayPort}`,
  ];
}

export function tailscaleHttpsUrl(status, httpsPort = 443) {
  assertPort(httpsPort, "HTTPS port");
  const dnsName = String(status?.Self?.DNSName ?? "").trim().replace(/\.$/u, "");
  if (!dnsName) return null;
  return `https://${dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
}

export function tailscaleConnection(status) {
  const backendState = String(status?.BackendState ?? "Unknown");
  const ips = Array.isArray(status?.Self?.TailscaleIPs)
    ? status.Self.TailscaleIPs.filter((value) => typeof value === "string")
    : [];
  return {
    connected: backendState === "Running" && ips.length > 0,
    backendState,
    ips,
    dnsName: String(status?.Self?.DNSName ?? "").trim().replace(/\.$/u, "") || null,
  };
}

export function localGatewayUrls(port = 3996) {
  assertPort(port, "gateway port");
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

export function publicTunnelAllowed(env, { allowPublic = false } = {}) {
  const authProvider = env.AUTH_PROVIDER
    ?? (env.CLERK_SECRET_KEY ? "clerk" : "dev");
  return {
    allowed: authProvider === "clerk" || allowPublic,
    authProvider,
  };
}

export function updateRemoteAccessEnv(source, {
  publicBaseUrl,
  appendAuthorizedParty = true,
} = {}) {
  if (!publicBaseUrl) return source;
  const parsed = new URL(publicBaseUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Remote access URL must use HTTPS.");
  }

  let next = upsertEnvValue(source, "PUBLIC_BASE_URL", parsed.origin);
  if (appendAuthorizedParty) {
    const current = readEnvValue(next, "CLERK_AUTHORIZED_PARTIES");
    const values = current.split(",").map((value) => value.trim()).filter(Boolean);
    if (!values.includes(parsed.origin)) values.push(parsed.origin);
    next = upsertEnvValue(next, "CLERK_AUTHORIZED_PARTIES", values.join(","));
  }
  return next;
}

export async function updateRemoteAccessEnvFile(path, input) {
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = updateRemoteAccessEnv(source, input);
  if (next !== source) await writeFile(path, next, { mode: 0o600 });
  return { changed: next !== source };
}

export async function findTailscaleExecutable(env = process.env) {
  const candidates = [];
  for (const directory of String(env.PATH ?? "").split(":").filter(Boolean)) {
    candidates.push(join(directory, "tailscale"));
  }
  candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the known CLI locations.
    }
  }
  return null;
}

export async function inspectRemoteAccess({
  host = "127.0.0.1",
  port = 3996,
  publicBaseUrl = null,
} = {}, {
  findExecutable = findTailscaleExecutable,
  runCommand = runTailscaleCommand,
  now = () => new Date(),
} = {}) {
  assertPort(port, "gateway port");
  const gateway = {
    host,
    port,
    loopbackUrl: `http://127.0.0.1:${port}`,
    lanUrls: localGatewayUrls(port),
    publicBaseUrl: publicBaseUrl ?? null,
  };
  const executable = await findExecutable();
  if (!executable) {
    return remoteAccessSnapshot({
      gateway,
      checkedAt: now().toISOString(),
      installed: false,
      nextStep: "install",
    });
  }

  let status;
  try {
    const result = await runCommand(executable, ["status", "--json"]);
    status = JSON.parse(result.stdout);
  } catch (error) {
    return remoteAccessSnapshot({
      gateway,
      checkedAt: now().toISOString(),
      installed: true,
      connected: false,
      backendState: "Unavailable",
      error: safeCommandError(error),
      nextStep: "connect",
    });
  }

  const connection = tailscaleConnection(status);
  const httpsUrl = tailscaleHttpsUrl(status);
  if (!connection.connected) {
    return remoteAccessSnapshot({
      gateway,
      checkedAt: now().toISOString(),
      installed: true,
      connected: false,
      backendState: connection.backendState,
      dnsName: connection.dnsName,
      ips: connection.ips,
      httpsUrl,
      nextStep: "connect",
    });
  }

  const tunnel = await readTunnelStatus(executable, port, runCommand);
  const serve = { active: tunnel.active && tunnel.mode === "serve", statusAvailable: tunnel.statusAvailable };
  const funnel = { active: tunnel.active && tunnel.mode === "funnel", statusAvailable: tunnel.statusAvailable };
  const mode = tunnel.mode;
  const publicBaseUrlConfigured = sameOrigin(publicBaseUrl, httpsUrl);
  return remoteAccessSnapshot({
    gateway,
    checkedAt: now().toISOString(),
    installed: true,
    connected: true,
    backendState: connection.backendState,
    dnsName: connection.dnsName,
    ips: connection.ips,
    httpsUrl,
    serve,
    funnel,
    mode,
    publicBaseUrlConfigured,
    ready: Boolean(mode && publicBaseUrlConfigured),
    nextStep: !mode ? "enable" : !publicBaseUrlConfigured ? "restart" : "ready",
  });
}

async function readTunnelStatus(executable, gatewayPort, runCommand) {
  try {
    const [json, plain] = await Promise.all([
      runCommand(executable, ["serve", "status", "--json"]),
      runCommand(executable, ["serve", "status"]),
    ]);
    const active = outputTargetsGateway(json.stdout, gatewayPort) || outputTargetsGateway(plain.stdout, gatewayPort);
    return {
      active,
      mode: active ? classifyTailscaleTunnelStatus(plain.stdout) : null,
      statusAvailable: true,
    };
  } catch {
    return { active: false, mode: null, statusAvailable: false };
  }
}

export function classifyTailscaleTunnelStatus(output) {
  const text = String(output ?? "").toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("tailnet only")) return "serve";
  if (text.includes("funnel") || text.includes("public internet") || text.includes("available on the internet")) {
    return "funnel";
  }
  return "serve";
}

export async function configurePrivateTailscaleServe({ enabled, gatewayPort = 3996, httpsPort = 443 } = {}, {
  findExecutable = findTailscaleExecutable,
  runCommand = runTailscaleCommand,
} = {}) {
  const executable = await findExecutable();
  if (!executable) throw new Error("Tailscale CLI was not found.");
  const status = JSON.parse((await runCommand(executable, ["status", "--json"])).stdout);
  const connection = tailscaleConnection(status);
  if (!connection.connected) throw new Error(`Tailscale is not connected (state: ${connection.backendState}).`);
  if (enabled) {
    // Tailscale uses the same Serve config surface for Funnel. Explicitly disable Funnel first,
    // then verify the human-readable marker so a private request cannot accidentally remain public.
    await runCommand(executable, buildTailscaleTunnelArgs({ mode: "funnel-off", gatewayPort, httpsPort }));
    await runCommand(executable, buildTailscaleTunnelArgs({ mode: "serve", gatewayPort, httpsPort }));
    const verified = await runCommand(executable, ["serve", "status"]);
    if (classifyTailscaleTunnelStatus(verified.stdout) !== "serve"
      || !String(verified.stdout).toLowerCase().includes("tailnet only")) {
      throw new Error("Tailscale Serve did not confirm a tailnet-only mapping.");
    }
  } else {
    await runCommand(executable, buildTailscaleTunnelArgs({ mode: "serve-off", gatewayPort, httpsPort }));
  }
  return { enabled: Boolean(enabled), httpsUrl: enabled ? tailscaleHttpsUrl(status, httpsPort) : null };
}

async function runTailscaleCommand(executable, args) {
  return await execFile(executable, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function outputTargetsGateway(output, gatewayPort) {
  const text = String(output ?? "");
  if (!text.trim()) return false;
  return text.includes(`127.0.0.1:${gatewayPort}`)
    || text.includes(`localhost:${gatewayPort}`);
}

function remoteAccessSnapshot({
  gateway,
  checkedAt,
  installed,
  connected = false,
  backendState = installed ? "Stopped" : "Not installed",
  dnsName = null,
  ips = [],
  httpsUrl = null,
  serve = { active: false, statusAvailable: installed },
  funnel = { active: false, statusAvailable: installed },
  mode = null,
  publicBaseUrlConfigured = false,
  ready = false,
  error = null,
  nextStep,
}) {
  return {
    checkedAt,
    gateway,
    tailscale: {
      installed,
      connected,
      backendState,
      dnsName,
      ips,
      httpsUrl,
      serve,
      funnel,
      mode,
      publicBaseUrlConfigured,
      ready,
      error,
      nextStep,
    },
  };
}

function sameOrigin(left, right) {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function safeCommandError(error) {
  if (error?.killed || error?.signal === "SIGTERM") return "Tailscale status timed out.";
  return "Tailscale is installed but its local service could not be reached.";
}

function readEnvValue(source, key) {
  const match = String(source).match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "mu"));
  if (!match) return "";
  const value = match[1].trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function upsertEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "mu");
  if (pattern.test(source)) return source.replace(pattern, line);
  if (!source) return `${line}\n`;
  return `${source}${source.endsWith("\n") ? "" : "\n"}${line}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}
