import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT3Command,
  buildT3ProjectLaunchCommands,
  compressSnapshot,
  pendingThreadInteractions,
} from "../src/t3Client.mjs";

test("agent prompts map to T3 turn start commands with approval-required runtime", () => {
  const command = buildT3Command({
    threadId: "thread_123",
    intent: { type: "agent_prompt", text: "Continue the implementation." },
  });

  assert.equal(command.type, "thread.turn.start");
  assert.equal(command.threadId, "thread_123");
  assert.equal(command.runtimeMode, "approval-required");
  assert.equal(command.interactionMode, "default");
  assert.equal(command.message.text, "Continue the implementation.");
});

test("approval responses map to T3 approval commands", () => {
  const command = buildT3Command({
    threadId: "thread_123",
    intent: { type: "approval_response", requestId: "approval_1", decision: "approve" },
  });

  assert.equal(command.type, "thread.approval.respond");
  assert.equal(command.requestId, "approval_1");
  assert.equal(command.decision, "accept");
});

test("selected thread status preserves T3 session and pending interaction state", () => {
  const thread = {
    id: "thread_123",
    title: "Implement the device session controls with a very long title",
    interactionMode: "default",
    latestTurn: { state: "running" },
    session: { status: "running", runtimeMode: "approval-required" },
    activities: [
      { sequence: 1, kind: "approval.requested", payload: { requestId: "approval_1" } },
      { sequence: 2, kind: "user-input.requested", payload: { requestId: "input_1" } },
      { sequence: 3, kind: "user-input.resolved", payload: { requestId: "input_1" } },
    ],
  };
  assert.deepEqual(pendingThreadInteractions(thread), { approvals: 1, userInput: 0 });
  const screen = compressSnapshot({ projects: [{}], threads: [thread] }, thread.id);
  assert.equal(screen.state, "running");
  assert.equal(screen.line2, "1 approval waiting");
  assert.equal(screen.thread.id, thread.id);
  assert.equal(screen.thread.pendingApprovals, 1);
  assert.ok(screen.line1.length <= 28);
});

test("project launch builds a T3 bootstrap turn using the selected harness", () => {
  const launch = buildT3ProjectLaunchCommands({
    project: {
      id: "project_123",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
    },
    text: "Inspect this project and report its current state.",
    threadId: "thread_123",
  });

  assert.equal(launch.createThread.type, "thread.create");
  assert.equal(launch.startTurn.type, "thread.turn.start");
  assert.equal(launch.threadId, "thread_123");
  assert.deepEqual(launch.startTurn.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
  });
  assert.equal(launch.createThread.projectId, "project_123");
  assert.equal(launch.createThread.runtimeMode, "approval-required");
  assert.equal(launch.startTurn.message.text, "Inspect this project and report its current state.");
});
