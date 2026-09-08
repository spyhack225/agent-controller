import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTOR_MAX_FRAME_BYTES,
  ConnectorProtocolError,
  connectorFrame,
  encodeConnectorFrame,
  parseConnectorFrame,
} from "../src/connectorProtocol.mjs";

test("connector protocol round trips a bounded v1 request", () => {
  const frame = connectorFrame("request", "conn_1", {
    requestId: "req_1",
    idempotencyKey: "idem_1",
    method: "snapshot",
    deadlineAt: "2026-08-27T12:00:00.000Z",
    payload: {},
  });
  assert.deepEqual(parseConnectorFrame(encodeConnectorFrame(frame), { direction: "cloud" }), frame);
});

test("connector protocol rejects wrong-direction and oversized frames", () => {
  const welcome = connectorFrame("welcome", "conn_1", {
    serverTime: "2026-08-27T12:00:00.000Z",
    heartbeatIntervalMs: 20_000,
    maxFrameBytes: CONNECTOR_MAX_FRAME_BYTES,
    maxInFlight: 32,
  });
  assert.throws(
    () => parseConnectorFrame(JSON.stringify(welcome), { direction: "connector" }),
    (error) => error instanceof ConnectorProtocolError && error.code === "unsupported_type",
  );
  assert.throws(
    () => parseConnectorFrame(`{"${"x".repeat(CONNECTOR_MAX_FRAME_BYTES)}":1}`),
    (error) => error.code === "frame_too_large",
  );
});

test("connector protocol validates type-specific body fields", () => {
  assert.throws(
    () => connectorFrame("heartbeat", "conn_1", {
      sequence: 1,
      sentAt: "not-a-time",
      activeRequests: 0,
      queueDepth: 0,
    }),
    /body.sentAt must be an ISO timestamp/u,
  );
  assert.throws(
    () => connectorFrame("response.failed", "conn_1", {
      requestId: "req_1",
      code: "t3_unreachable",
      retryable: true,
    }),
    /body.failedAt must be a non-empty string/u,
  );
});
