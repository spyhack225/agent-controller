import { createHash } from "node:crypto";

export const NOTIFICATION_KINDS = Object.freeze([
  "turn.completed",
  "turn.failed",
  "gateway.approval_required",
  "provider.approval_required",
  "user_input.required",
  "connector.offline",
  "connector.recovered",
  "t3.offline",
  "t3.recovered",
]);

const KIND_DETAILS = Object.freeze({
  "turn.completed": { severity: "info", title: "Agent turn completed" },
  "turn.failed": { severity: "error", title: "Agent turn failed" },
  "gateway.approval_required": { severity: "attention", title: "Command approval required" },
  "provider.approval_required": { severity: "attention", title: "Provider approval required" },
  "user_input.required": { severity: "attention", title: "Agent needs an answer" },
  "connector.offline": { severity: "error", title: "Connector went offline" },
  "connector.recovered": { severity: "info", title: "Connector recovered" },
  "t3.offline": { severity: "error", title: "T3 became unavailable" },
  "t3.recovered": { severity: "info", title: "T3 recovered" },
});

const TURN_INTENTS = new Set(["agent_prompt", "media_prompt", "shell_input"]);

/**
 * Converts meaningful state transitions into privacy-minimal durable records. Notification text is
 * deliberately static: prompts, provider details, paths, approval text and question ids are user
 * content and have no place in an inbox row or SSE frame.
 */
export function createNotificationPublisher({ store, events = null, now = () => Date.now() } = {}) {
  if (!store) throw new Error("A Store is required for notifications.");

  async function publish(input) {
    const details = KIND_DETAILS[input?.kind];
    if (!details) return null;
    const result = await store.createNotification({
      userId: input.userId,
      dedupeKey: opaqueDedupeKey(input.dedupe),
      kind: input.kind,
      severity: details.severity,
      title: details.title,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      commandId: input.commandId ?? null,
      occurredAt: input.occurredAt ?? new Date(now()).toISOString(),
    });
    // Queueing is idempotent and is attempted for duplicate projections too. If durable queueing
    // fails after the inbox write, replaying the same source event can repair the gap safely.
    if (result?.notification && typeof store.enqueuePushDeliveries === "function") {
      await store.enqueuePushDeliveries({ userId: input.userId, notificationId: result.notification.id });
    }
    if (result?.created) {
      events?.broadcastToUser?.(input.userId, "notification.created", notificationView(result.notification));
    }
    return result;
  }

  async function forCommand(command) {
    if (!command?.userId || !command?.id) return null;
    if (command.status === "approval_required") {
      return await publish({
        userId: command.userId,
        kind: "gateway.approval_required",
        dedupe: ["gateway-approval", command.id],
        environmentId: command.environmentId,
        threadId: command.threadId,
        commandId: command.id,
        occurredAt: command.updatedAt ?? command.createdAt,
      });
    }
    const approvalResolution = await dismissByDedupe({
      userId: command.userId,
      dedupe: ["gateway-approval", command.id],
      resolvedAt: command.updatedAt ?? new Date(now()).toISOString(),
    });
    if (!TURN_INTENTS.has(command.intent?.type) || !["completed", "failed"].includes(command.status)) {
      return approvalResolution;
    }
    const kind = command.status === "completed" ? "turn.completed" : "turn.failed";
    return await publish({
      userId: command.userId,
      kind,
      dedupe: [kind, command.id],
      environmentId: command.environmentId,
      threadId: command.threadId,
      commandId: command.id,
      occurredAt: command.updatedAt ?? command.createdAt,
    });
  }

  async function forThreadActivity({ userId, environmentId, threadId, activity }) {
    const kind = activity?.kind === "approval.requested"
      ? "provider.approval_required"
      : activity?.kind === "user-input.requested"
        ? "user_input.required"
        : null;
    const resolvedKind = activity?.kind === "approval.resolved"
      ? "provider.approval_required"
      : activity?.kind === "user-input.resolved"
        ? "user_input.required"
        : null;
    if (!kind && !resolvedKind) return null;
    // Prefer T3's request id: the resolved activity has a different activity id, but carries the
    // same request id. It is hashed before storage because a user-input request id may be the full
    // question text. Activity id remains the fallback for malformed/non-answerable records.
    const sourceKey = text(activity?.payload?.requestId) ?? text(activity?.id);
    if (!sourceKey) return null;
    if (resolvedKind) {
      return await dismissByDedupe({
        userId,
        dedupe: [resolvedKind, environmentId, threadId, sourceKey],
        resolvedAt: activity?.createdAt ?? new Date(now()).toISOString(),
      });
    }
    return await publish({
      userId,
      kind,
      dedupe: [kind, environmentId, threadId, sourceKey],
      environmentId,
      threadId,
      occurredAt: activity?.createdAt,
    });
  }

  async function forEnvironmentHealth({ userId, environment, previousStatus }) {
    const currentStatus = environment?.status;
    const wasOffline = isT3Offline(previousStatus);
    const isOffline = isT3Offline(currentStatus);
    if (wasOffline === isOffline) return null;
    const kind = isOffline ? "t3.offline" : "t3.recovered";
    const occurredAt = environment?.health?.lastCheckedAt ?? environment?.updatedAt;
    return await publish({
      userId,
      kind,
      dedupe: [kind, environment?.id, occurredAt ?? currentStatus],
      environmentId: environment?.id,
      occurredAt,
    });
  }

  async function forConnector({ userId, connector, previousStatus, eventKey = null, occurredAt = null }) {
    const currentStatus = connector?.status;
    const wasOffline = previousStatus === "offline";
    const isOffline = currentStatus === "offline";
    if (wasOffline === isOffline || !["online", "offline"].includes(currentStatus)) return null;
    const kind = isOffline ? "connector.offline" : "connector.recovered";
    return await publish({
      userId,
      kind,
      dedupe: [kind, connector?.id, eventKey ?? occurredAt ?? connector?.updatedAt],
      environmentId: connector?.environmentId,
      occurredAt: Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : connector?.updatedAt,
    });
  }

  async function dismissByDedupe({ userId, dedupe, resolvedAt }) {
    const result = await store.dismissNotificationByDedupe({
      userId,
      dedupeKey: opaqueDedupeKey(dedupe),
      resolvedAt,
    });
    if (result && !result.duplicate) {
      events?.broadcastToUser?.(userId, "notification.updated", notificationView(result.notification));
    }
    return result;
  }

  return { publish, forCommand, forThreadActivity, forEnvironmentHealth, forConnector };
}

