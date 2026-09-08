export const CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const MAX_CONNECTOR_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_REQUESTS = 32;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const CONNECTOR_STALE_AFTER_MS = 60_000;
export const CONNECTOR_OFFLINE_AFTER_MS = 90_000;
export const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
export const MIN_REQUEST_DEADLINE_MS = 1_000;
export const MAX_REQUEST_DEADLINE_MS = 5 * 60_000;
export const CONNECTOR_TICKET_TTL_MS = 60_000;
export const TERMINAL_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_IDEMPOTENCY_ENTRIES = 1_000;
// Keep parity with the connector's completed-request cache. Individual frames
// are limited to 1 MiB, while this aggregate cap bounds retained private T3
// output across all terminal requests for one environment.
export const MAX_TERMINAL_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_LOCAL_EVENT_OUTBOX_COUNT = 256;
export const MAX_LOCAL_EVENT_OUTBOX_BYTES = 4 * 1024 * 1024;

export type ConnectorFailureCode =
  | "connector_offline"
  | "connector_backpressure"
  | "connector_timeout"
  | "connector_cancelled"
  | "connector_revoked"
  | "invalid_frame"
  | "payload_too_large"
  | "protocol_incompatible"
  | "request_failed";

export interface ConnectorTicketClaims {
  ticketId: string;
  connectorId: string;
  environmentId: string;
  audience: string;
  scopes: string[];
  expiresAt: number;
}

export interface BaseFrame<Type extends string = string, Body extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  type: Type;
  connectionId: string;
  body: Body;
}

export type ConnectorHelloFrame = BaseFrame<"hello", {
  connectorId: string;
  environmentId: string;
  connectorVersion: string;
  platform: string;
  t3Version?: string;
  t3Health?: string;
  capabilities: string[];
  providerCatalogue?: unknown[];
  lastEventCursor?: string;
}>;

export type ConnectorHeartbeatFrame = BaseFrame<"heartbeat", {
  sequence: number;
  sentAt: string;
  activeRequests: number;
  queueDepth: number;
  t3Health?: "unknown" | "starting" | "ready" | "stopped" | "auth_failed" | "incompatible" | "error";
}>;

export type ConnectorAcceptedFrame = BaseFrame<"response.accepted", { requestId: string; acceptedAt: string }>;
export type ConnectorCompletedFrame = BaseFrame<"response.completed", { requestId: string; result: unknown; completedAt: string }>;
export type ConnectorFailedFrame = BaseFrame<"response.failed", {
  requestId: string;
  code: string;
  retryable: boolean;
  detail?: string;
  failedAt: string;
}>;
export type ConnectorEventFrame = BaseFrame<"event", {
  eventId: string;
  environmentId: string;
  cursor?: number | null;
  threadId?: string;
  leaseId?: string;
  payload?: unknown;
}>;
export type ConnectorSnapshotFrame = BaseFrame<"snapshot", {
  environmentId: string;
  threadId?: string;
  leaseId?: string;
  cursor?: number | null;
  resetReason: string;
  snapshot: unknown;
}>;
export type ConnectorCredentialRotatedFrame = BaseFrame<"credential.rotated", { challenge: string; rotatedAt: string }>;

export type ConnectorToCloudFrame =
  | ConnectorHelloFrame
  | ConnectorHeartbeatFrame
  | ConnectorAcceptedFrame
  | ConnectorCompletedFrame
  | ConnectorFailedFrame
  | ConnectorEventFrame
  | ConnectorSnapshotFrame
  | ConnectorCredentialRotatedFrame;

