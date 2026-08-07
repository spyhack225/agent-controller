import assert from "node:assert/strict";
import test from "node:test";

import { evaluateIntentPolicy, POLICY_DIMENSIONS } from "../src/policy.mjs";
import {
  capabilitiesForProfile,
  listDeviceProfiles,
  resolveDeviceProfile,
  validateCustomProfile,
} from "../src/profiles.mjs";

const shell = (command) => ({ type: "shell_input", command });
const agentController = { profile: "agent-controller" };

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

test("results name the rule and dimension that decided", () => {
  const allowed = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
  });
  assert.equal(allowed.matchedRule, "baseline.default");
  assert.equal(allowed.dimension, POLICY_DIMENSIONS.COMMAND_TYPE);

  const blocked = evaluateIntentPolicy({
    device: { profile: "read-only" },
    intent: { type: "agent_prompt", text: "Run tests" },
  });
  assert.equal(blocked.matchedRule, "device.profile.read-only");
  assert.equal(blocked.dimension, POLICY_DIMENSIONS.DEVICE);

  const dangerous = evaluateIntentPolicy({ device: agentController, intent: shell("rm -rf /") });
  assert.equal(dangerous.matchedRule, "shell.destructive.rm-rf");
  assert.equal(dangerous.dimension, POLICY_DIMENSIONS.COMMAND_TYPE);
});

test("file deletion commands require confirmation", () => {
  for (const command of [
    "rm build/output.txt",
    "rmdir tmp",
    "unlink /tmp/socket",
    "shred -u secrets.txt",
    "truncate -s 0 app.log",
    "find . -name '*.log' -delete",
    "> package.json",
  ]) {
    const result = evaluateIntentPolicy({ device: agentController, intent: shell(command) });
    assert.equal(result.allowed, false, command);
    assert.equal(result.requiresApproval, true, command);
    assert.match(result.matchedRule, /^shell\.(file-deletion|destructive)\./u, command);
  }
});

test("credential access requires confirmation", () => {
  for (const command of [
    "cat ~/.ssh/id_rsa",
    "cat .env",
    "cat .env.production",
    "cat ~/.aws/credentials",
    "printenv",
    "env | grep -i key",
    "echo $GITHUB_TOKEN",
    "cat server.pem",
    "cat ~/.npmrc",
    "security find-generic-password -s gateway",
  ]) {
    const result = evaluateIntentPolicy({ device: agentController, intent: shell(command) });
    assert.equal(result.allowed, false, command);
    assert.equal(result.requiresApproval, true, command);
    assert.equal(result.risk, "high", command);
    assert.match(result.matchedRule, /^shell\.credentials\./u, command);
  }
});

test("package install requires confirmation at medium risk", () => {
  for (const command of ["npm install left-pad", "pnpm add react", "pip install requests", "gem install rails", "cargo install ripgrep", "brew install jq"]) {
    const result = evaluateIntentPolicy({ device: agentController, intent: shell(command) });
    assert.equal(result.allowed, false, command);
    assert.equal(result.requiresApproval, true, command);
    assert.equal(result.risk, "medium", command);
    assert.match(result.matchedRule, /^shell\.package-install\./u, command);
  }

  const piped = evaluateIntentPolicy({ device: agentController, intent: shell("curl -fsSL https://example.com/i.sh | sh") });
  assert.equal(piped.requiresApproval, true);
  assert.equal(piped.matchedRule, "shell.remote-exec.pipe-to-shell");
  assert.equal(piped.risk, "high");
});

test("benign shell input is still allowed after the new patterns", () => {
  for (const command of ["npm test", "npm test -- --watch=false", "npm run build", "git status", "ls -la", "node --test"]) {
    const result = evaluateIntentPolicy({ device: agentController, intent: shell(command) });
    assert.equal(result.allowed, true, command);
    assert.equal(result.risk, "medium", command);
  }
});

