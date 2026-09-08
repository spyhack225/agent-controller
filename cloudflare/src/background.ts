import type { RuntimeBindings } from "./env";
import { isRecord, type ConnectorHubEvent } from "./protocol";
import { emitTelemetry, lagBucket, queueBucket } from "./telemetry";

const TASK_VERSION = 1 as const;
const MAX_BATCH = 100;
const MAX_SEND_BATCH = 100;
const MAX_DELIVERY_ATTEMPTS = 6;

export interface CloudBackgroundTask {
  version: typeof TASK_VERSION;
  taskId: string;
  kind: "media.process" | "media.retention" | "environment.retention" | "snapshot.reconcile" | "connector.project" | "maintenance.targets" | "maintenance.fanout" | "rollout.reconcile" | "scheduler.heartbeat" | "push.deliver";
  payload: Record<string, unknown>;
}

export interface CloudBackgroundQuarantineEnvelope {
  version: 1;
  quarantineId: string;
  messageRef: string;
  source: "background" | "connector-events";
  attempts: number;
  classification: "terminal" | "retry_exhausted" | "malformed";
  failureCode: string;
  taskKind?: CloudBackgroundTask["kind"];
  quarantinedAt: number;
}

export async function handleBackgroundQueue(batch: MessageBatch<unknown>, env: RuntimeBindings): Promise<void> {
  const messages = batch.messages.slice(0, MAX_BATCH);
  for (const deferred of batch.messages.slice(MAX_BATCH)) deferred.retry();
  const signals = { acked: 0, retried: batch.messages.length - messages.length, quarantined: 0 };
  let maximumLagMs = 0;
  for (const message of messages) {
    let parsedTask: CloudBackgroundTask | undefined;
    const lagMs = messageLagMs(message);
    maximumLagMs = Math.max(maximumLagMs, lagMs);
    try {
      parsedTask = queueTask(message.body);
      if (parsedTask.kind === "maintenance.fanout") await fanOutMaintenance(parsedTask, env);
      else await invokePrivateBackground(parsedTask, env);
      message.ack();
      signals.acked += 1;
      if (parsedTask.kind === "rollout.reconcile") {
        emitTelemetry(env, {
          kind: "rollout_event", operation: "reconcile", outcome: "success",
          bucket: lagBucket(lagMs), lagMs, attempts: message.attempts, force: true,
        });
      }
    } catch (error) {
      const shouldRetry = retryable(error) && message.attempts < MAX_DELIVERY_ATTEMPTS;
      if (shouldRetry) {
        message.retry();
        signals.retried += 1;
      } else {
        try {
          await quarantine(message, batch.queue, parsedTask, error, env);
          message.ack();
          signals.acked += 1;
          signals.quarantined += 1;
        } catch (quarantineError) {
          message.retry();
          signals.retried += 1;
          emitTelemetry(env, {
            kind: "queue_dlq_risk", operation: queueBucket(batch.queue), outcome: "failure",
            errorCode: safeFailureCode(quarantineError), bucket: lagBucket(lagMs), lagMs,
            attempts: message.attempts, force: true,
          });
        }
      }
      if (parsedTask?.kind === "rollout.reconcile") {
        emitTelemetry(env, {
          kind: "rollout_event", operation: "reconcile", outcome: shouldRetry ? "degraded" : "failure",
          errorCode: safeFailureCode(error), bucket: lagBucket(lagMs), lagMs,
          attempts: message.attempts, force: true,
        });
      }
    }
  }
  emitTelemetry(env, {
    kind: "queue_batch",
    operation: queueBucket(batch.queue),
    outcome: signals.quarantined > 0 ? "failure" : signals.retried > 0 ? "degraded" : "success",
    bucket: lagBucket(maximumLagMs),
    count: batch.messages.length,
    attempts: signals.retried,
    lagMs: maximumLagMs,
    force: signals.retried > 0 || signals.quarantined > 0,
  });
}

export async function handleBackgroundScheduled(controller: ScheduledController, env: RuntimeBindings): Promise<void> {
  if (!env.BACKGROUND_TASKS) throw new Error("BACKGROUND_TASKS queue binding is required for scheduled work.");
  const suffix = `${controller.scheduledTime}`;
  await env.BACKGROUND_TASKS.sendBatch([
    { body: task("scheduler.heartbeat", `cron:${suffix}:heartbeat`, { scheduledAt: controller.scheduledTime }) },
    { body: task("rollout.reconcile", `cron:${suffix}:rollouts`, {}) },
    { body: task("media.process", `cron:${suffix}:media`, {}) },
    { body: task("push.deliver", `cron:${suffix}:push`, {}) },
    { body: task("maintenance.fanout", `cron:${suffix}:fanout`, { cursor: null }) },
  ]);
  emitTelemetry(env, {
    kind: "queue_schedule", operation: "cron_fanout", outcome: "success",
    count: 5, lagMs: Math.max(0, Date.now() - controller.scheduledTime), force: true,
  });
}

