import assert from "node:assert/strict";
import test from "node:test";
import { enrollConnector, requestSocketTicket, revokeCloudConnector } from "../src/cloud.mjs";

test("enrollment never sends local T3 authority to cloud", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ connector: { id: "con_1" }, environment: { id: "env_1" }, secret: "secret" }), { status: 201 });
  };
  const result = await enrollConnector({ server: "https://cloud.example", code: "short-code", label: "Laptop", capabilities: ["snapshot"], platform: "darwin", fetchImpl });
  assert.equal(result.connectorId, "con_1");
  assert.deepEqual(Object.keys(request.body).sort(), ["capabilities", "code", "connectorVersion", "label", "platform", "protocolVersion"]);
  assert.equal(JSON.stringify(request.body).includes("3773"), false);
});

test("ticket uses connector realm authorization", async () => {
  let authorization;
  const fetchImpl = async (_url, options) => {
    authorization = options.headers.authorization;
    return new Response(JSON.stringify({ ticket: "short-lived" }), { status: 201 });
  };
  const ticket = await requestSocketTicket({ server: "https://cloud.example", connectorId: "con_1", secret: "standing" }, { fetchImpl });
  assert.equal(ticket.ticket, "short-lived");
  assert.equal(authorization, "Connector con_1.standing");
});

test("self-revocation uses only the connector realm and validates response identity", async () => {
  let request;
  const state = { server: "https://cloud.example", connectorId: "con_1", environmentId: "env_1", secret: "standing" };
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ connector: { id: "con_1", environmentId: "env_1", status: "revoked" } }));
  };
  await revokeCloudConnector(state, { fetchImpl });
  assert.equal(request.url, "https://cloud.example/v1/connectors/self/revoke");
  assert.equal(request.options.headers.authorization, "Connector con_1.standing");
  assert.equal(JSON.stringify(request).includes("Bearer"), false);
  await assert.rejects(revokeCloudConnector(state, {
    fetchImpl: async () => new Response(JSON.stringify({ connector: { id: "other", environmentId: "env_1", status: "revoked" } })),
  }), { code: "REVOCATION_INVALID" });
});
