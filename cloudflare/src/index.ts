import type { RuntimeBindings } from "./env";
import { handleBackgroundQueue, handleBackgroundScheduled } from "./background";
import { forwardControlPlaneRequest, hasRequiredControlPlaneBinding } from "./controlPlane";
import { ControlPlaneConnectorRouterEntrypoint } from "./entrypoint";
import { EnvironmentConnectorHub } from "./hub";
import { DurableObjectConnectorRouter } from "./router";
import {
  createTicketVerifier,
  DevelopmentConnectorTicketStore,
  issueDevelopmentTicket,
  parseTicketClaims,
} from "./tickets";
import { CONNECTOR_TICKET_TTL_MS, isRecord, type ConnectorTicketClaims } from "./protocol";
import { hardenResponse } from "./securityHeaders";
import { edgeOperation, emitTelemetry } from "./telemetry";

export { ControlPlaneConnectorRouterEntrypoint, EnvironmentConnectorHub, DevelopmentConnectorTicketStore };
export * from "./controlPlane";
export * from "./background";
export * from "./protocol";
export * from "./router";
export * from "./tickets";

export default {
  async fetch(request: Request, env: RuntimeBindings): Promise<Response> {
    const startedAt = performance.now();
    let response: Response;
    try {
      response = hardenResponse(await handleRequest(request, env));
    } catch (error) {
      response = hardenResponse(json(
        {
          error: "cloud_runtime_error",
          message:
            env.DEPLOYMENT_ENVIRONMENT === "local" && error instanceof Error
              ? error.message
              : "Cloud runtime request failed.",
        },
        500,
      ));
    }
    emitTelemetry(env, {
      kind: "edge_request",
      operation: edgeOperation(request),
      outcome: response.status >= 500 ? "failure" : response.status >= 400 ? "rejected" : "success",
      status: response.status,
      durationMs: performance.now() - startedAt,
    });
    return response;
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeBindings): Promise<void> {
    await handleBackgroundQueue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: RuntimeBindings): Promise<void> {
    await handleBackgroundScheduled(controller, env);
  },
} satisfies ExportedHandler<RuntimeBindings>;

async function handleRequest(request: Request, env: RuntimeBindings): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    const controlPlaneConfigured = hasRequiredControlPlaneBinding(env);
    const controlPlaneBound = Boolean(env.CONTROL_PLANE);
    const backgroundQueueConfigured = Boolean(env.BACKGROUND_TASKS);
    const backgroundQuarantineConfigured = Boolean(env.BACKGROUND_QUARANTINE);
    const backgroundOwnershipHealthy = backgroundQueueConfigured && backgroundQuarantineConfigured;
    const configured = controlPlaneConfigured && backgroundOwnershipHealthy;
    return json({
      ok: configured,
      runtime: "cloudflare-workers",
      environment: env.DEPLOYMENT_ENVIRONMENT,
      connectorAuth: env.CONNECTOR_AUTH_MODE,
      eventSinkConfigured: Boolean(env.CONNECTOR_EVENTS || env.CONNECTOR_EVENT_SINK),
      backgroundQueueConfigured,
      backgroundQuarantineConfigured,
      backgroundDeadLetterPolicy: backgroundQuarantineConfigured ? "redacted-envelope-plus-broker-dlq" : "unconfigured",
      backgroundOwnershipHealthy,
      scheduledOwnership: backgroundQueueConfigured ? "cloudflare-queue" : "unconfigured",
      sameOriginControlPlaneBound: controlPlaneBound,
      controlPlaneAdapterIntegrated: controlPlaneBound,
    }, configured ? 200 : 503);
  }

  if (url.pathname === "/v1/connectors/socket" && request.method === "GET") {
    if (!hasRequiredControlPlaneBinding(env)) return controlPlaneUnconfigured();
    return await upgradeConnector(request, env);
  }

  if (url.pathname === "/__dev/tickets" && request.method === "POST") {
    return await createDevelopmentTicket(request, env);
  }

  if (url.pathname.startsWith("/internal/environments/")) {
    if (env.DEPLOYMENT_ENVIRONMENT !== "local") return json({ error: "not_found" }, 404);
    return await handleInternalRouter(request, env);
  }

  if (url.pathname.startsWith("/v1/internal/")) {
    return json({ error: "not_found" }, 404);
  }

  if (url.pathname.startsWith("/v1/")) {
    return await forwardControlPlaneRequest(request, env);
  }

  if (url.pathname.startsWith("/internal/") || url.pathname.startsWith("/__dev/")) {
    return json(
      {
        error: "route_not_integrated",
        message: "This scaffold does not yet adapt the Node control-plane route chain to Workers.",
      },
      501,
    );
  }

  return await serveAsset(request, env);
}

