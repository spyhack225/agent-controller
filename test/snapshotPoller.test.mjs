import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshotPoller } from "../src/snapshotPoller.mjs";
import { createMemoryStore } from "../src/store.mjs";

async function seedEnvironment(store, { userId = "user_1", label = "Mac T3", accessTokenExpiresAt } = {}) {
  await store.ensureUser({ userId, email: `${userId}@example.local` });
  const environment = await store.upsertEnvironment({
    userId,
    label,
    baseUrl: "https://mock-t3.example",
    accessToken: "token-abc",
    ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
  });
  return environment;
}

function recordingEvents() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToUser: (userId, type, payload) => broadcasts.push({ userId, type, payload }),
  };
}

test("poller only touches users that are currently active", async () => {
  const store = createMemoryStore();
  await seedEnvironment(store);
  let snapshotCalls = 0;

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => {
      snapshotCalls += 1;
      return { projects: [{ id: "p1" }], threads: [{ id: "t1" }] };
    },
  });

  await poller.runOnce();
  assert.equal(snapshotCalls, 0, "no active users means no polling work");

  poller.trackUser("user_1");
  await poller.runOnce();
  assert.equal(snapshotCalls, 1);
});

test("active users expire after the activity TTL", async () => {
  const store = createMemoryStore();
  await seedEnvironment(store);
  let currentTime = 1_000_000;

  const poller = createSnapshotPoller({
    store,
    activeTtlMs: 60_000,
    now: () => currentTime,
    fetchSnapshot: async () => ({ projects: [], threads: [] }),
  });

  poller.trackUser("user_1");
  assert.deepEqual(poller.activeUserIds(), ["user_1"]);

  currentTime += 59_000;
  assert.deepEqual(poller.activeUserIds(), ["user_1"], "still inside the window");

  currentTime += 2_000;
  assert.deepEqual(poller.activeUserIds(), [], "expired past the TTL");
});

test("a reachable poll records health and pushes the compressed screen once per change", async () => {
  const store = createMemoryStore();
  const environment = await seedEnvironment(store);
  const events = recordingEvents();
  let threads = [{ id: "t1" }];

  const poller = createSnapshotPoller({
    store,
    events,
    fetchSnapshot: async () => ({ projects: [{ id: "p1" }], threads }),
  });
  poller.trackUser("user_1");

  await poller.runOnce();
  assert.equal(events.broadcasts.length, 1);
  assert.equal(events.broadcasts[0].type, "t3.snapshot");
  assert.equal(events.broadcasts[0].userId, "user_1");
  assert.equal(events.broadcasts[0].payload.environmentId, environment.id);
  assert.deepEqual(events.broadcasts[0].payload.screen, {
    title: "T3 Code",
    state: "reachable",
    line1: "1 projects",
    line2: "1 threads",
  });

  const stored = await store.getEnvironmentForUser("user_1", environment.id);
  assert.equal(stored.status, "reachable");
  assert.equal(stored.health.lastError, null);

  // Unchanged snapshot: no second push.
  await poller.runOnce();
  assert.equal(events.broadcasts.length, 1, "identical state must not re-broadcast");

  // Changed snapshot: exactly one more push.
  threads = [{ id: "t1" }, { id: "t2" }];
  await poller.runOnce();
  assert.equal(events.broadcasts.length, 2);
  assert.equal(events.broadcasts[1].payload.screen.line2, "2 threads");
});

test("an unreachable environment is marked unreachable and reported once", async () => {
  const store = createMemoryStore();
  const environment = await seedEnvironment(store);
  const events = recordingEvents();

  const poller = createSnapshotPoller({
    store,
    events,
    fetchSnapshot: async () => {
      throw Object.assign(new Error("T3 snapshot timed out after 8000ms."), { code: "ETIMEDOUT" });
    },
  });
  poller.trackUser("user_1");

  const first = await poller.runOnce();
  assert.equal(first.polled[0].status, "unreachable");
  assert.match(first.polled[0].error, /timed out/u);

  const stored = await store.getEnvironmentForUser("user_1", environment.id);
  assert.equal(stored.status, "unreachable");
  assert.match(stored.health.lastError, /timed out/u);
  assert.equal(stored.health.failureReason, "timeout");

  assert.equal(events.broadcasts.length, 1);
  assert.equal(events.broadcasts[0].payload.screen.state, "unreachable");

  await poller.runOnce();
  assert.equal(events.broadcasts.length, 1, "a persistently unreachable env must not spam subscribers");
});

