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
