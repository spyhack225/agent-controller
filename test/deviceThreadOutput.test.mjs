import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDeviceFollowUpInstruction,
  buildDeviceFollowUpInstruction,
  buildDeviceThreadOutput,
  extractFollowUpIds,
  stripFollowUpMarkers,
  wrapResponseText,
} from "../src/deviceThreadOutput.mjs";

const controls = [
  { actionId: "action_continue", label: "Continue task", kind: "remote_action", enabled: true, requiresConfirmation: true },
  { actionId: "action_test", label: "Run tests", kind: "remote_action", enabled: true, requiresConfirmation: true },
  { actionId: "action_locked", label: "Locked", kind: "remote_action", enabled: false },
  { actionId: "system_stop", label: "Stop", kind: "stop", enabled: true },
];

test("device follow-up instructions expose only eligible opaque action ids", () => {
  const instruction = buildDeviceFollowUpInstruction(controls, "action_continue");
  assert.match(instruction, /action_test/u);
  assert.doesNotMatch(instruction, /action_continue/u);
  assert.doesNotMatch(instruction, /action_locked|system_stop/u);
  assert.match(appendDeviceFollowUpInstruction("Run it", instruction), /^Run it\n\n<!--/u);
});

test("response output pages text and validates at most two suggested assigned actions", () => {
  const thread = {
    id: "thread_1",
    title: "Device work",
    messages: [{
      id: "message_1",
      role: "assistant",
      createdAt: "2026-08-08T20:00:00.000Z",
      text: "Implemented the response reader and verified the firmware build. More details follow here.\n<!--AC_FOLLOWUPS:[\"action_test\",\"invented\",\"action_continue\",\"action_test\"]-->",
    }],
  };
  const output = buildDeviceThreadOutput({ thread, controls, page: 1 });
  assert.equal(output.response.messageId, "message_1");
  assert.equal(output.response.page, 1);
  assert.ok(output.response.lines.every((line) => line.length <= 31));
  assert.deepEqual(output.suggestions.map((action) => action.actionId), ["action_test", "action_continue"]);
  assert.doesNotMatch(output.response.lines.join(" "), /AC_FOLLOWUPS/u);
});

test("waiting output never reuses an assistant response older than the dispatched action", () => {
  const output = buildDeviceThreadOutput({
    thread: {
      id: "thread_1",
      session: { status: "running" },
      messages: [{ role: "assistant", text: "Stale", createdAt: "2026-08-08T19:00:00.000Z" }],
    },
    controls,
    after: "2026-08-08T20:00:00.000Z",
  });
  assert.equal(output.response.state, "waiting");
  assert.equal(output.response.messageId, null);
  assert.match(output.response.lines[0], /Waiting/u);
});

test("malformed and untrusted follow-up markers fail closed", () => {
  assert.deepEqual(extractFollowUpIds('Done <!--AC_FOLLOWUPS:not-json-->'), []);
  assert.deepEqual(extractFollowUpIds('Done <!--AC_FOLLOWUPS:["a"]-->'), ["a"]);
  assert.equal(stripFollowUpMarkers('Done <!--AC_FOLLOWUPS:["a"]-->'), "Done");
  assert.deepEqual(wrapResponseText("abcdefghijklmnopqrstuvwxyz0123456789", 12), ["abcdefghijkl", "mnopqrstuvwx", "yz0123456789"]);
});
