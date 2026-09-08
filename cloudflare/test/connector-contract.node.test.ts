import { describe, expect, it } from "vitest";

// This is intentionally a cross-package contract test: it uses the real CLI
// hello builder so protocol drift fails before a connector/cloud integration.
// @ts-expect-error The connector package is JavaScript and ships no declarations yet.
import { ConnectorClient } from "../../packages/connector/src/connector.mjs";
import { decodeConnectorFrame } from "../src/protocol";
import { ConnectorT3TransportBoundary, type ConnectorRouter } from "../src/router";

describe("published-package-shaped connector contract", () => {
  it("accepts the actual CLI hello and preserves its proposed connection id", async () => {
    const connector = new ConnectorClient({
      state: {
        connectorId: "connector_contract",
        environmentId: "environment_contract",
        completedRequests: [],
        lastEventCursor: "cursor_42",
        t3AccessToken: "present-only-in-local-test-state",
      },
      t3: {
        environmentInfo: async () => ({ version: "0.9.0" }),
        providerCatalogue: async () => [],
      },
      WebSocketImpl: class {},
      logger: { log() {}, error() {} },
    });

    const hello = await connector.buildHello("cli_proposed_connection_id");
    const parsed = decodeConnectorFrame(JSON.stringify(hello));
    expect(parsed).toMatchObject({
      type: "hello",
      connectionId: "cli_proposed_connection_id",
      body: {
        connectorId: "connector_contract",
        environmentId: "environment_contract",
        connectorVersion: expect.any(String),
        capabilities: expect.any(Array),
      },
    });
  });

  it("dispatches the edge boundary's canonical methods through the actual CLI implementation", async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const connector = new ConnectorClient({
      state: { connectorId: "connector_contract", environmentId: "environment_contract", completedRequests: [] },
      t3: {
        environmentInfo: async () => ({ method: "environmentInfo" }),
        snapshot: async () => ({ method: "snapshot" }),
        threadDetail: async (threadId: string) => ({ method: "threadDetail", threadId }),
        dispatch: async (command: unknown) => ({ method: "dispatch", command }),
        callRpc: async (tag: string, payload: unknown) => ({ method: "callRpc", tag, payload }),
      },
      WebSocketImpl: class {},
      logger: { log() {}, error() {} },
    });
    const router = {
      async submit(_environmentId: string, request: { method: string; payload: unknown }) {
        calls.push(request);
        return await connector.dispatchLocal(request.method, request.payload);
      },
    } as unknown as ConnectorRouter;
    const boundary = new ConnectorT3TransportBoundary(router);
    await boundary.environmentInfo("environment_contract");
    await boundary.snapshot("environment_contract");
    await boundary.threadDetail("environment_contract", "thread_contract");
    await boundary.dispatch("environment_contract", { type: "send_message" });
    await boundary.callRpc("environment_contract", "thread.list", { limit: 5 });
    expect(calls.map((call) => call.method)).toEqual(["environmentInfo", "snapshot", "threadDetail", "dispatch", "callRpc"]);
  });
});
