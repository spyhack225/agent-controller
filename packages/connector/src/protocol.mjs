export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT = 32;
export const MAX_COMPLETED = 1000;
export const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_COMPLETED_BYTES = 8 * 1024 * 1024;

const CLOUD_TYPES = new Set(["welcome", "request", "cancel", "subscribe", "unsubscribe", "rotate", "shutdown"]);
const CONNECTOR_TYPES = new Set(["hello", "heartbeat", "response.accepted", "response.completed", "response.failed", "event", "snapshot", "credential.rotated"]);

export function encodeFrame(frame) {
  if (!frame || frame.protocolVersion !== 1 || typeof frame.type !== "string" || typeof frame.connectionId !== "string" || !isRecord(frame.body)) {
    throw Object.assign(new Error("Invalid connector frame."), { code: "PROTOCOL_INVALID_FRAME" });
  }
  if (!CONNECTOR_TYPES.has(frame.type)) throw protocolError(`Unsupported connector frame type: ${frame.type}`, "PROTOCOL_INVALID_FRAME");
  validateBody(frame.type, frame.body);
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    throw Object.assign(new Error(`Connector frame exceeds ${MAX_FRAME_BYTES} bytes.`), { code: "PROTOCOL_FRAME_TOO_LARGE" });
  }
  return encoded;
}

export function decodeCloudFrame(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw protocolError("Cloud frame is too large.", "PROTOCOL_FRAME_TOO_LARGE");
  let frame;
  try { frame = JSON.parse(text); } catch { throw protocolError("Cloud frame is not valid JSON.", "PROTOCOL_INVALID_JSON"); }
  if (!frame || frame.protocolVersion !== 1 || !CLOUD_TYPES.has(frame.type) || typeof frame.connectionId !== "string" || !isRecord(frame.body)) {
    throw protocolError("Cloud frame has an invalid protocol envelope.", "PROTOCOL_INVALID_FRAME");
  }
  validateBody(frame.type, frame.body);
  return frame;
}

export function responseFailureFrame({ connectionId, requestId, error }) {
  return {
    protocolVersion: 1,
    type: "response.failed",
    connectionId,
    body: {
      requestId,
      code: stableErrorCode(error),
      retryable: isRetryable(error),
      detail: "The local connector could not complete this request.",
      failedAt: new Date().toISOString(),
    },
  };
}

export function stableErrorCode(error) {
  if (typeof error?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)) return error.code.toLowerCase();
  if (error?.status === 401 || error?.status === 403) return "t3_auth_failed";
  return "connector_request_failed";
}

export function isRetryable(error) {
  if (error?.retryable === false) return false;
  if (["T3_AUTH_FAILED", "T3_TOKEN_REQUIRED", "UNSUPPORTED_METHOD", "PROTOCOL_INVALID_REQUEST"].includes(error?.code)) return false;
  return true;
}

export class CompletedRequestCache {
  constructor({ maxEntries = MAX_COMPLETED, ttlMs = COMPLETED_TTL_MS, maxBytes = MAX_COMPLETED_BYTES, now = Date.now, entries = [] } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.now = now;
    this.values = new Map();
    this.bytes = 0;
    for (const entry of entries) {
      if (entry && typeof entry.key === "string" && entry.frame && Number.isFinite(entry.expiresAt) && entry.expiresAt > now()) {
        this.insert(entry.key, entry.frame, entry.expiresAt);
      }
    }
  }

  get(key) {
    this.prune();
    const entry = this.values.get(key);
    return entry?.frame ?? null;
  }

  set(key, frame) {
    this.prune();
    this.delete(key);
    this.insert(key, frame, this.now() + this.ttlMs);
    while (this.values.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.values.keys().next().value);
  }

  prune() {
    const now = this.now();
    for (const [key, value] of this.values) if (value.expiresAt <= now) this.delete(key);
  }

  entries() {
    this.prune();
    return [...this.values].map(([key, value]) => ({ key, frame: value.frame, expiresAt: value.expiresAt }));
  }

  insert(key, frame, expiresAt) {
    const bytes = Buffer.byteLength(JSON.stringify({ key, frame, expiresAt }), "utf8");
    this.values.set(key, { frame, expiresAt, bytes });
    this.bytes += bytes;
  }

  delete(key) {
    const entry = this.values.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.values.delete(key);
  }
}

function protocolError(message, code) { return Object.assign(new Error(message), { code }); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function validateBody(type, body) {
  const string = (key) => {
    if (typeof body[key] !== "string" || !body[key]) throw protocolError(`${type}.body.${key} is required.`, "PROTOCOL_INVALID_FRAME");
  };
  const iso = (key) => { string(key); if (!Number.isFinite(Date.parse(body[key]))) throw protocolError(`${type}.body.${key} must be an ISO timestamp.`, "PROTOCOL_INVALID_FRAME"); };
  const integer = (key, min = 0) => {
    if (!Number.isSafeInteger(body[key]) || body[key] < min) throw protocolError(`${type}.body.${key} must be an integer.`, "PROTOCOL_INVALID_FRAME");
  };
  if (type === "hello") {
    for (const key of ["connectorId", "environmentId", "connectorVersion", "platform"]) string(key);
    if (!Array.isArray(body.capabilities) || body.capabilities.some((value) => typeof value !== "string" || !value)) throw protocolError("hello.body.capabilities must be a string array.", "PROTOCOL_INVALID_FRAME");
  } else if (type === "heartbeat") {
    integer("sequence"); integer("activeRequests"); integer("queueDepth"); iso("sentAt");
  } else if (type === "request") {
    string("requestId"); string("idempotencyKey"); string("method"); iso("deadlineAt");
    if (!("payload" in body)) throw protocolError("request.body.payload is required.", "PROTOCOL_INVALID_REQUEST");
  } else if (type === "cancel") {
    string("requestId"); string("reason");
  } else if (type === "subscribe") {
    string("threadId"); string("leaseId"); iso("expiresAt");
  } else if (type === "unsubscribe") string("leaseId");
  else if (type === "rotate") { string("challenge"); iso("expiresAt"); }
  else if (type === "shutdown") string("reason");
  else if (type === "welcome") {
    iso("serverTime"); integer("heartbeatIntervalMs", 1); integer("maxFrameBytes", 1); integer("maxInFlight", 1);
  } else if (type === "response.accepted") { string("requestId"); iso("acceptedAt"); }
  else if (type === "response.completed") { string("requestId"); iso("completedAt"); if (!("result" in body)) throw protocolError("response.completed.body.result is required.", "PROTOCOL_INVALID_FRAME"); }
  else if (type === "response.failed") { string("requestId"); string("code"); iso("failedAt"); if (typeof body.retryable !== "boolean") throw protocolError("response.failed.body.retryable is required.", "PROTOCOL_INVALID_FRAME"); }
  else if (type === "event") { string("eventId"); string("environmentId"); }
  else if (type === "snapshot") { string("environmentId"); string("resetReason"); if (!("snapshot" in body)) throw protocolError("snapshot.body.snapshot is required.", "PROTOCOL_INVALID_FRAME"); }
  else if (type === "credential.rotated") { string("challenge"); iso("rotatedAt"); }
}