export function notificationView(notification) {
  if (!notification) return null;
  return {
    id: notification.id,
    kind: notification.kind,
    severity: notification.severity,
    title: notification.title,
    environmentId: notification.environmentId ?? null,
    threadId: notification.threadId ?? null,
    commandId: notification.commandId ?? null,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    readAt: notification.readAt ?? null,
    dismissedAt: notification.dismissedAt ?? null,
    cursor: String(notification.sequence),
  };
}

export function buildBackgroundLiveness({ record, configured, expectedIntervalMs = 5 * 60_000, now = Date.now() }) {
  if (!configured) return backgroundView("not_configured", record, expectedIntervalMs);
  if (!record?.lastAttemptAt) return backgroundView("unknown", record, expectedIntervalMs);
  const lastSuccess = Date.parse(record.lastSuccessAt ?? "");
  const nextExpectedBy = Number.isFinite(lastSuccess)
    ? new Date(lastSuccess + expectedIntervalMs * 2).toISOString()
    : null;
  let status = record.lastFailureAt && record.lastFailureAt === record.lastAttemptAt ? "degraded" : "healthy";
  if (status === "healthy" && (!Number.isFinite(lastSuccess) || now > lastSuccess + expectedIntervalMs * 2)) {
    status = "stale";
  }
  return backgroundView(status, record, expectedIntervalMs, nextExpectedBy);
}

function backgroundView(status, record, expectedIntervalMs, nextExpectedBy = null) {
  return {
    status,
    lastAttemptAt: record?.lastAttemptAt ?? null,
    lastSuccessAt: record?.lastSuccessAt ?? null,
    lastFailureAt: record?.lastFailureAt ?? null,
    nextExpectedBy,
    failureCode: record?.failureCode ?? null,
    expectedIntervalMs,
  };
}

function opaqueDedupeKey(parts) {
  const canonical = (Array.isArray(parts) ? parts : [parts]).map((part) => String(part ?? "")).join("\u0000");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isT3Offline(status) {
  return ["unreachable", "token_expired"].includes(status);
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
