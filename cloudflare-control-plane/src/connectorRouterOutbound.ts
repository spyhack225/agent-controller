import type { RuntimeBindings } from "./env";

const MAX_BODY_BYTES = 1024 * 1024;

export async function handleConnectorRouterOutbound(request: Request, env: RuntimeBindings): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/v1/requests") {
      const body = await readBody(request);
      return rpcResponse(await env.CONNECTOR_ROUTER.routeConnectorRequest(body.environmentId, body.request));
    }
    const requestMatch = url.pathname.match(/^\/v1\/requests\/([^/]+)$/);
    if (requestMatch && request.method === "GET") {
      return rpcResponse(await env.CONNECTOR_ROUTER.pollConnectorRequest(
        requireEnvironment(url),
        decodeURIComponent(requestMatch[1]!),
        boundedWaitMs(url),
      ));
    }
    const cancelMatch = url.pathname.match(/^\/v1\/requests\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      return rpcResponse(await env.CONNECTOR_ROUTER.cancelConnectorRequest(requireEnvironment(url), decodeURIComponent(cancelMatch[1]!)));
    }
    if (request.method === "POST" && url.pathname === "/v1/subscriptions") {
      const body = await readBody(request);
      return rpcResponse(await env.CONNECTOR_ROUTER.openConnectorSubscription(body.environmentId, body.subscription));
    }
    if (request.method === "POST" && url.pathname === "/v1/revoke") {
      const body = await readBody(request);
      return rpcResponse(await env.CONNECTOR_ROUTER.routeConnectorRevocation(body.environmentId, body.connectorId, body.reason));
    }
    const subscriptionMatch = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (subscriptionMatch && request.method === "GET") {
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
      return rpcResponse(await env.CONNECTOR_ROUTER.pollConnectorSubscription(
        requireEnvironment(url),
        decodeURIComponent(subscriptionMatch[1]!),
        after,
        boundedWaitMs(url),
      ));
    }
    if (subscriptionMatch && request.method === "DELETE") {
      return rpcResponse(await env.CONNECTOR_ROUTER.closeConnectorSubscription(requireEnvironment(url), decodeURIComponent(subscriptionMatch[1]!)));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    const code = error instanceof BoundaryError ? error.code : "connector_router_unavailable";
    const status = error instanceof BoundaryError ? error.status : 502;
    return Response.json({ error: code, retryable: status >= 500 }, { status, headers: { "cache-control": "no-store" } });
  }
}

async function readBody(request: Request): Promise<Record<string, any>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BoundaryError("payload_too_large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new BoundaryError("payload_too_large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new BoundaryError("invalid_request", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoundaryError("invalid_request", 400);
  return value as Record<string, any>;
}

function requireEnvironment(url: URL): string {
  const value = url.searchParams.get("environmentId");
  if (!value) throw new BoundaryError("environment_required", 400);
  return value;
}

function boundedWaitMs(url: URL): number {
  const value = Number(url.searchParams.get("waitMs") ?? 0);
  if (!Number.isInteger(value) || value < 0) throw new BoundaryError("invalid_wait", 400);
  return Math.min(value, 25_000);
}

function rpcResponse(result: { ok: boolean; value?: unknown; status?: number; error?: unknown }): Response {
  if (result.ok) return Response.json(result.value, { headers: { "cache-control": "no-store" } });
  return Response.json(result.error ?? { error: "connector_router_unavailable" }, {
    status: result.status && result.status >= 400 && result.status <= 599 ? result.status : 502,
    headers: { "cache-control": "no-store" },
  });
}

class BoundaryError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