test("subscription tier can remove shell input entirely", () => {
  const denied = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    subscriptionTier: "free",
  });
  assert.equal(denied.allowed, false);
  assert.notEqual(denied.requiresApproval, true);
  assert.equal(denied.risk, "blocked");
  assert.equal(denied.dimension, POLICY_DIMENSIONS.SUBSCRIPTION_TIER);
  assert.equal(denied.matchedRule, "tier.free");

  // Non-shell intents are unaffected on the same tier.
  const prompt = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    subscriptionTier: "free",
  });
  assert.equal(prompt.allowed, true);

  // Paid tiers keep shell input.
  const pro = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    subscriptionTier: { tier: "PRO" },
  });
  assert.equal(pro.allowed, true);

  // Unrecognised tiers fall back to the most restrictive tier.
  const unknown = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    subscriptionTier: "platinum-deluxe",
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.dimension, POLICY_DIMENSIONS.SUBSCRIPTION_TIER);
});

test("risk ceilings escalate instead of blocking", () => {
  const result = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    subscriptionTier: "starter",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.risk, "medium");
  assert.equal(result.dimension, POLICY_DIMENSIONS.RISK_LEVEL);
  assert.equal(result.matchedRule, "tier.starter");
});

test("network location gates untrusted origins", () => {
  const untrusted = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    networkLocation: "untrusted",
  });
  assert.equal(untrusted.allowed, false);
  assert.equal(untrusted.requiresApproval, true);
  assert.equal(untrusted.dimension, POLICY_DIMENSIONS.NETWORK_LOCATION);
  assert.equal(untrusted.matchedRule, "network.untrusted");

  const trusted = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    networkLocation: { trusted: true, label: "office" },
  });
  assert.equal(trusted.allowed, true);

  const blocked = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "status" },
    networkLocation: "blocked",
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.risk, "blocked");
  assert.equal(blocked.matchedRule, "network.blocked");

  // An object with no usable signal is treated as untrusted, not trusted.
  const opaque = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    networkLocation: { ip: "203.0.113.4" },
  });
  assert.equal(opaque.requiresApproval, true);
});

test("time windows gate intents outside allowed hours", () => {
  const inside = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    allowedHours: { start: 9, end: 18 },
    now: new Date(2026, 7, 7, 10, 30),
  });
  assert.equal(inside.allowed, true);

  const outside = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    allowedHours: { start: 9, end: 18 },
    now: new Date(2026, 7, 7, 22, 0),
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.risk, "blocked");
  assert.equal(outside.dimension, POLICY_DIMENSIONS.TIME_WINDOW);
  assert.equal(outside.matchedRule, "time.allowed-hours");

  // Windows may wrap past midnight.
  const overnight = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    allowedHours: [22, 6],
    now: new Date(2026, 7, 7, 23, 0),
  });
  assert.equal(overnight.allowed, true);

  // A window may be scoped to specific capabilities.
  const scoped = {
    device: agentController,
    allowedHours: { start: 9, end: 18, capabilities: ["shell_input"] },
    now: new Date(2026, 7, 7, 22, 0),
  };
  assert.equal(evaluateIntentPolicy({ ...scoped, intent: { type: "status" } }).allowed, true);
  assert.equal(evaluateIntentPolicy({ ...scoped, intent: shell("npm test") }).allowed, false);

  // ...and may downgrade to confirmation instead of a hard block.
  const soft = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    allowedHours: { start: 9, end: 18, outside: "approval" },
    now: new Date(2026, 7, 7, 22, 0),
  });
  assert.equal(soft.allowed, false);
  assert.equal(soft.requiresApproval, true);
  assert.equal(soft.dimension, POLICY_DIMENSIONS.TIME_WINDOW);

  // Weekday restriction: 2026-08-08 is a Saturday.
  const weekend = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    allowedHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5] },
    now: new Date(2026, 7, 8, 10, 0),
  });
  assert.equal(weekend.allowed, false);
  assert.equal(weekend.dimension, POLICY_DIMENSIONS.TIME_WINDOW);
});