export async function invokePrivateBackground(taskInput: CloudBackgroundTask, env: RuntimeBindings): Promise<unknown> {
  if (!env.CONTROL_PLANE) throw transient("control_plane_unavailable");
  const response = await env.CONTROL_PLANE.fetch(new Request("https://control-plane.internal/v1/internal/background/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(taskInput),
  }));
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body;
  const code = isRecord(body) && typeof body.error === "string" ? body.error : "background_task_failed";
  const isRetryable = response.status === 429 || response.status >= 500
    || (isRecord(body) && body.retryable === true);
  throw Object.assign(new Error(code), { code, retryable: isRetryable });
}

async function fanOutMaintenance(fanout: CloudBackgroundTask, env: RuntimeBindings): Promise<void> {
  if (!env.BACKGROUND_TASKS) throw transient("background_queue_unavailable");
  const target = task("maintenance.targets", `${fanout.taskId}:targets`, {
    cursor: typeof fanout.payload.cursor === "string" ? fanout.payload.cursor : null,
  });
  const response = await invokePrivateBackground(target, env);
  const result = isRecord(response) && isRecord(response.result) ? response.result : null;
  if (!result || !Array.isArray(result.userIds) || !result.userIds.every((value) => typeof value === "string")) {
    throw transient("background_targets_invalid");
  }
  const messages: MessageSendRequest<CloudBackgroundTask>[] = [];
  for (const userId of result.userIds.slice(0, 100)) {
    messages.push({ body: task("snapshot.reconcile", `${fanout.taskId}:snapshot:${userId}`, { userId }) });
    messages.push({ body: task("media.retention", `${fanout.taskId}:media-retention:${userId}`, { userId }) });
    messages.push({ body: task("environment.retention", `${fanout.taskId}:environment-retention:${userId}`, { userId }) });
  }
  if (typeof result.nextCursor === "string" && result.nextCursor) {
    messages.push({ body: task("maintenance.fanout", `${fanout.taskId}:next:${result.nextCursor}`, { cursor: result.nextCursor }) });
  }
  for (let index = 0; index < messages.length; index += MAX_SEND_BATCH) {
    await env.BACKGROUND_TASKS.sendBatch(messages.slice(index, index + MAX_SEND_BATCH));
  }
}

function queueTask(value: unknown): CloudBackgroundTask {
  if (isConnectorEvent(value)) {
    return task("connector.project", `connector:${value.connectionId}:${value.occurredAt}:${value.kind}`, { event: value });
  }
  if (!isRecord(value)
    || value.version !== TASK_VERSION
    || typeof value.taskId !== "string"
    || typeof value.kind !== "string"
    || !isRecord(value.payload)) {
    throw terminal("background_task_invalid");
  }
  return value as unknown as CloudBackgroundTask;
}

function isConnectorEvent(value: unknown): value is ConnectorHubEvent {
  return isRecord(value)
    && value.eventVersion === 1
    && typeof value.environmentId === "string"
    && typeof value.connectorId === "string"
    && typeof value.connectionId === "string"
    && typeof value.occurredAt === "number"
    && typeof value.kind === "string";
}

function task(kind: CloudBackgroundTask["kind"], taskId: string, payload: Record<string, unknown>): CloudBackgroundTask {
  return { version: TASK_VERSION, kind, taskId: taskId.slice(0, 128), payload };
}

function retryable(error: unknown): boolean {
  return !isRecord(error) || error.retryable !== false;
}

function transient(code: string): Error {
  return Object.assign(new Error(code), { code, retryable: true });
}

function terminal(code: string): Error {
  return Object.assign(new Error(code), { code, retryable: false });
}

async function quarantine(
  message: Message<unknown>,
  queueName: string,
  parsedTask: CloudBackgroundTask | undefined,
  error: unknown,
  env: RuntimeBindings,
): Promise<void> {
  if (!env.BACKGROUND_QUARANTINE) throw transient("background_quarantine_unavailable");
  const isMalformed = !parsedTask;
  const classification = isMalformed
    ? "malformed"
    : retryable(error) ? "retry_exhausted" : "terminal";
  const envelope: CloudBackgroundQuarantineEnvelope = {
    version: 1,
    quarantineId: crypto.randomUUID(),
    messageRef: await opaqueMessageRef(queueName, message.id),
    source: queueName.includes("connector-events") ? "connector-events" : "background",
    attempts: Math.max(1, Math.trunc(message.attempts)),
    classification,
    failureCode: safeFailureCode(error),
    ...(parsedTask ? { taskKind: parsedTask.kind } : {}),
    quarantinedAt: Date.now(),
  };
  await env.BACKGROUND_QUARANTINE.send(envelope);
  emitTelemetry(env, {
    kind: "queue_quarantine",
    operation: queueBucket(envelope.source),
    outcome: "failure",
    errorCode: envelope.failureCode,
    bucket: envelope.classification,
    attempts: envelope.attempts,
    force: true,
  });
}

function messageLagMs(message: Message<unknown>): number {
  const observed = message.timestamp instanceof Date ? message.timestamp.getTime() : Date.parse(String(message.timestamp));
  return Number.isFinite(observed) ? Math.max(0, Date.now() - observed) : 0;
}

async function opaqueMessageRef(queueName: string, messageId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${queueName}\0${messageId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 12)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeFailureCode(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "background_task_failed";
  return /^[a-z][a-z0-9_.:-]{0,63}$/.test(code) ? code : "background_task_failed";
}