test("expired tokens are surfaced without attempting a snapshot", async () => {
  const store = createMemoryStore();
  await seedEnvironment(store, { accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
  const events = recordingEvents();
  let snapshotCalls = 0;

  const poller = createSnapshotPoller({
    store,
    events,
    fetchSnapshot: async () => {
      snapshotCalls += 1;
      return { projects: [], threads: [] };
    },
  });
  poller.trackUser("user_1");

  const result = await poller.runOnce();
  assert.equal(result.polled[0].status, "token_expired");
  assert.equal(snapshotCalls, 0, "an expired token must not be sent to T3");
  assert.equal(events.broadcasts[0].payload.screen.state, "token_expired");

  const stored = await store.getEnvironmentForUser("user_1", (await store.listEnvironments("user_1"))[0].id);
  assert.equal(stored.health.failureReason, "token_expired");
});

test("a slow tick does not overlap with the next one", async () => {
  const store = createMemoryStore();
  await seedEnvironment(store);
  let active = 0;
  let maxConcurrent = 0;

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { projects: [], threads: [] };
    },
  });
  poller.trackUser("user_1");

  const [first, second] = await Promise.all([poller.runOnce(), poller.runOnce()]);
  assert.equal(maxConcurrent, 1);
  assert.ok(first.skipped || second.skipped, "the overlapping tick must be skipped");
});

test("store failures are contained and do not throw out of a tick", async () => {
  const failingStore = {
    listEnvironments: async () => {
      throw new Error("convex unavailable");
    },
  };
  const warnings = [];
  const poller = createSnapshotPoller({
    store: failingStore,
    logger: { warn: (text) => warnings.push(text) },
  });
  poller.trackUser("user_1");

  const result = await poller.runOnce();
  assert.deepEqual(result.polled, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /convex unavailable/u);
});

test("a steady environment is not rewritten on every tick", async () => {
  // Each health write audits and notifies, and every notify makes connected dashboards refetch
  // their whole world. Rewriting unchanged health produced a refresh storm and an audit row per
  // poll interval, forever.
  const store = createMemoryStore();
  const environment = await seedEnvironment(store);
  const events = recordingEvents();

  let healthWrites = 0;
  const wrapped = {
    ...store,
    updateEnvironmentHealth: async (args) => {
      healthWrites += 1;
      return store.updateEnvironmentHealth(args);
    },
  };

  const poller = createSnapshotPoller({
    store: wrapped,
    events,
    fetchSnapshot: async () => ({ projects: [{ id: "p1" }], threads: [] }),
  });
  poller.trackUser("user_1");

  await poller.runOnce();
  assert.equal(healthWrites, 1, "the first poll records reachability");

  await poller.runOnce();
  await poller.runOnce();
  await poller.runOnce();
  assert.equal(healthWrites, 1, "unchanged health must not be rewritten");

  const audits = await store.listAuditLogs("user_1");
  const healthAudits = audits.filter((entry) => entry.action === "environment.health_checked");
  assert.equal(healthAudits.length, 1, "one audit row, not one per tick");

  const stored = await store.getEnvironmentForUser("user_1", environment.id);
  assert.equal(stored.status, "reachable");
});

test("a genuine health transition is still recorded", async () => {
  const store = createMemoryStore();
  await seedEnvironment(store);
  let reachable = true;

  const poller = createSnapshotPoller({
    store,
    fetchSnapshot: async () => {
      if (!reachable) throw new Error("T3 snapshot timed out.");
      return { projects: [], threads: [] };
    },
  });
  poller.trackUser("user_1");

  await poller.runOnce();
  assert.equal((await store.getEnvironmentForUser("user_1", (await store.listEnvironments("user_1"))[0].id)).status, "reachable");

  reachable = false;
  await poller.runOnce();
  const afterFailure = await store.getEnvironmentForUser("user_1", (await store.listEnvironments("user_1"))[0].id);
  assert.equal(afterFailure.status, "unreachable", "a real transition must still be written");
  assert.match(afterFailure.health.lastError, /timed out/u);

  reachable = true;
  await poller.runOnce();
  const recovered = await store.getEnvironmentForUser("user_1", (await store.listEnvironments("user_1"))[0].id);
  assert.equal(recovered.status, "reachable");
  assert.equal(recovered.health.lastError, null);
});
