import { expect, test } from "vitest";

import fixture from "../../test/fixtures/t3-work-activities-contract.json";
import {
  WORK_NODE_ACTIVITY_LIMIT,
  WORK_NODE_LIMIT,
  collectWorkProjection,
  createWorkProjection,
  foldWorkActivity,
  workBackgroundLiveness,
  workOwnerIdForActivity,
} from "./workGraph";

test("folds T3's verified task linkage into an evidence-backed tree", () => {
  const projection = collectWorkProjection(fixture.activities);
  const parent = projection.nodes.find((node) => node.id === "agent_parent");
  const child = projection.nodes.find((node) => node.id === "agent_child");
  const monitor = projection.nodes.find((node) => node.id === "monitor_1");

  expect(projection.relationshipMode).toBe("tree");
  expect(parent).toMatchObject({
    kind: "agent",
    turnId: "turn_1",
    label: "Repository audit",
    status: "failed",
    failure: "Provider process exited",
    role: "reviewer",
    model: "gpt-5.6",
  });
  expect(parent?.usage).toMatchObject({ totalTokens: 1200, toolUses: 4 });
  expect(child).toMatchObject({
    parentId: "agent_parent",
    parentSource: "parentAgentId",
    status: "completed",
  });
  expect(child?.activities.some((activity) => activity.kind === "tool.started")).toBe(true);
  expect(monitor).toMatchObject({ kind: "background", status: "waiting" });
  expect(projection.summary).toMatchObject({ total: 3, active: 1, completed: 1, failed: 1 });
  expect(workBackgroundLiveness(projection)).toBe("monitoring");
});

test("stable progress ids update the latest row instead of growing a duplicate timeline", () => {
  const start = fixture.activities[0];
  const firstProgress = fixture.activities[2];
  let projection = foldWorkActivity(createWorkProjection(), start);
  projection = foldWorkActivity(projection, firstProgress);
  projection = foldWorkActivity(projection, {
    ...firstProgress,
    createdAt: "2026-08-27T12:00:09.000Z",
    payload: {
      ...firstProgress.payload,
      summary: "Reviewing the final report",
      lastToolName: "Write",
      typedUsage: { totalTokens: 1600, toolUses: 6 },
    },
  });

  const node = projection.nodes[0];
  expect(node.activities.filter((activity) => activity.id === firstProgress.id)).toHaveLength(1);
  expect(node.summary).toBe("Reviewing the final report");
  expect(node.currentTool).toBe("Write");
  expect(node.usage).toMatchObject({ totalTokens: 1600, toolUses: 6 });
});

test("does not invent an agent or parent relationship from prose", () => {
  const projection = foldWorkActivity(createWorkProjection(), {
    id: "evt_legacy",
    kind: "task.started",
    tone: "info",
    summary: "Started a subagent for the frontend in parallel",
    payload: { taskId: "legacy_1", detail: "Ask another agent to help" },
    createdAt: "2026-08-27T12:00:00.000Z",
  });

  expect(projection.relationshipMode).toBe("roster");
  expect(projection.nodes[0]).toMatchObject({ kind: "task", parentId: null });
});

test("shows an idle resumable task as waiting without claiming it is live", () => {
  const projection = foldWorkActivity(createWorkProjection(), {
    id: "evt_idle",
    kind: "task.updated",
    tone: "info",
    summary: "Task idle",
    payload: { taskId: "agent_idle", agentKind: "agent", status: "idle", title: "Research" },
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  expect(projection.nodes[0]).toMatchObject({ status: "waiting", runtimeStatus: "idle" });
  expect(projection.summary.waiting).toBe(1);
  expect(projection.summary.active).toBe(0);
  expect(workBackgroundLiveness(projection)).toBeNull();
});

test("attributes tools only through T3's taskId/agentId fields", () => {
  expect(workOwnerIdForActivity(fixture.activities[3])).toBe("agent_child");
  expect(workOwnerIdForActivity({
    id: "denied_child_tool",
    kind: "tool.denied",
    tone: "error",
    summary: "Tool denied: Shell",
    payload: { agentId: "agent_child", toolName: "Shell" },
  })).toBe("agent_child");
  expect(workOwnerIdForActivity({
    id: "tool_without_link",
    kind: "tool.started",
    summary: "Agent helper started",
    payload: { itemType: "mcp_tool_call" },
  })).toBeNull();

  const unchanged = foldWorkActivity(createWorkProjection(), {
    id: "orphan_tool",
    kind: "tool.started",
    summary: "Read started",
    payload: { agentId: "missing_agent" },
  });
  expect(unchanged.nodes).toHaveLength(0);

  const child = fixture.activities.find((activity) => activity.payload.taskId === "agent_child");
  let projection = foldWorkActivity(createWorkProjection(), child);
  projection = foldWorkActivity(projection, {
    id: "denied_child_tool",
    kind: "tool.denied",
    tone: "error",
    summary: "Tool denied: Shell",
    payload: { agentId: "agent_child", toolName: "Shell" },
  });
  expect(projection.nodes[0].currentTool).toBeNull();
  expect(projection.nodes[0].activities.at(-1)).toMatchObject({
    kind: "tool.denied",
    tone: "error",
  });
});

test("bounds retained nodes and per-node activity while preferring live work", () => {
  let projection = createWorkProjection();
  for (let index = 0; index < WORK_NODE_LIMIT + 9; index += 1) {
    projection = foldWorkActivity(projection, {
      id: `start_${index}`,
      kind: "task.started",
      tone: "info",
      summary: "Task started",
      payload: { taskId: `task_${index}`, agentKind: "agent", title: `Task ${index}` },
      createdAt: new Date(Date.UTC(2026, 7, 27, 12, 0, index)).toISOString(),
    });
    if (index < 9) {
      projection = foldWorkActivity(projection, {
        id: `done_${index}`,
        kind: "task.completed",
        tone: "info",
        summary: "Task completed",
        payload: { taskId: `task_${index}`, agentKind: "agent", status: "completed" },
        createdAt: new Date(Date.UTC(2026, 7, 27, 12, 1, index)).toISOString(),
      });
    }
  }

  expect(projection.nodes).toHaveLength(WORK_NODE_LIMIT);
  expect(projection.nodes.every((node) => node.status === "working")).toBe(true);
  expect(projection.truncated).toBe(true);
  expect(projection.omittedNodes).toBe(9);

  const taskId = projection.nodes[0].id;
  for (let index = 0; index < WORK_NODE_ACTIVITY_LIMIT + 5; index += 1) {
    projection = foldWorkActivity(projection, {
      id: `tool_${index}`,
      kind: "tool.started",
      tone: "tool",
      summary: `Tool ${index}`,
      payload: { agentId: taskId },
      createdAt: new Date(Date.UTC(2026, 7, 27, 13, 0, index)).toISOString(),
    });
  }
  const updated = projection.nodes.find((node) => node.id === taskId);
  expect(updated?.activities).toHaveLength(WORK_NODE_ACTIVITY_LIMIT);
  expect(updated?.activitiesTruncated).toBe(true);
  expect(updated?.activities.at(-1)?.id).toBe(`tool_${WORK_NODE_ACTIVITY_LIMIT + 4}`);
});
