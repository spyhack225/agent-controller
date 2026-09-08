export const CONNECTOR_PROTOCOL_VERSION = 1;
export const CONNECTOR_CREDENTIAL_SCOPES = Object.freeze(["connector:connect", "t3:proxy"]);
export const CONNECTOR_TICKET_AUDIENCE = "agent-controller-connectors";
export const CONNECTOR_MAX_FRAME_BYTES = 1024 * 1024;
export const CONNECTOR_HEARTBEAT_INTERVAL_MS = 20_000;
export const CONNECTOR_STALE_AFTER_MS = 60_000;
export const CONNECTOR_OFFLINE_AFTER_MS = 90_000;
export const CONNECTOR_MAX_IN_FLIGHT = 32;
export const CONNECTOR_DEFAULT_DEADLINE_MS = 30_000;
export const CONNECTOR_MAX_DEADLINE_MS = 5 * 60_000;
export const CONNECTOR_TICKET_TTL_MS = 60_000;
// Rotation overlap is bounded. The first consumed ticket minted with the staged
// credential is the acknowledgement/commit point; until then the old live
// connector can continue serving work without a deliberate outage.
export const CONNECTOR_ROTATION_TTL_MS = 10 * 60_000;
export const CONNECTOR_IDEMPOTENCY_LIMIT = 1_000;
export const CONNECTOR_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export const CONNECTOR_TO_CLOUD_FRAME_TYPES = new Set([
  "hello",
  "heartbeat",
  "response.accepted",
  "response.completed",
  "response.failed",
  "event",
  "snapshot",
  "credential.rotated",
]);

export const CLOUD_TO_CONNECTOR_FRAME_TYPES = new Set([
  "welcome",
  "request",
  "cancel",
  "subscribe",
  "unsubscribe",
  "rotate",
  "shutdown",
]);

export class ConnectorProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConnectorProtocolError";
    this.code = code;
  }
}

export function parseConnectorFrame(input, { direction = null } = {}) {
  const json = decodeFrameInput(input);
  if (byteLength(json) > CONNECTOR_MAX_FRAME_BYTES) {
    throw new ConnectorProtocolError("frame_too_large", `Connector frame exceeds ${CONNECTOR_MAX_FRAME_BYTES} bytes.`);
  }
  let frame;
  try {
    frame = JSON.parse(json);
  } catch {
    throw new ConnectorProtocolError("invalid_json", "Connector frame must be valid JSON.");
  }
  validateConnectorFrame(frame, { direction });
  return frame;
}

export function encodeConnectorFrame(frame, options = {}) {
  validateConnectorFrame(frame, options);
  const encoded = JSON.stringify(frame);
  if (byteLength(encoded) > CONNECTOR_MAX_FRAME_BYTES) {
    throw new ConnectorProtocolError("frame_too_large", `Connector frame exceeds ${CONNECTOR_MAX_FRAME_BYTES} bytes.`);
  }
  return encoded;
}

export function validateConnectorFrame(frame, { direction = null } = {}) {
  if (!isRecord(frame)) throw new ConnectorProtocolError("invalid_frame", "Connector frame must be an object.");
  if (frame.protocolVersion !== CONNECTOR_PROTOCOL_VERSION) {
    throw new ConnectorProtocolError("unsupported_protocol", `Connector protocolVersion must be ${CONNECTOR_PROTOCOL_VERSION}.`);
  }
  requireNonEmpty(frame.type, "type");
  requireNonEmpty(frame.connectionId, "connectionId");
  if (!isRecord(frame.body)) throw new ConnectorProtocolError("invalid_body", "Connector frame body must be an object.");

  const allowed = direction === "connector"
    ? CONNECTOR_TO_CLOUD_FRAME_TYPES
    : direction === "cloud"
      ? CLOUD_TO_CONNECTOR_FRAME_TYPES
      : new Set([...CONNECTOR_TO_CLOUD_FRAME_TYPES, ...CLOUD_TO_CONNECTOR_FRAME_TYPES]);
  if (!allowed.has(frame.type)) {
    throw new ConnectorProtocolError("unsupported_type", `Connector frame type ${frame.type} is not valid${direction ? ` for ${direction}` : ""}.`);
  }
  validateFrameBody(frame.type, frame.body);
  return frame;
}

export function connectorFrame(type, connectionId, body) {
  return validateConnectorFrame({ protocolVersion: CONNECTOR_PROTOCOL_VERSION, type, connectionId, body });
}

