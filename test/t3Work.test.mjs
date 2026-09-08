import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildT3WorkSummary, T3_WORK_SUMMARY_TASK_LIMIT } from "../src/t3Work.mjs";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/t3-work-activities-contract.json", import.meta.url),
  "utf8",
));

test("builds the compact device summary from T3's verified task activity fields", () => {
  const summary = buildT3WorkSummary(fixture.activities);
  assert.deepEqual(summary, {
    version: 1,
    source: "t3-task-activities",
    total: 3,
    active: 1,
    queued: 0,
    working: 0,
    waiting: 1,
    completed: 1,
    failed: 1,
    stopped: 0,
    backgroundLiveness: "monitoring",
    truncated: false,
    omitted: 0,
  });
  assert.doesNotMatch(JSON.stringify(summary), /Repository audit|Provider process exited|agent_parent/u);
});

test("usage-only progress cannot resurrect a completed task", () => {
  const summary = buildT3WorkSummary([
    {
      kind: "task.completed",
      payload: { taskId: "task_1", status: "completed", agentKind: "agent" },
    },
    {
      kind: "task.progress",
      payload: {
        taskId: "task_1",
        usageSnapshot: true,
        typedUsage: { totalTokens: 500 },
        agentKind: "agent",
      },
    },
  ]);
  assert.equal(summary.active, 0);
  assert.equal(summary.completed, 1);
  assert.equal(summary.backgroundLiveness, null);
});

test("idle remains visible as waiting but follows T3's rule that idle is not live", () => {
  const summary = buildT3WorkSummary([{
    kind: "task.updated",
    payload: { taskId: "task_idle", status: "idle", agentKind: "agent" },
  }]);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.active, 0);
  assert.equal(summary.backgroundLiveness, null);
});

test("bounds the aggregate while retaining active work ahead of old terminal tasks", () => {
  const activities = [];
  for (let index = 0; index < T3_WORK_SUMMARY_TASK_LIMIT + 6; index += 1) {
    activities.push({
      kind: "task.started",
      payload: { taskId: `task_${index}`, agentKind: "agent" },
    });
    if (index < 6) {
      activities.push({
        kind: "task.completed",
        payload: { taskId: `task_${index}`, status: "completed", agentKind: "agent" },
      });
    }
  }
  const summary = buildT3WorkSummary(activities);
  assert.equal(summary.total, T3_WORK_SUMMARY_TASK_LIMIT);
  assert.equal(summary.active, T3_WORK_SUMMARY_TASK_LIMIT);
  assert.equal(summary.completed, 0);
  assert.equal(summary.truncated, true);
  assert.equal(summary.omitted, 6);
});

test("ignores prose that mentions agents when no task lifecycle contract is present", () => {
  const summary = buildT3WorkSummary([{
    kind: "tool.started",
    summary: "Spawned three parallel agents",
    payload: { title: "delegate" },
  }]);
  assert.equal(summary.total, 0);
  assert.equal(summary.backgroundLiveness, null);
});
