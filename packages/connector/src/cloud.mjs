import { connectorAuthorization, requestJson } from "./http.mjs";

export const PROTOCOL_VERSION = 1;
export const CONNECTOR_VERSION = "0.1.0";

export async function enrollConnector({ server, code, label, capabilities = [], fetchImpl, platform }) {
  const payload = await requestJson(new URL("/v1/connectors/enroll", server), {
    fetchImpl,
    method: "POST",
    body: {
      code,
      ...(label ? { label } : {}),
      protocolVersion: PROTOCOL_VERSION,
      connectorVersion: CONNECTOR_VERSION,
      platform,
      capabilities,
    },
    expected: [200, 201],
  });
  const connectorId = payload?.connector?.id;
  const environmentId = payload?.environment?.id ?? payload?.connector?.environmentId;
  if (!connectorId || !environmentId || !payload?.secret) {
    throw Object.assign(new Error("Enrollment response is missing connector, environment, or secret."), { code: "ENROLLMENT_INVALID" });
  }
  return { connectorId, environmentId, secret: payload.secret, connector: payload.connector, environment: payload.environment };
}

export async function requestSocketTicket(state, { fetchImpl } = {}) {
  const payload = await requestJson(new URL("/v1/connectors/ticket", state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: {},
    expected: [200, 201],
  });
  if (!payload?.ticket) throw Object.assign(new Error("Ticket response did not include a ticket."), { code: "TICKET_INVALID" });
  return payload;
}

export async function revokeCloudConnector(state, { fetchImpl } = {}) {
  const payload = await requestJson(new URL("/v1/connectors/self/revoke", state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: {},
    expected: [200],
  });
  if (payload?.connector?.id !== state.connectorId
    || payload.connector.environmentId !== state.environmentId
    || payload.connector.status !== "revoked") {
    throw Object.assign(new Error("Cloud revocation response does not match this connector."), { code: "REVOCATION_INVALID" });
  }
  return payload.connector;
}

export async function beginCredentialRotation(state, { code, fetchImpl } = {}) {
  const payload = await requestJson(new URL(`/v1/connectors/${encodeURIComponent(state.connectorId)}/rotate`, state.server), {
    fetchImpl,
    method: "POST",
    headers: { authorization: connectorAuthorization(state) },
    body: { code },
    expected: [201],
  });
  if (payload?.connector?.id !== state.connectorId
    || payload.connector.environmentId !== state.environmentId
    || !payload?.rotation?.id
    || !payload?.rotation?.expiresAt
    || !payload?.secret) {
    throw Object.assign(new Error("Rotation response is missing the connector, rotation, or staged credential."), { code: "ROTATION_INVALID" });
  }
  return {
    connectorId: payload.connector.id,
    environmentId: payload.connector.environmentId,
    rotationId: payload.rotation.id,
    expiresAt: payload.rotation.expiresAt,
    secret: payload.secret,
  };
}

export function cloudSocketUrl(server, ticket) {
  const url = new URL("/v1/connectors/socket", server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
