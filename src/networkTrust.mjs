// Classifies where a request came from so the policy engine's network_location dimension has a
// real signal instead of a guess. Returns undefined when the operator has not configured any
// trusted ranges, which keeps the dimension inert rather than defaulting everything to untrusted.
export function classifyNetworkLocation(req, config) {
  const ranges = config?.trustedNetworks;
  if (!Array.isArray(ranges) || ranges.length === 0) return undefined;

  const address = clientAddress(req);
  if (!address) return "untrusted";
  return ranges.some((range) => matchesRange(address, range)) ? "trusted" : "untrusted";
}

export function clientAddress(req) {
  // x-forwarded-for is only meaningful behind a proxy the operator controls; the left-most entry
  // is the original client.
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return normalizeAddress(forwarded.split(",")[0].trim());
  }
  return normalizeAddress(req?.socket?.remoteAddress ?? null);
}

function normalizeAddress(address) {
  if (typeof address !== "string" || !address) return null;
  // Node reports IPv4 over dual-stack sockets as ::ffff:127.0.0.1
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  return mapped ? mapped[1] : address;
}

function matchesRange(address, range) {
  const candidate = String(range).trim();
  if (!candidate) return false;
  if (candidate === "*") return true;
  if (candidate === "loopback") return address === "127.0.0.1" || address === "::1";
  if (!candidate.includes("/")) return candidate === address;

  const [network, bitsText] = candidate.split("/");
  const bits = Number.parseInt(bitsText, 10);
  const addressValue = toIpv4Value(address);
  const networkValue = toIpv4Value(network);
  if (addressValue === null || networkValue === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addressValue & mask) >>> 0 === (networkValue & mask) >>> 0;
}

function toIpv4Value(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}
