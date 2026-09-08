import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createContainerServers } from "../../src/containerServer.mjs";

const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("container Node entry", () => {
  it("shares one Store while keeping connector capabilities off the public route chain", async () => {
    const internalPort = await freePort();
    const runtime = await createContainerServers({
      env: {
        DEPLOYMENT_ENVIRONMENT: "local",
        HOST: "127.0.0.1",
        PORT: "0",
        INTERNAL_HOST: "127.0.0.1",
        INTERNAL_PORT: String(internalPort),
        STORAGE_PROVIDER: "memory",
        AUTH_PROVIDER: "dev",
        ENABLE_DEV_TOKENS: "1",
        DISCOVERY_ENABLED: "0",
        SNAPSHOT_POLL_ENABLED: "0",
        THREAD_STREAM_ENABLED: "0",
        TRANSCRIPTION_WORKER_ENABLED: "0",
      },
      logger: { info() {}, error() {} },
    });
    runtimes.push(runtime);
    await runtime.start();

    const environment = await runtime.store.upsertEnvironment({
      userId: "user_container",
      label: "Container machine",
      transportMode: "connector",
      scopes: ["orchestration:read", "orchestration:operate"],
      status: "paired",
    });
    const enrolled = await runtime.store.createConnector({
      userId: "user_container",
      environmentId: environment.id,
      scopes: ["connector:connect", "t3:proxy"],
    });
    const minted = await runtime.store.createConnectorTicket({
      connectorId: enrolled.connector.id,
      audience: "agent-controller-connectors",
    });
    const now = Date.now();
    const privateResponse = await fetch(`http://127.0.0.1:${internalPort}/v1/internal/connectors/tickets/consume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: minted.ticket, audience: "agent-controller-connectors", now }),
    });
    expect(privateResponse.status).toBe(200);
    await expect(privateResponse.json()).resolves.toMatchObject({
      connectorId: enrolled.connector.id,
      environmentId: environment.id,
    });

    const publicPort = runtime.server.address().port;
    const publicResponse = await fetch(`http://127.0.0.1:${publicPort}/v1/internal/connectors/tickets/consume`, {
      method: "POST",
      headers: {
        authorization: "Bearer public-token-does-not-cross-realms",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ticket: "x".repeat(32), audience: "agent-controller-connectors", now }),
    });
    expect(publicResponse.status).toBe(404);
  });
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