export type CloudRequestFrame = BaseFrame<"request", {
  requestId: string;
  idempotencyKey: string;
  method: string;
  deadlineAt: string;
  payload: unknown;
}>;
export type CloudCancelFrame = BaseFrame<"cancel", { requestId: string; reason: string }>;
export type CloudWelcomeFrame = BaseFrame<"welcome", {
  serverTime: string;
  heartbeatIntervalMs: number;
  maxFrameBytes: number;
  maxInFlight: number;
}>;
export type CloudShutdownFrame = BaseFrame<"shutdown", {
  reason: "revoked" | "superseded" | "protocol_incompatible" | "maintenance";
}>;
export type CloudSubscribeFrame = BaseFrame<"subscribe", { threadId: string; cursor?: number; turnLimit?: number; leaseId: string; expiresAt: string }>;
export type CloudUnsubscribeFrame = BaseFrame<"unsubscribe", { leaseId: string }>;
export type CloudRotateFrame = BaseFrame<"rotate", { challenge: string; expiresAt: string }>;

export type CloudToConnectorFrame =
  | CloudRequestFrame
  | CloudCancelFrame
  | CloudWelcomeFrame
  | CloudShutdownFrame
  | CloudSubscribeFrame
  | CloudUnsubscribeFrame
  | CloudRotateFrame;

export interface ConnectorRequestInput {
  connectorId?: string;
  requestId: string;
  idempotencyKey: string;
  method: string;
  payload: unknown;
  deadlineMs?: number;
}

export interface ConnectorHubEvent {
  eventVersion: 1;
  environmentId: string;
  connectorId: string;
  connectionId: string;
  occurredAt: number;
  kind: "connector.hello" | "connector.heartbeat" | "connector.response" | "connector.event" | "connector.snapshot" | "connector.disconnected" | "connector.credential-rotated";
  body: unknown;
}

export class ProtocolError extends Error {
  readonly code: ConnectorFailureCode;
  readonly status: number;

  constructor(code: ConnectorFailureCode, message: string, status = 400) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.status = status;
  }
}

const encoder = new TextEncoder();

