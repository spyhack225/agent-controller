import { createHash } from "node:crypto";

export const COMMAND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const COMMAND_REQUEST_MAX_PER_OWNER = 1000;
export const COMMAND_REQUEST_OPERATION = "intent.submit";
export const THREAD_LAUNCH_REQUEST_OPERATION = "thread.launch";
export const THREAD_CREATE_REQUEST_OPERATION = "thread.create";

const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function normalizeClientRequestId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return CLIENT_REQUEST_ID.test(normalized) ? normalized : null;
}

export function requireClientRequestId(value) {
  const normalized = normalizeClientRequestId(value);
  if (!normalized) {
    const error = new Error("clientRequestId must be 8-128 URL-safe characters.");
    error.code = "invalid_client_request_id";
    throw error;
  }
  return normalized;
}

// JSON's object key order is not a contract. Sorting recursively makes the fingerprint identical
// in the browser, device, Node adapter, and a retried Container request without retaining prompt,
// transcript, path, or answer text in the receipt.
export function canonicalRequestJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function commandRequestHash({
  operation = COMMAND_REQUEST_OPERATION,
  environmentId,
  threadId = null,
  intent,
  mediaUploadIds = [],
}) {
  return createHash("sha256").update(canonicalRequestJson({
    version: 1,
    operation,
    environmentId,
    threadId,
    intent,
    mediaUploadIds,
  }), "utf8").digest("hex");
}

export function commandRequestOwnerKey({ userId, actorType, actorId }) {
  return [userId, actorType, actorId ?? userId].join("\u0000");
}

export function commandRequestKey(input) {
  return [commandRequestOwnerKey(input), input.operation, input.clientRequestId].join("\u0000");
}

export function publicCommandRequest(request) {
  if (!request) return null;
  return {
    clientRequestId: request.clientRequestId,
    operation: request.operation,
    status: request.status,
    commandId: request.commandId ?? null,
    httpStatus: request.httpStatus ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      const child = value[key];
      return child === undefined ? [] : [[key, canonicalValue(child)]];
    }));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}
