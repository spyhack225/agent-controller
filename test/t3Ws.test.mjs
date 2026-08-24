import assert from "node:assert/strict";
import test from "node:test";

import {
  T3_WS_METHODS,
  callT3Rpc,
  fetchProviderCatalogue,
  requestWebSocketTicket,
  webSocketUrlFor,
} from "../src/t3Ws.mjs";

const ENVIRONMENT = { baseUrl: "http://127.0.0.1:3773", accessToken: "test-access-token" };

// Minimal stand-in for the Effect RPC server, replaying the wire shapes captured from a live
// T3 Code 0.0.28 instance; the same envelope remains live-compatible with 0.0.32.
function fakeSocketFactory({ respond, autoOpen = true }) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, handler) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(handler);
      this.listeners.set(type, existing);
    }

    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
      respond?.(this, JSON.parse(raw));
    }

    receive(message) {
      this.emit("message", { data: JSON.stringify(message) });
    }

    close() {
      this.closed = true;
    }
  }
  return { FakeSocket, sockets };
}

function ticketFetch(ticket = "ticket-abc") {
  return async (url, init = {}) => {
    assert.equal(new URL(String(url)).pathname, "/api/auth/websocket-ticket");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer test-access-token");
    return new Response(JSON.stringify({ ticket, expiresAt: "2026-08-07T06:00:00.000Z" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("the websocket URL carries the ticket and upgrades the scheme", () => {
  assert.equal(
    webSocketUrlFor("http://127.0.0.1:3773", "abc"),
    "ws://127.0.0.1:3773/ws?wsTicket=abc",
  );
  assert.equal(
    webSocketUrlFor("https://mac.tailnet.ts.net", "a b+c"),
    "wss://mac.tailnet.ts.net/ws?wsTicket=a+b%2Bc",
  );
});

test("a ticket is minted with the environment access token", async () => {
  assert.equal(await requestWebSocketTicket(ENVIRONMENT, { fetchImpl: ticketFetch() }), "ticket-abc");
});

test("a ticket failure surfaces the HTTP status", async () => {
  const failing = async () => new Response("nope", { status: 401 });
  await assert.rejects(
    () => requestWebSocketTicket(ENVIRONMENT, { fetchImpl: failing }),
    /HTTP 401/u,
  );
});

test("an RPC sends the Effect Request envelope and resolves the Exit value", async () => {
  const { FakeSocket, sockets } = fakeSocketFactory({
    respond: (socket, request) => {
      socket.receive({
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Success", value: { providers: [{ instanceId: "codex" }] } },
      });
    },
  });

  const value = await callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, {
    fetchImpl: ticketFetch(),
    WebSocketImpl: FakeSocket,
  });

  assert.deepEqual(value, { providers: [{ instanceId: "codex" }] });

  // The envelope must match what the server's dispatcher expects.
  const [sent] = sockets[0].sent;
  assert.deepEqual(sent, {
    _tag: "Request",
    id: "1",
    tag: "server.getConfig",
    payload: {},
    headers: [],
  });
  assert.equal(sockets[0].closed, true, "the one-shot socket must be closed");
});

test("streaming chunks are accumulated and acknowledged", async () => {
  const { FakeSocket, sockets } = fakeSocketFactory({
    respond: (socket, message) => {
      if (message._tag === "Request") {
        socket.receive({ _tag: "Chunk", requestId: message.id, values: [1, 2] });
        return;
      }
      if (message._tag === "Ack") {
        // A real server stalls until the client acks; only then does it finish.
        socket.receive({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } });
      }
    },
  });

  const value = await callT3Rpc(ENVIRONMENT, "subscribeServerConfig", {}, {
    fetchImpl: ticketFetch(),
    WebSocketImpl: FakeSocket,
  });

  assert.deepEqual(value, [1, 2]);
  assert.ok(sockets[0].sent.some((message) => message._tag === "Ack" && message.requestId === "1"));
});

test("an unknown tag comes back as a Defect and is reported", async () => {
  // This is the real response shape for an unrecognised tag.
  const { FakeSocket } = fakeSocketFactory({
    respond: (socket) => socket.receive({ _tag: "Defect", defect: "Unknown request tag: nope" }),
  });

  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "nope", {}, { fetchImpl: ticketFetch(), WebSocketImpl: FakeSocket }),
    /Unknown request tag: nope/u,
  );
});

test("a failed Exit rejects rather than resolving undefined", async () => {
  const { FakeSocket } = fakeSocketFactory({
    respond: (socket, request) => socket.receive({
      _tag: "Exit",
      requestId: request.id,
      exit: { _tag: "Failure", cause: { error: "EnvironmentAuthorizationError" } },
    }),
  });

  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, {
      fetchImpl: ticketFetch(),
      WebSocketImpl: FakeSocket,
    }),
    /EnvironmentAuthorizationError/u,
  );
});

test("a socket that closes early rejects instead of hanging", async () => {
  const { FakeSocket } = fakeSocketFactory({
    respond: (socket) => socket.emit("close", { code: 1006 }),
  });

  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, {
      fetchImpl: ticketFetch(),
      WebSocketImpl: FakeSocket,
    }),
    /closed before/u,
  );
});

test("an unanswered RPC times out instead of hanging forever", async () => {
  const { FakeSocket } = fakeSocketFactory({ respond: () => {} });

  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, {
      fetchImpl: ticketFetch(),
      WebSocketImpl: FakeSocket,
      timeoutMs: 60,
    }),
    /timed out after 60ms/u,
  );
});

test("the provider catalogue is read out of server.getConfig", async () => {
  const { FakeSocket } = fakeSocketFactory({
    respond: (socket, request) => socket.receive({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: {
          environment: { environmentId: "env" },
          providers: [
            { instanceId: "codex", displayName: "Codex", status: "ready", models: [{ slug: "gpt-5.6-sol" }] },
          ],
        },
      },
    }),
  });

  const providers = await fetchProviderCatalogue(ENVIRONMENT, {
    fetchImpl: ticketFetch(),
    WebSocketImpl: FakeSocket,
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].instanceId, "codex");
});

test("a config response without providers is an error, not an empty catalogue", async () => {
  const { FakeSocket } = fakeSocketFactory({
    respond: (socket, request) => socket.receive({
      _tag: "Exit",
      requestId: request.id,
      exit: { _tag: "Success", value: { environment: {} } },
    }),
  });

  await assert.rejects(
    () => fetchProviderCatalogue(ENVIRONMENT, { fetchImpl: ticketFetch(), WebSocketImpl: FakeSocket }),
    /did not return a providers array/u,
  );
});