export function jsonByteLength(value: unknown): number {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export function encodeFrame(frame: CloudToConnectorFrame): string {
  validateEnvelope(frame, "cloud");
  const encoded = JSON.stringify(frame);
  if (jsonByteLength(encoded) > MAX_CONNECTOR_FRAME_BYTES) {
    throw new ProtocolError("payload_too_large", "Connector frame exceeds the 1 MiB limit.", 413);
  }
  return encoded;
}

export function decodeConnectorFrame(message: string | ArrayBuffer): ConnectorToCloudFrame {
  const bytes = typeof message === "string" ? encoder.encode(message) : new Uint8Array(message);
  if (bytes.byteLength > MAX_CONNECTOR_FRAME_BYTES) {
    throw new ProtocolError("payload_too_large", "Connector frame exceeds the 1 MiB limit.", 413);
  }

  let value: unknown;
  try {
    value = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
  } catch {
    throw new ProtocolError("invalid_frame", "Connector frame is not valid JSON.");
  }
  validateEnvelope(value, "connector");
  return value as ConnectorToCloudFrame;
}

export function clampDeadlineMs(value: unknown): number {
  if (value === undefined) return DEFAULT_REQUEST_DEADLINE_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError("invalid_frame", "deadlineMs must be a finite number.");
  }
  return Math.max(MIN_REQUEST_DEADLINE_MS, Math.min(MAX_REQUEST_DEADLINE_MS, Math.trunc(value)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEnvelope(value: unknown, direction: "connector" | "cloud"): asserts value is BaseFrame {
  if (
    !isRecord(value) ||
    value.protocolVersion !== CONNECTOR_PROTOCOL_VERSION ||
    typeof value.type !== "string" ||
    typeof value.connectionId !== "string" ||
    value.connectionId.trim() === "" ||
    !isRecord(value.body)
  ) {
    throw new ProtocolError("invalid_frame", "Connector frame envelope is invalid.");
  }
  const body = value.body;
  const allowed = direction === "connector"
    ? ["hello", "heartbeat", "response.accepted", "response.completed", "response.failed", "event", "snapshot", "credential.rotated"]
    : ["welcome", "request", "cancel", "subscribe", "unsubscribe", "rotate", "shutdown"];
  if (!allowed.includes(value.type)) throw new ProtocolError("invalid_frame", `Unsupported ${direction} frame type: ${value.type}`);

  switch (value.type) {
    case "hello":
      requireStrings(body, ["connectorId", "environmentId", "connectorVersion", "platform"]);
      if (!isStringArray(body.capabilities)) invalid("body.capabilities must be a string array.");
      if (body.providerCatalogue !== undefined && (!Array.isArray(body.providerCatalogue) || body.providerCatalogue.length > 128)) {
        invalid("body.providerCatalogue must be an array with at most 128 entries.");
      }
      if (body.t3Health !== undefined && typeof body.t3Health !== "string") invalid("body.t3Health must be a string.");
      break;
    case "heartbeat":
      requireIntegers(body, ["sequence", "activeRequests", "queueDepth"]);
      if ((body.activeRequests as number) > MAX_PENDING_REQUESTS) invalid("body.activeRequests exceeds max in-flight requests.");
      requireIso(body.sentAt, "body.sentAt");
      break;
    case "response.accepted":
      requireStrings(body, ["requestId"]);
      requireIso(body.acceptedAt, "body.acceptedAt");
      break;
    case "response.completed":
      requireStrings(body, ["requestId"]);
      requireIso(body.completedAt, "body.completedAt");
      if (!("result" in body)) invalid("body.result is required.");
      break;
    case "response.failed":
      requireStrings(body, ["requestId", "code"]);
      if (typeof body.retryable !== "boolean") invalid("body.retryable is required.");
      if (body.detail !== undefined && typeof body.detail !== "string") invalid("body.detail must be a string.");
      requireIso(body.failedAt, "body.failedAt");
      break;
    case "event":
      requireStrings(body, ["eventId", "environmentId"]);
      break;
    case "snapshot":
      requireStrings(body, ["environmentId", "resetReason"]);
      if (!("snapshot" in body)) invalid("body.snapshot is required.");
      break;
    case "credential.rotated":
      requireStrings(body, ["challenge"]);
      requireIso(body.rotatedAt, "body.rotatedAt");
      break;
    case "welcome":
      requireIso(body.serverTime, "body.serverTime");
      requirePositiveIntegers(body, ["heartbeatIntervalMs", "maxFrameBytes", "maxInFlight"]);
      if ((body.maxFrameBytes as number) > MAX_CONNECTOR_FRAME_BYTES) invalid("body.maxFrameBytes exceeds the protocol limit.");
      if ((body.maxInFlight as number) > MAX_PENDING_REQUESTS) invalid("body.maxInFlight exceeds the protocol limit.");
      break;
    case "request":
      requireStrings(body, ["requestId", "idempotencyKey", "method"]);
      requireIso(body.deadlineAt, "body.deadlineAt");
      if (!("payload" in body)) invalid("body.payload is required.");
      break;
    case "cancel":
      requireStrings(body, ["requestId", "reason"]);
      break;
    case "subscribe":
      requireStrings(body, ["threadId", "leaseId"]);
      requireIso(body.expiresAt, "body.expiresAt");
      if (body.cursor !== undefined && (!Number.isSafeInteger(body.cursor) || (body.cursor as number) < 0)) invalid("body.cursor must be a non-negative integer.");
      if (body.turnLimit !== undefined && (!Number.isSafeInteger(body.turnLimit) || (body.turnLimit as number) < 1 || (body.turnLimit as number) > 100)) invalid("body.turnLimit must be between 1 and 100.");
      break;
    case "unsubscribe":
      requireStrings(body, ["leaseId"]);
      break;
    case "rotate":
      requireStrings(body, ["challenge"]);
      requireIso(body.expiresAt, "body.expiresAt");
      break;
    case "shutdown":
      requireStrings(body, ["reason"]);
      break;
  }
}

function invalid(message: string): never {
  throw new ProtocolError("invalid_frame", message);
}

function requireStrings(value: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (typeof value[key] !== "string" || value[key].trim() === "") invalid(`body.${key} is required.`);
}

function requireIntegers(value: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) invalid(`body.${key} must be a non-negative integer.`);
}

function requirePositiveIntegers(value: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) invalid(`body.${key} must be a positive integer.`);
}

function requireIso(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) invalid(`${field} must be an ISO timestamp.`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
}
