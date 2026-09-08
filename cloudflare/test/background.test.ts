import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { RuntimeBindings } from "../src/env";

const bindings = env as unknown as RuntimeBindings;

describe("Worker background handlers", () => {
  it("reports binding-derived control-plane and background ownership health", async () => {
    const healthyRuntime = {
      ...bindings,
      DEPLOYMENT_ENVIRONMENT: "production" as const,
      CONNECTOR_AUTH_MODE: "control-plane" as const,
      CONTROL_PLANE: { async fetch() { return Response.json({}); } } as unknown as Fetcher,
    } as unknown as RuntimeBindings;
    const healthy = await worker.fetch(new Request("https://edge.example/health"), healthyRuntime);
    expect(healthy.status).toBe(200);
    await expect(healthy.json()).resolves.toMatchObject({
      ok: true,
      controlPlaneAdapterIntegrated: true,
      sameOriginControlPlaneBound: true,
      backgroundQueueConfigured: true,
      backgroundQuarantineConfigured: true,
      backgroundOwnershipHealthy: true,
      backgroundDeadLetterPolicy: "redacted-envelope-plus-broker-dlq",
      scheduledOwnership: "cloudflare-queue",
    });

    const { BACKGROUND_TASKS: _backgroundTasks, ...withoutBackground } = healthyRuntime;
    const unhealthy = await worker.fetch(
      new Request("https://edge.example/health"),
      withoutBackground as unknown as RuntimeBindings,
    );
    expect(unhealthy.status).toBe(503);
    await expect(unhealthy.json()).resolves.toMatchObject({
      ok: false,
      controlPlaneAdapterIntegrated: true,
      backgroundQueueConfigured: false,
      backgroundOwnershipHealthy: false,
      scheduledOwnership: "unconfigured",
    });
  });

  it("consumes a connector event batch through the private binding in Miniflare", async () => {
    const calls: string[] = [];
    const runtime = {
      ...bindings,
      CONTROL_PLANE: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init);
          calls.push(new URL(request.url).pathname);
          return Response.json({ accepted: true });
        },
      } as Fetcher,
    } as unknown as RuntimeBindings;
    const batch = createMessageBatch("agent-controller-connector-events-local", [{
      id: "event_1",
      timestamp: new Date(),
      attempts: 1,
      body: {
        eventVersion: 1,
        environmentId: "env_1",
        connectorId: "ctr_1",
        connectionId: "conn_1",
        occurredAt: 100,
        kind: "connector.heartbeat",
        body: { activeRequests: 0, queueDepth: 0 },
      },
    }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, runtime);
    const result = await getQueueResult(batch, ctx);
    expect(result).toBeDefined();
    expect(calls).toEqual(["/v1/internal/background/run"]);
  });

  it("scheduled dispatch is explicit and queue-owned", async () => {
    const sent: unknown[] = [];
    const runtime = {
      ...bindings,
      BACKGROUND_TASKS: {
        async send() {},
        async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
          for (const message of messages) sent.push(message.body);
          return { outcome: "ok" } as unknown as QueueSendBatchResponse;
        },
      } as unknown as Queue<unknown>,
    } as unknown as RuntimeBindings;
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: new Date(1234) }), runtime);
    expect(sent).toMatchObject([
      { kind: "scheduler.heartbeat" },
      { kind: "rollout.reconcile" },
      { kind: "media.process" },
      { kind: "push.deliver" },
      { kind: "maintenance.fanout" },
    ]);
  });
});
