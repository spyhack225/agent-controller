import { HttpError } from "./http.mjs";

// Roadmap Phase 4 lists "TLS only" as minimum production security. Nothing enforced it, so a
// misconfigured deployment could hand out and accept device secrets in cleartext.
//
// Enforcement is opt-in via REQUIRE_TLS because local development and the device simulator run
// over plain HTTP on loopback, which is not exposed to a network.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isSecureTransport(req, config = {}) {
  // A terminating proxy tells us the original scheme; trust it only because the operator opted in.
  const forwardedProto = headerValue(req, "x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  if (req?.socket?.encrypted === true) return true;
  if (config.publicBaseUrl?.startsWith("https://")) return true;
  return isLoopback(req);
  // Note: callers wanting the loopback-development exemption must use assertSecureTransport,
  // which applies it only when no proxy header is present.
}

export function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== "string") return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return LOOPBACK_HOSTS.has(normalized);
}

/**
 * Guards a request that either carries or returns a device credential.
 *
 * Loopback is always allowed: the simulator and local firmware flashing depend on it, and traffic
 * that never leaves the host cannot be intercepted on the wire.
 */
export function assertSecureTransport(req, config = {}, what = "This request") {
  if (!config.requireTls) return;
  if (isSecureTransport(req, config)) return;

  // A loopback socket only proves the traffic is local when nothing forwarded it. Once a proxy
  // sets x-forwarded-proto, the real client is elsewhere and its scheme is what matters.
  if (!headerValue(req, "x-forwarded-proto") && isLoopback(req)) return;

  throw new HttpError(403, `${what} requires HTTPS. Set REQUIRE_TLS=0 only for local development.`);
}

function headerValue(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : null;
}
