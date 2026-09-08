import { ConnectorOfflineError } from "./t3Transport.mjs";

const DEFAULT_BASE_URL = "http://connector-router.internal";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const CONNECTOR_LONG_POLL_MS = 25_000;
const EARLY_RETURN_RETRY_MS = 250;
const MAX_EARLY_RETURN_RETRY_MS = 5_000;
const SUBSCRIPTION_LEASE_MS = 5 * 60_000;
const CLEANUP_TIMEOUT_MS = 250;

export function createCloudflareConnectorRouter({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  randomUUID = () => crypto.randomUUID(),
  longPollMs = CONNECTOR_LONG_POLL_MS,
  pollIntervalMs = EARLY_RETURN_RETRY_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Connector router requires fetch.");
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "connector-router.internal") {
    throw new TypeError("CONNECTOR_ROUTER_BASE_URL must use the private connector-router.internal virtual host.");
  }

  async function jsonFetch(path, init = {}, signal) {
    const response = await fetchImpl(new URL(path, origin), { ...init, signal });
    const body = await response.json().catch(() => ({ error: "invalid_connector_router_response" }));
    if (!response.ok) throw connectorError(body, response.status);
    return body;
  }

  async function cleanupFetch(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Connector router cleanup timed out.", "TimeoutError"));
    }, CLEANUP_TIMEOUT_MS);
    try {
      await jsonFetch(path, init, controller.signal);
    } catch {
      // Cleanup is best-effort and must never replace the request/stream's primary outcome.
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async revoke({ environmentId, connectorId, reason = "revoked_by_user" }) {
      return await jsonFetch("/v1/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId, connectorId, reason }),
      });
    },

    async request(environment, input, options = {}) {
      const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS));
      const requestId = options.requestId ?? randomUUID();
      const idempotencyKey = options.idempotencyKey ?? requestId;
      const deadline = createDeadlineSignal(options.signal, timeoutMs);
      const signal = deadline.signal;
      const deadlineAt = Date.now() + timeoutMs;
      let dispatched = false;
      let retryDelayMs = pollIntervalMs;
      try {
        const receipt = await jsonFetch("/v1/requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            environmentId: environment.id,
            request: { connectorId: environment.connectorId, requestId, idempotencyKey, method: input.method, payload: input.payload, deadlineMs: timeoutMs },
          }),
        }, signal);
        dispatched = true;
        if (receipt.status === "completed") return receipt.result;
        if (receipt.status === "failed") throw terminalError(receipt, environment.id);
        while (Date.now() < deadlineAt) {
          const remainingMs = Math.max(1, deadlineAt - Date.now());
          const waitMs = Math.max(1, Math.min(longPollMs, remainingMs));
          const waitStartedAt = Date.now();
          const result = await jsonFetch(
            `/v1/requests/${encodeURIComponent(requestId)}?environmentId=${encodeURIComponent(environment.id)}&waitMs=${waitMs}`,
            {},
            signal,
          );
          if (result.status === "completed") return result.result;
          if (result.status === "failed") throw terminalError(result, environment.id);
          if (Date.now() - waitStartedAt < Math.min(waitMs, 100)) {
            await delay(Math.min(retryDelayMs, Math.max(1, deadlineAt - Date.now())), signal);
            retryDelayMs = Math.min(Math.max(1, retryDelayMs * 2), MAX_EARLY_RETURN_RETRY_MS);
          } else {
            retryDelayMs = pollIntervalMs;
          }
        }
        throw connectorError({ error: "connector_timeout", retryable: true }, 504, environment.id);
      } catch (error) {
        const normalizedError = deadline.timedOut && !options.signal?.aborted
          ? connectorError({ error: "connector_timeout", retryable: true }, 504, environment.id)
          : error;
        if (dispatched && (signal.aborted || normalizedError?.name === "AbortError" || normalizedError?.code === "connector_timeout")) {
          await cleanupFetch(`/v1/requests/${encodeURIComponent(requestId)}/cancel?environmentId=${encodeURIComponent(environment.id)}`, { method: "POST" });
        }
        if (normalizedError?.code === "connector_offline" && normalizedError.environmentId === "unknown") throw new ConnectorOfflineError(environment.id);
        if (normalizedError && typeof normalizedError === "object" && !normalizedError.environmentId) normalizedError.environmentId = environment.id;
        throw normalizedError;
      } finally {
        deadline.dispose();
      }
    },

    openThreadStream(environment, input, options = {}) {
      const leaseId = randomUUID();
      const controller = new AbortController();
      let closed = false;
      let deliverySequence = 0;
      let resumeCursor = Number.isSafeInteger(input.afterSequence) ? input.afterSequence : null;
      let renewAt = 0;
      let retryDelayMs = pollIntervalMs;
      let cleanupPromise = null;
      const subscriptionBody = () => ({
        environmentId: environment.id,
        subscription: {
          connectorId: environment.connectorId,
          leaseId,
          threadId: input.threadId,
          expiresAt: Date.now() + SUBSCRIPTION_LEASE_MS,
          ...(Number.isSafeInteger(resumeCursor) ? { cursor: resumeCursor } : {}),
          ...(Number.isSafeInteger(input.turnLimit ?? options.turnLimit) ? { turnLimit: input.turnLimit ?? options.turnLimit } : {}),
        },
      });
      const close = () => {
        if (closed) return cleanupPromise ?? Promise.resolve();
        closed = true;
        controller.abort();
        cleanupPromise = cleanupFetch(
          `/v1/subscriptions/${encodeURIComponent(leaseId)}?environmentId=${encodeURIComponent(environment.id)}`,
          { method: "DELETE" },
        );
        return cleanupPromise;
      };
      void (async () => {
        try {
          await jsonFetch("/v1/subscriptions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(subscriptionBody()),
          }, controller.signal);
          renewAt = Date.now() + Math.trunc(SUBSCRIPTION_LEASE_MS * 0.8);
          while (!closed) {
            if (Date.now() >= renewAt) {
              await jsonFetch("/v1/subscriptions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(subscriptionBody()),
              }, controller.signal);
              renewAt = Date.now() + Math.trunc(SUBSCRIPTION_LEASE_MS * 0.8);
            }
            const waitMs = Math.max(1, Math.min(longPollMs, Math.max(1, renewAt - Date.now())));
            const waitStartedAt = Date.now();
            const page = await jsonFetch(
              `/v1/subscriptions/${encodeURIComponent(leaseId)}?environmentId=${encodeURIComponent(environment.id)}&after=${deliverySequence}&waitMs=${waitMs}`,
              {},
              controller.signal,
            );
            const items = Array.isArray(page.items) ? page.items : [];
            for (const item of items) {
              if (!Number.isSafeInteger(item?.sequence) || item.sequence <= deliverySequence) continue;
              deliverySequence = item.sequence;
              if (item.value?.kind === "event" && Number.isSafeInteger(item.value.event?.sequence)) resumeCursor = item.value.event.sequence;
              input.onItem?.(item.value);
            }
            if (items.length === 0 && Date.now() - waitStartedAt < Math.min(waitMs, 100)) {
              await delay(retryDelayMs, controller.signal);
              retryDelayMs = Math.min(Math.max(1, retryDelayMs * 2), MAX_EARLY_RETURN_RETRY_MS);
            } else {
              retryDelayMs = pollIntervalMs;
            }
          }
        } catch (error) {
          if (!closed && error?.name !== "AbortError") {
            closed = true;
            input.onClose?.({ reason: "error", error });
          }
        }
      })();
      return { close };
    },
  };
}

function terminalError(result, environmentId) {
  return connectorError({ error: result.failure?.code ?? "request_failed", retryable: result.failure?.retryable === true }, 502, environmentId);
}

function connectorError(body, status, environmentId = "unknown") {
  const code = typeof body?.error === "string" ? body.error : "connector_router_unavailable";
  if (code === "connector_offline") return new ConnectorOfflineError(environmentId);
  const error = new Error(`Connector request failed (${code}).`);
  error.name = code === "connector_backpressure" ? "ConnectorBackpressureError" : "ConnectorRequestError";
  error.code = code;
  error.retryable = body?.retryable === true || status >= 500;
  error.status = status;
  error.environmentId = environmentId;
  return error;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createDeadlineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parentSignal.reason ?? new DOMException("Aborted", "AbortError"));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Connector request deadline exceeded.", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}
