import { describe, expect, it } from "vitest";

import {
  CONNECTOR_PROTOCOL_VERSION,
  DEFAULT_REQUEST_DEADLINE_MS,
  MAX_CONNECTOR_FRAME_BYTES,
  MAX_REQUEST_DEADLINE_MS,
  ProtocolError,
  clampDeadlineMs,
  decodeConnectorFrame,
  encodeFrame,
} from "../src/protocol";

describe("connector protocol limits", () => {
  it("accepts a valid hello envelope", () => {
    const frame = decodeConnectorFrame(
      JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "hello",
        connectionId: "provisional_1",
        body: {
          connectorId: "connector_1",
          environmentId: "environment_1",
          connectorVersion: "0.1.0",
          platform: "darwin-arm64",
          capabilities: ["t3:proxy"],
        },
      }),
    );

    expect(frame.type).toBe("hello");
  });

  it("rejects unknown frame types", () => {
    expect(() =>
      decodeConnectorFrame(
        JSON.stringify({ protocolVersion: CONNECTOR_PROTOCOL_VERSION, type: "surprise", connectionId: "connection_1", body: {} }),
      ),
    ).toThrowError(ProtocolError);
  });

  it("enforces the one MiB encoded frame limit", () => {
    expect(() =>
      encodeFrame({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "shutdown",
        connectionId: "connection_1",
        body: { reason: "x".repeat(MAX_CONNECTOR_FRAME_BYTES) },
      } as never),
    ).toThrowError(/1 MiB/);
  });

  it("defaults and clamps request deadlines", () => {
    expect(clampDeadlineMs(undefined)).toBe(DEFAULT_REQUEST_DEADLINE_MS);
    expect(clampDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_REQUEST_DEADLINE_MS);
  });
});
