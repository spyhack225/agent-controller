import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSnapshotPoller } from "../src/snapshotPoller.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { extractThreadOutcomes, reconcileCommandStatus } from "../src/t3Harness.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// The real snapshot: three threads, every one stopped with a provider error.
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, "t3-snapshot.json"), "utf8"));

const DISPATCHED_AT = "2026-07-24T19:00:00.000Z";

// A successful thread, shaped from real T3 state: turn state "completed", an assistant message,
// session stopped with no lastError.
function succeededThread(threadId = "thread_ok", repliedAt = "2026-07-24T19:10:00.000Z") {
  return {
    id: threadId,
    title: "Working thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    messages: [
      { id: "m1", role: "user", text: "do it", createdAt: DISPATCHED_AT, streaming: false },
      { id: "m2", role: "assistant", text: "done", createdAt: repliedAt, streaming: false },
    ],
    session: { threadId, status: "stopped", providerInstanceId: "codex", activeTurnId: null, lastError: null },
  };
}

// The real fixture's failures are dated July 2026. A command seeded now postdates them, and the
// staleness guard would (correctly) refuse to attribute them. This keeps T3's real error payload
// while dating the session as if the failure just happened.
function freshFailureSnapshot() {
  const at = new Date().toISOString();
  return {
    ...SNAPSHOT,
    threads: SNAPSHOT.threads.map((thread) => ({
      ...thread,
      session: { ...thread.session, updatedAt: at },
    })),
  };
}

function runningThread(threadId = "thread_running") {
  return {
    id: threadId,
    title: "In flight",
    messages: [{ id: "m1", role: "user", text: "do it", createdAt: DISPATCHED_AT, streaming: false }],
    session: { threadId, status: "running", providerInstanceId: "codex", activeTurnId: "turn_1", lastError: null },
  };
}

test("outcomes are read from the real snapshot's failed threads", () => {
  const outcomes = extractThreadOutcomes(SNAPSHOT);
  assert.equal(outcomes.size, 3);

  for (const outcome of outcomes.values()) {
    assert.ok(outcome.failure, "every thread on this environment failed");
    assert.match(outcome.failure.message, /not supported when using Codex/u);
    assert.equal(outcome.failure.code, "invalid_request_error");
    assert.equal(outcome.assistantMessageCount, 0);
    assert.equal(outcome.lastAssistantAt, null);
    assert.equal(outcome.lastAssistantText, null);
    // Session status is "stopped" on failure and success alike, so it proves nothing on its own.
    assert.equal(outcome.sessionStatus, "stopped");
  }
});

test("a succeeded thread is distinguished from a failed one despite both being stopped", () => {
  const outcomes = extractThreadOutcomes({ threads: [succeededThread()] });
  const outcome = outcomes.get("thread_ok");
  assert.equal(outcome.sessionStatus, "stopped");
  assert.equal(outcome.failure, null);
  assert.equal(outcome.assistantMessageCount, 1);
  assert.equal(outcome.lastAssistantAt, "2026-07-24T19:10:00.000Z");
  assert.equal(outcome.lastAssistantText, "done");
});

test("a streaming assistant message does not count as a reply yet", () => {
  const thread = succeededThread();
  thread.messages[1].streaming = true;
  const outcome = extractThreadOutcomes({ threads: [thread] }).get("thread_ok");
  assert.equal(outcome.assistantMessageCount, 0);
  assert.equal(outcome.lastAssistantAt, null);
  assert.equal(outcome.lastAssistantText, null);
});

test("reconciliation marks failed, completed, or leaves the command alone", () => {
  const command = { status: "dispatched", updatedAt: DISPATCHED_AT, createdAt: DISPATCHED_AT };

  const failed = reconcileCommandStatus(
    command,
    extractThreadOutcomes(SNAPSHOT).values().next().value,
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.result.reason, /not supported when using Codex/u);
  assert.equal(failed.result.code, "invalid_request_error");

  const completed = reconcileCommandStatus(
    command,
    extractThreadOutcomes({ threads: [succeededThread()] }).get("thread_ok"),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.repliedAt, "2026-07-24T19:10:00.000Z");
  assert.equal(completed.result.response, "done");

  // Still running: no evidence either way.
  assert.equal(
    reconcileCommandStatus(command, extractThreadOutcomes({ threads: [runningThread()] }).get("thread_running")),
    null,
  );

  // Already terminal: never re-decided.
  assert.equal(reconcileCommandStatus({ ...command, status: "failed" }, { failure: { message: "x" } }), null);
  assert.equal(reconcileCommandStatus({ ...command, status: "completed" }, { failure: { message: "x" } }), null);
  assert.equal(reconcileCommandStatus(command, undefined), null);
});