function controlPlaneUnconfigured(): Response {
  return json(
    { error: "control_plane_unconfigured", message: "The same-origin control-plane Service Binding is not configured." },
    503,
  );
}

async function upgradeConnector(request: Request, env: RuntimeBindings): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required" }, 426);
  }
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket");
  if (!ticket || ticket.length < 16 || ticket.length > 512) return json({ error: "invalid_connector_ticket" }, 401);

  let claims: ConnectorTicketClaims | null;
  try {
    claims = await createTicketVerifier(env).consume(ticket, env.CONNECTOR_TICKET_AUDIENCE, Date.now());
  } catch {
    return json({ error: "control_plane_unavailable", message: "Connector ticket verification is unavailable." }, 502);
  }
  if (!claims || !claims.scopes.includes("connector:connect")) return json({ error: "invalid_connector_ticket" }, 401);

  const hub = env.ENVIRONMENT_CONNECTOR_HUB.get(env.ENVIRONMENT_CONNECTOR_HUB.idFromName(claims.environmentId));
  const headers = ticketHeaders(claims);
  headers.set("upgrade", "websocket");
  // Do not forward the public URL: it contains the now-consumed ticket.
  return await hub.fetch("https://environment-hub.internal/socket", { method: "GET", headers });
}

async function createDevelopmentTicket(request: Request, env: RuntimeBindings): Promise<Response> {
  if (env.DEPLOYMENT_ENVIRONMENT !== "local" || env.CONNECTOR_AUTH_MODE !== "dev-do") {
    return json({ error: "not_found" }, 404);
  }
  if (!env.DEV_TICKET_ISSUER_SECRET || !secretMatches(request.headers.get("authorization"), env.DEV_TICKET_ISSUER_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  const value: unknown = await request.json().catch(() => null);
  if (!isRecord(value) || typeof value.connectorId !== "string" || typeof value.environmentId !== "string") {
    return json({ error: "invalid_request" }, 400);
  }

  const now = Date.now();
  const requestedExpiry = typeof value.expiresAt === "number" ? value.expiresAt : now + CONNECTOR_TICKET_TTL_MS;
  const expiresAt = Math.min(requestedExpiry, now + CONNECTOR_TICKET_TTL_MS);
  const ticket = `ac_ticket_${crypto.randomUUID()}_${crypto.randomUUID()}`;
  const claims: ConnectorTicketClaims = {
    ticketId: crypto.randomUUID(),
    connectorId: value.connectorId,
    environmentId: value.environmentId,
    audience: env.CONNECTOR_TICKET_AUDIENCE,
    scopes: Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string")
      ? value.scopes.slice(0, 32)
      : ["connector:connect", "t3:proxy"],
    expiresAt,
  };
  if (!parseTicketClaims(claims, env.CONNECTOR_TICKET_AUDIENCE, now)) return json({ error: "invalid_ticket_claims" }, 400);
  await issueDevelopmentTicket(env, ticket, claims, now);
  return json({ ticket, claims }, 201);
}

async function handleInternalRouter(request: Request, env: RuntimeBindings): Promise<Response> {
  if (!env.ROUTER_SHARED_SECRET || !secretMatches(request.headers.get("authorization"), env.ROUTER_SHARED_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const match = /^\/internal\/environments\/([^/]+)\/connector(\/.*)?$/.exec(url.pathname);
  if (!match?.[1]) return json({ error: "not_found" }, 404);
  const environmentId = decodeURIComponent(match[1]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(environmentId)) return json({ error: "invalid_environment_id" }, 400);

  const hub = env.ENVIRONMENT_CONNECTOR_HUB.get(env.ENVIRONMENT_CONNECTOR_HUB.idFromName(environmentId));
  const path = match[2] || "/status";
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return await hub.fetch(`https://environment-hub.internal${path}${url.search}`, init);
}

async function serveAsset(request: Request, env: RuntimeBindings): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404 || request.method !== "GET") return response;
  const accept = request.headers.get("accept") ?? "";
  const url = new URL(request.url);
  if (!accept.includes("text/html") || /\.[^/]+$/.test(url.pathname)) return response;
  const indexUrl = new URL("/index.html", url);
  return await env.ASSETS.fetch(new Request(indexUrl, request));
}

function ticketHeaders(claims: ConnectorTicketClaims): Headers {
  const headers = new Headers({
    "x-ac-ticket-verified": "1",
    "x-ac-ticket-id": claims.ticketId,
    "x-ac-connector-id": claims.connectorId,
    "x-ac-environment-id": claims.environmentId,
    "x-ac-ticket-audience": claims.audience,
    "x-ac-ticket-expires-at": String(claims.expiresAt),
    "x-ac-ticket-scopes": claims.scopes.join(","),
  });
  return headers;
}

function secretMatches(authorization: string | null, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
