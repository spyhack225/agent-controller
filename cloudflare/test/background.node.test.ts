import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { handleBackgroundQueue, handleBackgroundScheduled } from "../src/background";
import type { RuntimeBindings } from "../src/env";

describe("cloud background ownership", () => {
  it("configures a per-environment broker DLQ for every source consumer", async () => {
    const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as Record<string, any>;
    for (const [name, queues] of [
      ["local", config.queues],
      ["staging", config.env.staging.queues],
      ["production", config.env.production.queues],
    ] as const) {
      const expected = `agent-controller-dead-letter-${name}`;
      expect(queues.producers).toContainEqual({ binding: "BACKGROUND_QUARANTINE", queue: expected });
      expect(queues.consumers.length).toBeGreaterThan(0);
      expect(queues.consumers.every((consumer: Record<string, unknown>) => consumer.dead_letter_queue === expected)).toBe(true);
      expect(queues.consumers.every((consumer: Record<string, unknown>) => consumer.max_retries === 5)).toBe(true);
    }
  });

  it("projects connector events over the private control-plane binding and handles partial failures", async () => {
    const paths: string[] = [];
    const quarantined: unknown[] = [];
    const controlPlane = fetcher(async (request) => {
      paths.push(new URL(request.url).pathname);
      const task = await request.json() as { taskId: string };
      if (task.taskId.includes("retry")) return Response.json({ error: "busy", retryable: true }, { status: 503 });
      if (task.taskId.includes("terminal")) return Response.json({ error: "invalid", retryable: false }, { status: 400 });
      return Response.json({ accepted: true });
    });
    const messages = [
      message("event-ok", connectorEvent(300, "connector.heartbeat")),
      message("task-retry", task("media.process", "retry-task", {})),
      message("task-terminal", task("media.retention", "terminal-task", { userId: "u1" })),
    ];
    await handleBackgroundQueue(batch(messages), bindings({
      CONTROL_PLANE: controlPlane,
      BACKGROUND_QUARANTINE: queue(quarantined),
    }));
    expect(messages.map((entry) => entry.action)).toEqual(["ack", "retry", "ack"]);
    expect(paths).toEqual([
      "/v1/internal/background/run",
      "/v1/internal/background/run",
      "/v1/internal/background/run",
    ]);
    expect(quarantined).toMatchObject([{
      version: 1,
      source: "background",
      attempts: 1,
      classification: "terminal",
      failureCode: "invalid",
      taskKind: "media.retention",
    }]);
    expect(JSON.stringify(quarantined)).not.toContain("u1");
  });

  it("quarantines retry exhaustion and malformed work with redacted metadata", async () => {
    const quarantined: unknown[] = [];
    const secret = "private-prompt-must-not-enter-quarantine";
    const exhausted = message("broker-id-exhausted", task("media.process", "private-task-id", { prompt: secret }), 6);
    const malformed = message("broker-id-malformed", { prompt: secret }, 1);
    await handleBackgroundQueue(batch([exhausted, malformed]), bindings({
      CONTROL_PLANE: fetcher(async () => Response.json({ error: "busy", retryable: true }, { status: 503 })),
      BACKGROUND_QUARANTINE: queue(quarantined),
    }));
    expect([exhausted.action, malformed.action]).toEqual(["ack", "ack"]);
    expect(quarantined).toMatchObject([
      { classification: "retry_exhausted", attempts: 6, failureCode: "busy", taskKind: "media.process" },
      { classification: "malformed", attempts: 1, failureCode: "background_task_invalid" },
    ]);
    const serialized = JSON.stringify(quarantined);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-task-id");
    expect(serialized).not.toContain("broker-id-");
  });

  it("retries terminal work when quarantine is unavailable instead of dropping it", async () => {
    const invalid = message("invalid-without-quarantine", { malformed: true });
    await handleBackgroundQueue(batch([invalid]), bindings({}));
    expect(invalid.action).toBe("retry");
  });

  it("accepts empty batches without contacting the control plane", async () => {
    let calls = 0;
    await handleBackgroundQueue(batch([]), bindings({ CONTROL_PLANE: fetcher(async () => (calls++, Response.json({}))) }));
    expect(calls).toBe(0);
  });

  it("cron dispatches media plus durable maintenance fan-out and fails when ownership is disabled", async () => {
    const sent: unknown[] = [];
    const env = bindings({ BACKGROUND_TASKS: queue(sent) });
    await handleBackgroundScheduled({ cron: "*/5 * * * *", scheduledTime: 1234 } as ScheduledController, env);
    expect(sent).toMatchObject([
      { kind: "scheduler.heartbeat" },
      { kind: "rollout.reconcile" },
      { kind: "media.process" },
      { kind: "push.deliver" },
      { kind: "maintenance.fanout" },
    ]);
    await expect(handleBackgroundScheduled(
      { cron: "*/5 * * * *", scheduledTime: 1234 } as ScheduledController,
      bindings({}),
    )).rejects.toThrow("BACKGROUND_TASKS");
  });

  it("fans users into bounded snapshot, media-retention, and environment-retention tasks with a durable continuation", async () => {
    const sent: unknown[] = [];
    const controlPlane = fetcher(async () => Response.json({
      version: 1,
      kind: "maintenance.targets",
      result: { userIds: ["u1", "u2"], nextCursor: "u2" },
    }));
    const fanout = message("fanout", task("maintenance.fanout", "fanout-1", { cursor: null }));
    await handleBackgroundQueue(batch([fanout]), bindings({
      CONTROL_PLANE: controlPlane,
      BACKGROUND_TASKS: queue(sent),
    }));
    expect(fanout.action).toBe("ack");
    expect(sent.map((entry: any) => entry.kind)).toEqual([
      "snapshot.reconcile", "media.retention", "environment.retention",
      "snapshot.reconcile", "media.retention", "environment.retention",
      "maintenance.fanout",
    ]);
  });

  it("chunks a full maintenance page into Queue-compatible batches", async () => {
    const batchSizes: number[] = [];
    const sent: unknown[] = [];
    const userIds = Array.from({ length: 100 }, (_, index) => `user_${index}`);
    const controlPlane = fetcher(async () => Response.json({
      version: 1,
      kind: "maintenance.targets",
      result: { userIds, nextCursor: "user_99" },
    }));
    const backgroundQueue = {
      async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
        const page = [...messages];
        batchSizes.push(page.length);
        for (const message of page) sent.push(message.body);
        return { outcome: "ok" } as unknown as QueueSendBatchResponse;
      },
    } as unknown as Queue<unknown>;
    const fanout = message("fanout-full", task("maintenance.fanout", "fanout-full", { cursor: null }));

    await handleBackgroundQueue(batch([fanout]), bindings({
      CONTROL_PLANE: controlPlane,
      BACKGROUND_TASKS: backgroundQueue,
    }));

    expect(fanout.action).toBe("ack");
    expect(batchSizes).toEqual([100, 100, 100, 1]);
    expect(sent.filter((entry: any) => entry.kind === "snapshot.reconcile")).toHaveLength(100);
    expect(sent.filter((entry: any) => entry.kind === "media.retention")).toHaveLength(100);
    expect(sent.filter((entry: any) => entry.kind === "environment.retention")).toHaveLength(100);
    expect((sent.at(-1) as any).kind).toBe("maintenance.fanout");
  });

  it("emits aggregate Queue lag, quarantine, and rollout signals without work content", async () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const quarantined: unknown[] = [];
    const privateValue = "private rollout operator note";
    const rollout = message(
      "private-broker-id",
      task("rollout.reconcile", "private-task-id", { note: privateValue }),
      6,
      Date.now() - 70_000,
    );
    await handleBackgroundQueue(batch([rollout], "agent-controller-background-staging"), bindings({
      CONTROL_PLANE: fetcher(async () => Response.json({ error: privateValue, retryable: false }, { status: 400 })),
      BACKGROUND_QUARANTINE: queue(quarantined),
      TELEMETRY: analytics(points),
    }));

    expect(rollout.action).toBe("ack");
    expect(points.map((point) => point.blobs[3])).toEqual(expect.arrayContaining([
      "queue_quarantine", "rollout_event", "queue_batch",
    ]));
    const serialized = JSON.stringify(points);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("private-task-id");
    expect(serialized).not.toContain("private-broker-id");
    expect(points.find((point) => point.blobs[3] === "queue_batch")?.blobs[8]).toBe("1m_5m");
  });

});