test("evidence older than the dispatch is not attributed to this command", () => {
  const command = { status: "dispatched", updatedAt: "2026-07-24T20:00:00.000Z" };

  // A reply from a previous turn on the same thread.
  const stale = extractThreadOutcomes({ threads: [succeededThread("t", "2026-07-24T19:00:00.000Z")] }).get("t");
  assert.equal(reconcileCommandStatus(command, stale), null);

  // A failure recorded before this command was dispatched.
  const oldFailure = {
    failure: { message: "older failure", code: null, at: "2026-07-24T19:00:00.000Z" },
    lastAssistantAt: null,
  };
  assert.equal(reconcileCommandStatus(command, oldFailure), null);

  // Same evidence, but after the dispatch, is attributed.
  const freshFailure = { ...oldFailure, failure: { ...oldFailure.failure, at: "2026-07-24T20:30:00.000Z" } };
  assert.equal(reconcileCommandStatus(command, freshFailure).status, "failed");
});

async function seed(store, { threadId, status = "dispatched" } = {}) {
  await store.ensureUser({ userId: "user_1", email: "u@example.local" });
  const environment = await store.upsertEnvironment({
    userId: "user_1",
    label: "Mac T3",
    baseUrl: "https://mock-t3.example",
    accessToken: "token",
  });
  const command = await store.createCommand({
    userId: "user_1",
    deviceId: null,
    environmentId: environment.id,
    threadId,
    intent: { type: "agent_prompt", text: "go" },
    normalized: { type: "thread.turn.start" },
    status,
    risk: "low",
    result: { accepted: true },
    metrics: { startedAt: Date.now() },
  });
  return { environment, command };
}

test("the poller flips a stuck dispatched command to failed using T3's error", async () => {
  const store = createMemoryStore();
  const threadId = SNAPSHOT.threads[0].id;
  const { environment, command } = await seed(store, { threadId });

  const snapshot = freshFailureSnapshot();
  const poller = createSnapshotPoller({ store, fetchSnapshot: async () => snapshot });
  poller.trackUser("user_1");
  const result = await poller.runOnce();

  assert.deepEqual(result.polled[0].reconciled, [{ commandId: command.id, status: "failed" }]);

  const [stored] = (await store.listCommands("user_1")).filter((entry) => entry.id === command.id);
  assert.equal(stored.status, "failed");
  assert.match(stored.result.reason, /not supported when using Codex/u);
  assert.equal(stored.result.source, "t3-session");
  assert.ok(stored.metrics.failureAt);
  assert.equal(stored.environmentId, environment.id);

  // A second pass must not re-write an already terminal command.
  const second = await poller.runOnce();
  assert.deepEqual(second.polled[0].reconciled, []);
});

test("the poller completes a command once the agent has replied", async () => {
  const store = createMemoryStore();
  const { command } = await seed(store, { threadId: "thread_ok" });

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => ({ projects: [], threads: [succeededThread("thread_ok", new Date().toISOString())] }),
  });
  poller.trackUser("user_1");
  await poller.runOnce();

  const [stored] = (await store.listCommands("user_1")).filter((entry) => entry.id === command.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.result.response, "done");
  assert.ok(stored.metrics.completedAt);
});

test("a command for another environment or an in-flight turn is untouched", async () => {
  const store = createMemoryStore();
  const { command } = await seed(store, { threadId: "thread_running" });

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => ({ projects: [], threads: [runningThread()] }),
  });
  poller.trackUser("user_1");
  await poller.runOnce();

  const [stored] = (await store.listCommands("user_1")).filter((entry) => entry.id === command.id);
  assert.equal(stored.status, "dispatched", "an in-flight turn must stay dispatched");
});

test("reconciliation failures are contained and do not break polling", async () => {
  const store = createMemoryStore();
  await seed(store, { threadId: SNAPSHOT.threads[0].id });
  const warnings = [];

  // Commands cannot be listed; the poll must still report the environment as reachable.
  store.listCommands = async () => {
    throw new Error("store unavailable");
  };

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => freshFailureSnapshot(),
    logger: { warn: (text) => warnings.push(text) },
  });
  poller.trackUser("user_1");
  const result = await poller.runOnce();

  assert.equal(result.polled[0].status, "reachable");
  assert.deepEqual(result.polled[0].reconciled, []);
  assert.match(warnings.join(" "), /store unavailable/u);
});
