import { isIP } from "node:net";

import { HttpError, requireString } from "./http.mjs";

export const GATEWAY_PROFILE_MODES = new Set(["lan", "tailnet", "custom"]);

export function normalizeGatewayProfileInput(input = {}, existing = null) {
  const label = Object.hasOwn(input, "label") ? requireString(input.label, "label") : existing?.label;
  const mode = Object.hasOwn(input, "mode") ? requireString(input.mode, "mode").toLowerCase() : existing?.mode;
  const rawUrl = Object.hasOwn(input, "url") ? input.url : Object.hasOwn(input, "baseUrl") ? input.baseUrl : existing?.url;
  if (!label) throw new HttpError(400, "label is required.");
  if (!GATEWAY_PROFILE_MODES.has(mode)) throw new HttpError(400, "mode must be lan, tailnet, or custom.");
  const url = validateGatewayProfileUrl(rawUrl, mode);
  return { label: label.slice(0, 80), mode, url };
}

export function validateGatewayProfileUrl(value, mode) {
  const raw = requireString(value, "url");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be a valid HTTP or HTTPS origin.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new HttpError(400, "url must be an origin without credentials, path, query, or fragment.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (mode === "tailnet") {
    if (parsed.protocol !== "https:" || !hostname.endsWith(".ts.net")) {
      throw new HttpError(400, "Tailnet gateway URLs must use HTTPS and a .ts.net hostname.");
    }
  } else if (mode === "custom") {
    if (parsed.protocol !== "https:") throw new HttpError(400, "Custom gateway URLs must use HTTPS.");
  } else {
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new HttpError(400, "LAN gateway URLs must use HTTP or HTTPS.");
    }
    if (parsed.protocol === "http:" && !isPrivateLanHost(hostname)) {
      throw new HttpError(400, "Plain HTTP LAN URLs must use a private, link-local, or .local host.");
    }
  }
  return parsed.origin;
}

export function publicGatewayProfile(profile) {
  if (!profile) return null;
  const { conflict, deviceIds, ...output } = profile;
  return { ...output, baseUrl: profile.url };
}

function isPrivateLanHost(hostname) {
  if (hostname === "localhost" || hostname.endsWith(".local")) return true;
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return hostname === "::1" || hostname.startsWith("fc")
    || hostname.startsWith("fd") || /^fe[89ab]/u.test(hostname);
  return false;
}