function validateFrameBody(type, body) {
  switch (type) {
    case "hello":
      requireNonEmpty(body.connectorId, "body.connectorId");
      requireNonEmpty(body.environmentId, "body.environmentId");
      requireNonEmpty(body.connectorVersion, "body.connectorVersion");
      requireNonEmpty(body.platform, "body.platform");
      requireStringArray(body.capabilities, "body.capabilities");
      break;
    case "heartbeat":
      requireInteger(body.sequence, "body.sequence", 0);
      requireIso(body.sentAt, "body.sentAt");
      requireInteger(body.activeRequests, "body.activeRequests", 0, CONNECTOR_MAX_IN_FLIGHT);
      requireInteger(body.queueDepth, "body.queueDepth", 0);
      break;
    case "request":
      requireNonEmpty(body.requestId, "body.requestId");
      requireNonEmpty(body.idempotencyKey, "body.idempotencyKey");
      requireNonEmpty(body.method, "body.method");
      requireIso(body.deadlineAt, "body.deadlineAt");
      if (!("payload" in body)) throw new ConnectorProtocolError("invalid_body", "body.payload is required.");
      break;
    case "response.accepted":
      requireNonEmpty(body.requestId, "body.requestId");
      requireIso(body.acceptedAt, "body.acceptedAt");
      break;
    case "response.completed":
      requireNonEmpty(body.requestId, "body.requestId");
      requireIso(body.completedAt, "body.completedAt");
      if (!("result" in body)) throw new ConnectorProtocolError("invalid_body", "body.result is required.");
      break;
    case "response.failed":
      requireNonEmpty(body.requestId, "body.requestId");
      requireNonEmpty(body.code, "body.code");
      if (typeof body.retryable !== "boolean") throw new ConnectorProtocolError("invalid_body", "body.retryable must be boolean.");
      requireIso(body.failedAt, "body.failedAt");
      break;
    case "event":
      requireNonEmpty(body.eventId, "body.eventId");
      requireNonEmpty(body.environmentId, "body.environmentId");
      break;
    case "snapshot":
      requireNonEmpty(body.environmentId, "body.environmentId");
      requireNonEmpty(body.resetReason, "body.resetReason");
      if (!("snapshot" in body)) throw new ConnectorProtocolError("invalid_body", "body.snapshot is required.");
      break;
    case "welcome":
      requireIso(body.serverTime, "body.serverTime");
      requireInteger(body.heartbeatIntervalMs, "body.heartbeatIntervalMs", 1);
      requireInteger(body.maxFrameBytes, "body.maxFrameBytes", 1, CONNECTOR_MAX_FRAME_BYTES);
      requireInteger(body.maxInFlight, "body.maxInFlight", 1, CONNECTOR_MAX_IN_FLIGHT);
      break;
    case "cancel":
      requireNonEmpty(body.requestId, "body.requestId");
      requireNonEmpty(body.reason, "body.reason");
      break;
    case "subscribe":
      requireNonEmpty(body.threadId, "body.threadId");
      requireNonEmpty(body.leaseId, "body.leaseId");
      requireIso(body.expiresAt, "body.expiresAt");
      break;
    case "unsubscribe":
      requireNonEmpty(body.leaseId, "body.leaseId");
      break;
    case "rotate":
      requireNonEmpty(body.challenge, "body.challenge");
      requireIso(body.expiresAt, "body.expiresAt");
      break;
    case "credential.rotated":
      requireNonEmpty(body.challenge, "body.challenge");
      requireIso(body.rotatedAt, "body.rotatedAt");
      break;
    case "shutdown":
      requireNonEmpty(body.reason, "body.reason");
      break;
    default:
  }
}

function decodeFrameInput(input) {
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array) return new TextDecoder().decode(input);
  throw new ConnectorProtocolError("invalid_encoding", "Connector frame must be text or UTF-8 bytes.");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConnectorProtocolError("invalid_body", `${field} must be a non-empty string.`);
  }
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ConnectorProtocolError("invalid_body", `${field} must be an array of non-empty strings.`);
  }
}

function requireInteger(value, field, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConnectorProtocolError("invalid_body", `${field} must be an integer between ${min} and ${max}.`);
  }
}

function requireIso(value, field) {
  requireNonEmpty(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new ConnectorProtocolError("invalid_body", `${field} must be an ISO timestamp.`);
}
