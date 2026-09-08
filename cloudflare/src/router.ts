import type { EnvironmentConnectorHub, ConnectorTerminalResult } from "./hub";
import type { ConnectorRequestInput } from "./protocol";

export interface ConnectorRouteReceipt {
  requestId: string;
  status: "dispatched" | "accepted";
  deadlineAt: number;
}

export interface ConnectorRouter {
  status(environmentId: string): Promise<unknown>;
  submit(environmentId: string, request: ConnectorRequestInput): Promise<ConnectorRouteReceipt | ConnectorTerminalResult>;
  result(environmentId: string, requestId: string, waitMs?: number): Promise<ConnectorTerminalResult | unknown>;
  cancel(environmentId: string, requestId: string): Promise<unknown>;
  openSubscription(environmentId: string, input: ConnectorSubscriptionInput): Promise<unknown>;
  pollSubscription(environmentId: string, leaseId: string, after: number, waitMs?: number): Promise<unknown>;
  closeSubscription(environmentId: string, leaseId: string): Promise<unknown>;
  revoke(environmentId: string, connectorId: string, reason?: string): Promise<void>;
  disconnect(environmentId: string, reason?: string): Promise<void>;
}

export interface ConnectorSubscriptionInput {
  connectorId?: string;
  leaseId: string;
  threadId: string;
  cursor?: number;
  turnLimit?: number;
  expiresAt?: number;
}

/**
 * Cloudflare-side routing boundary for the Node/backend T3Transport adapter.
 * Each call targets the Durable Object named for the environment. Submit is
 * deliberately receipt-based. Result and subscription reads support bounded
 * 25-second waits that wake on durable-state changes; callers reissue them
 * after timeout, reconnect, or isolate turnover using request and cursor IDs.
 */
export class DurableObjectConnectorRouter implements ConnectorRouter {
  constructor(private readonly hubs: DurableObjectNamespace<EnvironmentConnectorHub>) {}

  async status(environmentId: string): Promise<unknown> {
    return await this.jsonFetch(environmentId, "/status");
  }

  async submit(environmentId: string, request: ConnectorRequestInput): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return (await this.jsonFetch(environmentId, "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })) as ConnectorRouteReceipt | ConnectorTerminalResult;
  }

  async result(environmentId: string, requestId: string, waitMs = 0): Promise<ConnectorTerminalResult | unknown> {
    return await this.jsonFetch(environmentId, `/requests/${encodeURIComponent(requestId)}?waitMs=${boundedWaitMs(waitMs)}`);
  }

  async cancel(environmentId: string, requestId: string): Promise<unknown> {
    return await this.jsonFetch(environmentId, `/requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST" });
  }

  async openSubscription(environmentId: string, input: ConnectorSubscriptionInput): Promise<unknown> {
    return await this.jsonFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async pollSubscription(environmentId: string, leaseId: string, after: number, waitMs = 0): Promise<unknown> {
    return await this.jsonFetch(
      environmentId,
      `/subscriptions/${encodeURIComponent(leaseId)}?after=${after}&waitMs=${boundedWaitMs(waitMs)}`,
    );
  }

  async closeSubscription(environmentId: string, leaseId: string): Promise<unknown> {
    return await this.jsonFetch(environmentId, `/subscriptions/${encodeURIComponent(leaseId)}`, { method: "DELETE" });
  }

  async revoke(environmentId: string, connectorId: string, reason = "revoked"): Promise<void> {
    await this.jsonFetch(environmentId, "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId, reason }),
    });
  }

  async disconnect(environmentId: string, reason = "operator_disconnect"): Promise<void> {
    await this.jsonFetch(environmentId, "/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  }

  private async jsonFetch(environmentId: string, path: string, init?: RequestInit): Promise<unknown> {
    assertIdentifier(environmentId, "environmentId");
    const id = this.hubs.idFromName(environmentId);
    const response = await this.hubs.get(id).fetch(`https://environment-hub.internal${path}`, init);
    const body: unknown = await response.json().catch(() => ({ error: "invalid_hub_response" }));
    if (!response.ok && response.status !== 202) throw new ConnectorRouterError(response.status, body);
    return body;
  }
}

export class ConnectorRouterError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(errorMessage(body, status));
    this.name = "ConnectorRouterError";
  }
}

export interface ConnectorTransportOptions {
  requestId?: string;
  idempotencyKey?: string;
  deadlineMs?: number;
}

/**
 * T3Transport-shaped facade for backend integration. It defines stable method
 * tags but does not claim stream or feature parity with the current Node T3
 * client. The backend must join receipts to its durable command arbiter.
 */
export class ConnectorT3TransportBoundary {
  constructor(private readonly router: ConnectorRouter) {}

  environmentInfo(environmentId: string, options?: ConnectorTransportOptions): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return this.call(environmentId, "environmentInfo", {}, options);
  }

  snapshot(environmentId: string, options?: ConnectorTransportOptions): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return this.call(environmentId, "snapshot", {}, options);
  }

  threadDetail(environmentId: string, threadId: string, options?: ConnectorTransportOptions): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return this.call(environmentId, "threadDetail", { threadId }, options);
  }

  dispatch(environmentId: string, command: unknown, options?: ConnectorTransportOptions): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return this.call(environmentId, "dispatch", { command }, options);
  }

  callRpc(environmentId: string, tag: string, payload: unknown, options?: ConnectorTransportOptions): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    return this.call(environmentId, "callRpc", { tag, payload }, options);
  }

  openThreadStream(
    environmentId: string,
    input: { threadId: string; cursor?: string; leaseId: string; leaseExpiresAt: number },
    options?: ConnectorTransportOptions,
  ): Promise<unknown> {
    return this.router.openSubscription(environmentId, {
      leaseId: input.leaseId,
      threadId: input.threadId,
      ...(input.cursor !== undefined ? { cursor: Number(input.cursor) } : {}),
      expiresAt: input.leaseExpiresAt,
    });
  }

  closeThreadStream(
    environmentId: string,
    input: { threadId: string; leaseId: string },
    options?: ConnectorTransportOptions,
  ): Promise<unknown> {
    void options;
    return this.router.closeSubscription(environmentId, input.leaseId);
  }

  private async call(
    environmentId: string,
    method: string,
    payload: unknown,
    options: ConnectorTransportOptions = {},
  ): Promise<ConnectorRouteReceipt | ConnectorTerminalResult> {
    const requestId = options.requestId ?? crypto.randomUUID();
    const idempotencyKey = options.idempotencyKey ?? requestId;
    return await this.router.submit(environmentId, {
      requestId,
      idempotencyKey,
      method,
      payload,
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    });
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is invalid.`);
}

function boundedWaitMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), 25_000)) : 0;
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return `${body.error} (${status})`;
  }
  return `Connector router failed with status ${status}.`;
}