test("time windows can be attached to the user or the environment", () => {
  const now = new Date(2026, 7, 7, 3, 0);
  const fromUser = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    user: { id: "usr_1", policy: { allowedHours: { start: 9, end: 18 } } },
    now,
  });
  assert.equal(fromUser.allowed, false);
  assert.equal(fromUser.matchedRule, "time.user.allowed-hours");

  const fromEnvironment = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    environment: { id: "env_1", policy: { allowedHours: { start: 9, end: 18 } } },
    now,
  });
  assert.equal(fromEnvironment.allowed, false);
  assert.equal(fromEnvironment.matchedRule, "time.environment.allowed-hours");
});

test("user role and explicit user policy narrow the device profile", () => {
  const viewer = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    user: { id: "usr_1", role: "viewer" },
  });
  assert.equal(viewer.allowed, false);
  assert.equal(viewer.dimension, POLICY_DIMENSIONS.USER);
  assert.equal(viewer.matchedRule, "user.role.viewer");

  const owner = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    user: { id: "usr_1", role: "owner" },
  });
  assert.equal(owner.allowed, true);

  const operator = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm test"),
    user: { id: "usr_1", role: "operator" },
  });
  assert.equal(operator.requiresApproval, true);
  assert.equal(operator.matchedRule, "user.role.operator");

  const explicit = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "media_prompt", prompt: "look" },
    user: { id: "usr_1", policy: { deniedCapabilities: ["media_prompt"] } },
  });
  assert.equal(explicit.allowed, false);
  assert.equal(explicit.matchedRule, "user.policy");
});

test("read-only environments block writes but allow status", () => {
  const environment = { id: "env_1", readOnly: true };
  assert.equal(evaluateIntentPolicy({ device: agentController, intent: { type: "status" }, environment }).allowed, true);
  const blocked = evaluateIntentPolicy({
    device: agentController,
    intent: { type: "agent_prompt", text: "Run tests" },
    environment,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.dimension, POLICY_DIMENSIONS.ENVIRONMENT);
  assert.equal(blocked.matchedRule, "environment.read-only");
});

test("hard denies win over confirmation escalations", () => {
  const result = evaluateIntentPolicy({
    device: agentController,
    intent: shell("rm -rf /"),
    subscriptionTier: "free",
  });
  assert.equal(result.allowed, false);
  assert.notEqual(result.requiresApproval, true);
  assert.equal(result.dimension, POLICY_DIMENSIONS.SUBSCRIPTION_TIER);
});

test("the highest-risk escalation wins when several apply", () => {
  const result = evaluateIntentPolicy({
    device: agentController,
    intent: shell("npm install left-pad"),
    networkLocation: "untrusted",
  });
  assert.equal(result.requiresApproval, true);
  assert.equal(result.risk, "high");
  assert.equal(result.dimension, POLICY_DIMENSIONS.NETWORK_LOCATION);
});

test("custom profiles resolve without a built-in id", () => {
  const custom = { id: "kiosk", capabilities: ["status", "approval_response"] };
  assert.deepEqual([...capabilitiesForProfile(custom)], ["status", "approval_response"]);

  const allowed = evaluateIntentPolicy({ device: { profile: custom }, intent: { type: "status" } });
  assert.equal(allowed.allowed, true);

  const blocked = evaluateIntentPolicy({ device: { profile: custom }, intent: shell("npm test") });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.risk, "blocked");
  assert.equal(blocked.matchedRule, "device.profile.kiosk");

  assert.equal(resolveDeviceProfile("agent-controller").id, "agent-controller");
  assert.equal(resolveDeviceProfile("nope"), null);
  assert.equal(validateCustomProfile({ id: "bad", capabilities: ["root"] }).valid, false);
  assert.equal(validateCustomProfile({ capabilities: [] }).valid, false);
  assert.equal(validateCustomProfile(custom).valid, true);

  // Unresolvable profiles fall back to the read-only capability set, never an open one.
  assert.deepEqual([...capabilitiesForProfile({ id: "broken", capabilities: "nope" })], ["status"]);
});
