import assert from "node:assert/strict";
import test from "node:test";

import { buildT3Command } from "../src/t3Client.mjs";

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
