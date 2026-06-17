import assert from "node:assert/strict";
import test from "node:test";

import { evaluateIntentPolicy } from "../src/policy.mjs";
import { listDeviceProfiles } from "../src/profiles.mjs";

test("agent-controller devices can send prompts", () => {
  const result = evaluateIntentPolicy({
    device: { profile: "agent-controller" },
    intent: { type: "agent_prompt", text: "Run tests" },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.risk, "low");
});

test("agent-controller devices can send policy-screened shell input", () => {
  const result = evaluateIntentPolicy({
    device: { profile: "agent-controller" },
    intent: { type: "shell_input", command: "npm test" },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.risk, "medium");
});

test("power-controller devices still block dangerous shell input", () => {
  const result = evaluateIntentPolicy({
    device: { profile: "power-controller" },
    intent: { type: "shell_input", command: "rm -rf /" },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.risk, "high");
});

test("read-only devices can inspect status but cannot prompt agents", () => {
  const status = evaluateIntentPolicy({
    device: { profile: "read-only" },
    intent: { type: "status" },
  });
  assert.equal(status.allowed, true);
  assert.equal(status.risk, "low");

  const prompt = evaluateIntentPolicy({
    device: { profile: "read-only" },
    intent: { type: "agent_prompt", text: "Run tests" },
  });
  assert.equal(prompt.allowed, false);
  assert.equal(prompt.risk, "blocked");
});

test("device profiles expose stable capability metadata", () => {
  const profiles = listDeviceProfiles();
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["agent-controller", "read-only", "power-controller"],
  );
  assert.ok(profiles.find((profile) => profile.id === "agent-controller").capabilities.includes("shell_input"));
  assert.deepEqual(profiles.find((profile) => profile.id === "read-only").capabilities, ["status"]);
});
