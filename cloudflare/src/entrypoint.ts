import { WorkerEntrypoint } from "cloudflare:workers";

import type { RuntimeBindings } from "./env";
import type { ConnectorRequestInput } from "./protocol";
import { DurableObjectConnectorRouter } from "./router";
import { ConnectorRouterError, type ConnectorSubscriptionInput } from "./router";

export type RpcJson = null | boolean | number | string | RpcJson[] | { [key: string]: RpcJson };
export type ConnectorRpcResult = { ok: true; value: RpcJson } | { ok: false; status: number; error: RpcJson };

/**
 * Private RPC surface for a deployed control-plane Worker. A caller binds to
 * this named entrypoint; none of these methods are exposed as public HTTP
 * routes in staging or production.
 */
export class ControlPlaneConnectorRouterEntrypoint extends WorkerEntrypoint<RuntimeBindings> {
  async connectorStatus(environmentId: string): Promise<RpcJson> {
    return toRpcJson(await this.router().status(environmentId));
  }

  async submitConnectorRequest(environmentId: string, request: ConnectorRequestInput): Promise<RpcJson> {
    return toRpcJson(await this.router().submit(environmentId, request));
  }

  async connectorRequestResult(environmentId: string, requestId: string): Promise<RpcJson> {
    return toRpcJson(await this.router().result(environmentId, requestId));
  }

  async routeConnectorRequest(environmentId: string, request: ConnectorRequestInput): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().submit(environmentId, request));
  }

  async pollConnectorRequest(environmentId: string, requestId: string, waitMs = 0): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().result(environmentId, requestId, waitMs));
  }

  async cancelConnectorRequest(environmentId: string, requestId: string): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().cancel(environmentId, requestId));
  }

  async openConnectorSubscription(environmentId: string, input: ConnectorSubscriptionInput): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().openSubscription(environmentId, input));
  }

  async pollConnectorSubscription(environmentId: string, leaseId: string, after: number, waitMs = 0): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().pollSubscription(environmentId, leaseId, after, waitMs));
  }

  async closeConnectorSubscription(environmentId: string, leaseId: string): Promise<ConnectorRpcResult> {
    return await rpcResult(() => this.router().closeSubscription(environmentId, leaseId));
  }

  async routeConnectorRevocation(environmentId: string, connectorId: string, reason = "revoked_by_user"): Promise<ConnectorRpcResult> {
    return await rpcResult(async () => {
      await this.router().revoke(environmentId, connectorId, reason);
      return { revoked: true };
    });
  }

  async revokeConnector(environmentId: string, connectorId: string, reason = "revoked"): Promise<void> {
    await this.router().revoke(environmentId, connectorId, reason);
  }

  async disconnectConnector(environmentId: string, reason = "operator_disconnect"): Promise<void> {
    await this.router().disconnect(environmentId, reason);
  }

  private router(): DurableObjectConnectorRouter {
    return new DurableObjectConnectorRouter(this.env.ENVIRONMENT_CONNECTOR_HUB);
  }
}

async function rpcResult(operation: () => Promise<unknown>): Promise<ConnectorRpcResult> {
  try {
    return { ok: true, value: toRpcJson(await operation()) };
  } catch (error) {
    if (error instanceof ConnectorRouterError) {
      return { ok: false, status: error.status, error: toRpcJson(error.body) };
    }
    return { ok: false, status: 502, error: { error: "connector_router_unavailable", retryable: true } };
  }
}

function toRpcJson(value: unknown): RpcJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Connector router returned a non-serializable result.");
  return JSON.parse(encoded) as RpcJson;
}
