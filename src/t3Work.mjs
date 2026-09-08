/**
 * Compact, content-free summary of T3's native task lifecycle for constrained clients.
 *
 * The web console owns the full inspectable projection. This server helper intentionally keeps
 * only task ids/statuses while folding, then returns counts — no prompt, task title, role, path,
 * model output, error, or provider payload crosses into the device projection.
 */

export const T3_WORK_SUMMARY_TASK_LIMIT = 64;

const TASK_KINDS = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
]);

const ACTIVE = new Set(["queued", "working", "waiting"]);

export function buildT3WorkSummary(activities) {
  const tasks = new Map();
  let truncated = false;
  let omitted = 0;

  for (const activity of Array.isArray(activities) ? activities : []) {
    const kind = stringOrNull(activity?.kind);
    const payload = recordOrNull(activity?.payload);
    const taskId = stringOrNull(payload?.taskId);
    if (!kind || !TASK_KINDS.has(kind) || !taskId) continue;

    const existing = tasks.get(taskId) ?? null;
    // T3 emits typed-usage snapshots under a second stable task.progress row. They update usage,
    // not lifecycle, and must not resurrect a completed task as working.
    const usageOnly = kind === "task.progress" && payload.usageSnapshot === true;
    const status = usageOnly && existing
      ? existing.status
      : statusFor(kind, stringOrNull(payload.status), existing?.status ?? null);
    const agentKind = stringOrNull(payload.agentKind);
    tasks.set(taskId, {
      status,
      runtimeStatus: usageOnly
        ? existing?.runtimeStatus ?? null
        : stringOrNull(payload.status) ?? existing?.runtimeStatus ?? null,
      kind: agentKind === "agent" || agentKind === "background"
        ? agentKind
        : existing?.kind ?? "task",
      order: existing?.order ?? tasks.size,
    });

    if (tasks.size > T3_WORK_SUMMARY_TASK_LIMIT) {
      const victim = evictionKey(tasks);
      tasks.delete(victim);
      truncated = true;
      omitted += 1;
    }
  }

  const rows = [...tasks.values()];
  const count = (status) => rows.filter((row) => row.status === status).length;
  const queued = count("queued");
  const working = count("working");
  const waiting = count("waiting");
  const activeRows = rows.filter(isLive);
  const active = activeRows.length;
  const backgroundLiveness = activeRows.length === 0
    ? null
    : activeRows.some((row) => row.kind !== "background") ? "working" : "monitoring";

  return {
    version: 1,
    source: "t3-task-activities",
    total: rows.length,
    active,
    queued,
    working,
    waiting,
    completed: count("completed"),
    failed: count("failed"),
    stopped: count("stopped"),
    backgroundLiveness,
    truncated,
    omitted,
  };
}

function statusFor(kind, rawStatus, previous) {
  if (kind === "task.completed") {
    if (rawStatus === "failed") return "failed";
    if (rawStatus === "stopped") return "stopped";
    return "completed";
  }
  switch (rawStatus) {
    case "pending": return "queued";
    case "running": return "working";
    case "waiting":
    case "idle": return "waiting";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled":
    case "interrupted":
    case "stopped": return "stopped";
    default: return previous ?? "working";
  }
}

function evictionKey(tasks) {
  let victimKey = null;
  let victim = null;
  for (const [key, row] of tasks) {
    if (!victim) {
      victimKey = key;
      victim = row;
      continue;
    }
    const victimActive = isLive(victim);
    const rowActive = isLive(row);
    if (victimActive !== rowActive) {
      if (!rowActive) {
        victimKey = key;
        victim = row;
      }
      continue;
    }
    if (row.order < victim.order) {
      victimKey = key;
      victim = row;
    }
  }
  return victimKey;
}

function isLive(row) {
  // T3's ThreadBackgroundLiveness service explicitly treats an idle resumable child as not live.
  return ACTIVE.has(row.status) && row.runtimeStatus !== "idle";
}

function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
