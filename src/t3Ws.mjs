// Minimal Effect-RPC-over-WebSocket client for T3 Code.
//
// The orchestration HTTP API exposes only projects and threads. Everything else — including the
// provider/harness catalogue — is served over an authenticated WebSocket speaking Effect's RPC
// protocol (effect/unstable/rpc). Reverse-engineered against T3 Code 0.0.28 and verified live
// through T3 Code 0.0.32.
//
// Wire protocol (effect RpcMessage):
//   client -> { _tag: "Request", id, tag, payload, headers: [[k,v]...] }
//             { _tag: "Ack", requestId } | { _tag: "Interrupt", requestId } | { _tag: "Eof" } | { _tag: "Ping" }
//   server -> { _tag: "Exit", requestId, exit: { _tag: "Success", value } | { _tag: "Failure", ... } }
//             { _tag: "Chunk", requestId, values: [...] }   (streaming RPCs)
//             { _tag: "Defect", defect }                    (unknown tag / protocol misuse)
//
// `tag` values come from T3's own WS_METHODS contract.

export const T3_WS_METHODS = Object.freeze({
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverGetSettings: "server.getSettings",
  subscribeServerConfig: "subscribeServerConfig",
  orchestrationDispatchCommand: "orchestration.dispatchCommand",
  orchestrationSubscribeThread: "orchestration.subscribeThread",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalAttach: "terminal.attach",
  terminalClose: "terminal.close",
});

const DEFAULT_TIMEOUT_MS = 10_000;
// A subscription can sit silent for a long time while an agent thinks. Tunnels and reverse
// proxies reap quiet sockets, so the client pings; T3 answers Pong (RpcServer.js:488-491).
const DEFAULT_PING_INTERVAL_MS = 30_000;

