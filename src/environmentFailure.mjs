// Why an environment is not answering, as a stable machine-readable discriminator.
// `lastError` stays free text for humans; the reason is what the console branches on, so it
// must never be derived from message parsing on the client side.
export const ENVIRONMENT_FAILURE_REASONS = Object.freeze([
  "process_not_running",
  "network_unreachable",
  "timeout",
  "tls_error",
  "token_expired",
  "authentication_failed",
  "contract_incompatible",
  "unknown",
]);

// A reason the owner has to act on: retrying the same request cannot succeed until a credential
// is replaced or the host is upgraded, so the console stops its background poll for these.
const USER_ACTION_REQUIRED = Object.freeze(new Set([
  "token_expired",
  "authentication_failed",
  "contract_incompatible",
]));

const CONNECTION_REFUSED_CODES = new Set(["ECONNREFUSED", "UND_ERR_SOCKET"]);
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError"]);
// HTTP statuses that mean the host answered but does not speak the contract this gateway needs.
const CONTRACT_STATUSES = new Set([404, 410, 426, 501, 505]);

export function isRetryableEnvironmentFailure(reason) {
  return !USER_ACTION_REQUIRED.has(reason);
}

// Node's fetch reports the real cause one or more `cause` levels below a bare "fetch failed",
// so classification walks the chain rather than reading only the outermost error.
export function classifyEnvironmentFailure(error) {
  for (const link of errorChain(error)) {
    const reason = classifyOne(link);
    if (reason) return reason;
  }
  return "unknown";
}

export function describeEnvironmentFailure(reason) {
  switch (reason) {
    case "process_not_running":
      return "T3 Code is not accepting connections on its saved address.";
    case "network_unreachable":
      return "The T3 host could not be reached over the network.";
    case "timeout":
      return "The T3 host did not answer in time.";
    case "tls_error":
      return "The T3 host presented a TLS certificate that could not be verified.";
    case "token_expired":
      return "T3 access token has expired. Re-pair this environment.";
    case "authentication_failed":
      return "The T3 host rejected the stored credential.";
    case "contract_incompatible":
      return "The T3 host does not expose the orchestration contract this gateway requires.";
    default:
      return "T3 environment is unreachable.";
  }
}

function classifyOne(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 401 || status === 403) return "authentication_failed";
  if (CONTRACT_STATUSES.has(status)) return "contract_incompatible";

  const code = typeof error?.code === "string" ? error.code : "";
  if (isTlsCode(code)) return "tls_error";
  if (CONNECTION_REFUSED_CODES.has(code)) return "process_not_running";
  if (NETWORK_CODES.has(code)) return "network_unreachable";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (TIMEOUT_NAMES.has(error?.name)) return "timeout";
  return null;
}

function isTlsCode(code) {
  if (!code) return false;
  return code.startsWith("ERR_TLS")
    || code.startsWith("ERR_SSL")
    || code.startsWith("CERT_")
    || code === "EPROTO"
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
}

function errorChain(error) {
  const chain = [];
  let current = error;
  while (current && typeof current === "object" && chain.length < 8) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}