function connectorEvent(occurredAt: number, kind: string) {
  return { eventVersion: 1, environmentId: "env_1", connectorId: "ctr_1", connectionId: "conn_1", occurredAt, kind, body: {} };
}

function task(kind: string, taskId: string, payload: Record<string, unknown>) {
  return { version: 1, kind, taskId, payload };
}

function message(id: string, body: unknown, attempts = 1, timestamp = Date.now()) {
  return {
    id, body, timestamp: new Date(timestamp), attempts, action: "none",
    ack() { this.action = "ack"; },
    retry() { this.action = "retry"; },
  };
}

function batch(messages: ReturnType<typeof message>[], queueName = "test"): MessageBatch<unknown> {
  return { queue: queueName, messages, ackAll() {}, retryAll() {}, metadata: {} } as unknown as MessageBatch<unknown>;
}

function bindings(overrides: Partial<RuntimeBindings>): RuntimeBindings {
  return { DEPLOYMENT_ENVIRONMENT: "production", CONNECTOR_AUTH_MODE: "control-plane", CONNECTOR_TICKET_AUDIENCE: "agent-controller-connectors", ...overrides } as RuntimeBindings;
}

function fetcher(handler: (request: Request) => Promise<Response>): Fetcher {
  return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => await handler(input instanceof Request ? input : new Request(input, init)), connect() { throw new Error("unsupported"); } };
}

function queue(sent: unknown[]): Queue<any> {
  return {
    async send(body: unknown) { sent.push(body); },
    async sendBatch(messages: Iterable<MessageSendRequest<any>>) {
      for (const message of messages) sent.push(message.body);
      return { outcome: "ok" } as unknown as QueueSendBatchResponse;
    },
  } as unknown as Queue<any>;
}

function analytics(points: unknown[]): AnalyticsEngineDataset {
  return { writeDataPoint(point: unknown) { points.push(point); } } as AnalyticsEngineDataset;
}