export async function requestWebSocketTicket(environment, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL("/api/auth/websocket-ticket", environment.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${environment.accessToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`T3 websocket ticket timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`T3 websocket ticket failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.ticket) throw new Error("T3 did not return a websocket ticket.");
  return payload.ticket;
}

export function webSocketUrlFor(baseUrl, ticket) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

/**
 * Performs a single request/response RPC and closes the socket.
 *
 * Kept deliberately one-shot: the gateway polls, so a persistent socket per environment would be
 * a connection-lifecycle problem without a matching benefit.
 */
export async function callT3Rpc(environment, tag, payload = {}, {
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("A WebSocket implementation is required to reach T3 over the socket API.");
  }

  const ticket = await requestWebSocketTicket(environment, { fetchImpl, timeoutMs });
  const socket = new WebSocketImpl(webSocketUrlFor(environment.baseUrl, ticket));
  const requestId = "1";

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closing; the result is what matters.
      }
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`T3 RPC ${tag} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (message._tag) {
        case "Chunk":
          if (message.requestId !== requestId) return;
          chunks.push(...(message.values ?? []));
          // Streaming RPCs stall until the client acknowledges each chunk.
          socket.send(JSON.stringify({ _tag: "Ack", requestId }));
          return;
        case "Exit": {
          if (message.requestId !== requestId) return;
          const exit = message.exit ?? {};
          if (exit._tag === "Success") {
            finish(null, chunks.length > 0 ? chunks : exit.value);
            return;
          }
          finish(new Error(`T3 RPC ${tag} failed: ${describeFailure(exit)}`));
          return;
        }
        case "Defect":
          finish(new Error(`T3 RPC ${tag} was rejected: ${stringify(message.defect)}`));
          return;
        default:
      }
    });

    socket.addEventListener("error", () => finish(new Error(`T3 websocket error during ${tag}.`)));
    socket.addEventListener("close", (event) => {
      finish(new Error(`T3 websocket closed before ${tag} completed (code ${event?.code ?? "unknown"}).`));
    });
  });
}

/**
 * The authoritative harness catalogue, read live from T3.
 *
 * `server.getConfig` returns the same provider records T3 writes to <base-dir>/caches/<id>.json,
 * so the result feeds straight into buildProviderCatalogue/mergeHostCatalogue.
 */
export async function fetchProviderCatalogue(environment, options = {}) {
  const config = await callT3Rpc(environment, T3_WS_METHODS.serverGetConfig, {}, options);
  const providers = config?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("T3 server.getConfig did not return a providers array.");
  }
  return providers;
}

/**
 * Opens a long-lived `orchestration.subscribeThread` subscription.
 *
 * Deliberately NOT built on `callT3Rpc`. That helper collects every chunk and resolves once, which
 * is the right shape for `server.getConfig` and exactly the wrong shape here: a thread
 * subscription never completes on its own, its whole value is each item arriving as it happens,
 * and it has to survive being closed and reopened.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CONTRACT, READ FROM T3 RATHER THAN GUESSED
 * ---------------------------------------------------------------------------------------------
 *
 * Verified against the installed T3 Code 0.0.32 (source map
 * /opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map, `sourcesContent`) plus the real Effect
 * runtime it bundles at node_modules/effect/dist/unstable/rpc/.
 *
 *   packages/contracts/src/rpc.ts:747-754  WsOrchestrationSubscribeThreadRpc, `stream: true`.
 *   packages/contracts/src/orchestration.ts:528-552  the input:
 *       { threadId, afterSequence?, requestCompletionMarker?, turnLimit? }
 *   packages/contracts/src/orchestration.ts:1413-1426  the output item, a THREE-way union:
 *       { kind: "synchronized" }
 *     | { kind: "snapshot",  snapshot: OrchestrationThreadDetailSnapshot }
 *     | { kind: "event",     event: OrchestrationEvent }
 *   src/auth/RpcAuthorization.ts:31  requires the `orchestration:read` scope, which standard
 *     pairing already requests (STANDARD_T3_SCOPES in src/app.mjs) — no new scope, no re-pairing.
 *
 * `afterSequence` is the resume cursor, and it is the GLOBAL event-log sequence, not the
 * per-activity `sequence` field. src/ws.ts:1317-1350 is explicit about what the server does with
 * it: it compares the cursor to the head, and past `THREAD_RESUME_MAX_GAP` (1000,
 * src/ws.ts:307) — or when the cursor is ahead of the head — it silently abandons the replay and
 * sends a fresh `snapshot` frame instead, because a truncated replay would drop events without
 * saying so. That behaviour is the gateway's answer to an unfillable gap; see src/threadStream.mjs.
 *
 * `requestCompletionMarker: true` asks for the `{kind:"synchronized"}` frame that separates the
 * initial snapshot/replay from live events (src/ws.ts:1339-1345, :1380-1387). Without it a client
 * cannot tell "still catching up" from "live".
 *
 * ---------------------------------------------------------------------------------------------
 * WHY EVERY CHUNK MUST BE ACKNOWLEDGED
 * ---------------------------------------------------------------------------------------------
 *
 * Not folklore — it is the server loop. effect/unstable/rpc/RpcServer.js:271-291 creates a latch
 * per streaming request, then for every chunk does `latch.closeUnsafe(); write(Chunk); await
 * latch`. Only an inbound `{_tag:"Ack", requestId}` opens it (RpcServer.js:103-106). So the first
 * chunk arrives unprompted and every subsequent one is blocked until we answer. Miss one Ack and
 * the subscription goes quiet forever while looking perfectly healthy.
 *
 * `{_tag:"Interrupt", requestId}` is the polite end (RpcServer.js:108-118): it interrupts the
 * server-side fiber instead of leaving it parked on a latch nobody will ever open.
 * `{_tag:"Ping"}` is answered with `Pong` (RpcServer.js:488-491), which is what keeps an idle
 * subscription alive through a tunnel that reaps quiet sockets.
 */
export function openT3ThreadStream(environment, {
  threadId,
  afterSequence = null,
  requestCompletionMarker = true,
  turnLimit = null,
  onItem = () => {},
  onOpen = () => {},
  onClose = () => {},
} = {}, {
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  ticketTimeoutMs = DEFAULT_TIMEOUT_MS,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
} = {}) {
  const requestId = "1";
  let socket = null;
  let closedByCaller = false;
  let settled = false;
  let pingTimer = null;

  const finish = (reason, error = null) => {
    if (settled) return;
    settled = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (socket) {
      // Only a caller-initiated teardown needs the Interrupt: it is the case where the server
      // fiber is alive and parked on the chunk latch, and closing the socket underneath it is
      // exactly what leaves it there. When T3 has already ended the stream (exit/defect) or the
      // socket is gone (error/close), there is nothing left to interrupt.
      if (reason === "closed") {
        try {
          socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
        } catch {
          // The socket is already gone; closing is still worth attempting.
        }
      }
      try {
        socket.close();
      } catch {
        // Same.
      }
    }
    try {
      onClose({ reason, error });
    } catch {
      // A caller that throws while being told the stream ended must not resurrect it.
    }
  };

  const start = async () => {
    let ticket;
    try {
      ticket = await requestWebSocketTicket(environment, { fetchImpl, timeoutMs: ticketTimeoutMs });
    } catch (error) {
      finish("ticket", error);
      return;
    }
    if (closedByCaller) {
      finish("closed");
      return;
    }
    if (typeof WebSocketImpl !== "function") {
      finish("unsupported", new Error("A WebSocket implementation is required to stream from T3."));
      return;
    }

    try {
      socket = new WebSocketImpl(webSocketUrlFor(environment.baseUrl, ticket));
    } catch (error) {
      finish("connect", error);
      return;
    }

    socket.addEventListener("open", () => {
      if (closedByCaller) {
        finish("closed");
        return;
      }
      const payload = { threadId };
      // Only send the cursor when we actually have one: an absent afterSequence is what asks
      // for the initial snapshot, and `0` is a legitimate cursor rather than "no cursor".
      if (Number.isFinite(afterSequence)) payload.afterSequence = afterSequence;
      if (requestCompletionMarker) payload.requestCompletionMarker = true;
      if (Number.isFinite(turnLimit) && turnLimit > 0) payload.turnLimit = turnLimit;
      socket.send(JSON.stringify({
        _tag: "Request",
        id: requestId,
        tag: T3_WS_METHODS.orchestrationSubscribeThread,
        payload,
        headers: [],
      }));
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          try {
            socket.send(JSON.stringify({ _tag: "Ping" }));
          } catch {
            // A dead socket will surface through close/error; the keepalive stays quiet.
          }
        }, pingIntervalMs);
        pingTimer.unref?.();
      }
      try {
        onOpen();
      } catch {
        // Same reasoning as onClose: a throwing observer must not take the stream down.
      }
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (message._tag) {
        case "Chunk": {
          if (message.requestId !== requestId) return;
          for (const value of message.values ?? []) {
            try {
              onItem(value);
            } catch {
              // Delivering item N+1 matters more than item N's handler throwing, and the Ack
              // below has to be sent either way or the stream stalls permanently.
            }
          }
          try {
            socket.send(JSON.stringify({ _tag: "Ack", requestId }));
          } catch (error) {
            finish("ack", error);
          }
          return;
        }
        case "Exit": {
          if (message.requestId !== requestId) return;
          const exit = message.exit ?? {};
          if (exit._tag === "Success") {
            finish("exit");
            return;
          }
          finish("failure", new Error(`T3 subscribeThread failed: ${describeFailure(exit)}`));
          return;
        }
        case "Defect":
          finish("defect", new Error(`T3 rejected subscribeThread: ${stringify(message.defect)}`));
          return;
        default:
          // Pong and anything newer T3 grows are ignored on purpose.
      }
    });

    socket.addEventListener("error", () => finish("error", new Error("T3 websocket error while streaming a thread.")));
    socket.addEventListener("close", (event) => {
      finish(closedByCaller ? "closed" : "socket-closed", closedByCaller
        ? null
        : new Error(`T3 websocket closed while streaming (code ${event?.code ?? "unknown"}).`));
    });
  };

  void start();

  return {
    close() {
      closedByCaller = true;
      finish("closed");
    },
  };
}

export const TERMINAL_SCOPE = "terminal:operate";

export function environmentHasTerminalScope(environment) {
  return Array.isArray(environment?.scopes) && environment.scopes.includes(TERMINAL_SCOPE);
}

/**
 * Writes directly into a T3 terminal (roadmap Phase 9 stage 3).
 *
 * `terminal.open` is idempotent enough to call first: terminal ids are client-chosen, so opening an
 * existing id attaches to it rather than creating a duplicate. `cwd` is required by the open
 * schema, so callers must supply one when the terminal may not exist yet.
 */
export async function writeTerminalInput(environment, { threadId, terminalId, data, cwd }, options = {}) {
  if (!environmentHasTerminalScope(environment)) {
    throw new Error(`This environment was not paired with the ${TERMINAL_SCOPE} scope.`);
  }
  if (cwd) {
    await callT3Rpc(environment, T3_WS_METHODS.terminalOpen, { threadId, terminalId, cwd }, options);
  }
  return await callT3Rpc(
    environment,
    T3_WS_METHODS.terminalWrite,
    { threadId, terminalId, data },
    options,
  );
}

function describeFailure(exit) {
  const cause = exit.cause ?? exit.error ?? exit;
  return stringify(cause?.error ?? cause?.message ?? cause);
}

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
