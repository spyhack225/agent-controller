import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEnvironmentRetentionRunner } from "../src/environmentRetention.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { createStore } from "../src/store.mjs";

test("environment retention purges only expired owner tombstones and is idempotent", async () => {
  const store = createStore();
  store.ensureUser({ userId: "user_1" });
  store.ensureUser({ userId: "user_2" });
  const expired = store.upsertEnvironment({
    userId: "user_1", label: "Expired", baseUrl: "https://expired.example", accessToken: "secret", scopes: [],
  });
  const retained = store.upsertEnvironment({
    userId: "user_1", label: "Retained", baseUrl: "https://retained.example", accessToken: "secret", scopes: [],
  });
  const otherOwner = store.upsertEnvironment({
    userId: "user_2", label: "Other", baseUrl: "https://other.example", accessToken: "secret", scopes: [],
  });
  store.archiveEnvironment({ userId: "user_1", environmentId: expired.id, retentionDays: 1, at: "2026-01-01T00:00:00.000Z" });
  store.archiveEnvironment({ userId: "user_1", environmentId: retained.id, retentionDays: 30, at: "2026-01-01T00:00:00.000Z" });
  store.archiveEnvironment({ userId: "user_2", environmentId: otherOwner.id, retentionDays: 1, at: "2026-01-01T00:00:00.000Z" });

  const runner = createEnvironmentRetentionRunner({ store });
  const first = await runner.runOnce({ userId: "user_1", checkedAt: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(first.purged.map((item) => item.id), [expired.id]);
  assert.deepEqual(store.listArchivedEnvironments("user_1").map((item) => item.id), [retained.id]);
  assert.deepEqual(store.listArchivedEnvironments("user_2").map((item) => item.id), [otherOwner.id]);
  assert.equal((await runner.runOnce({ userId: "user_1", checkedAt: "2026-01-03T00:00:00.000Z" })).count, 0);
});

test("FileStore persists a recoverable credential-free tombstone across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "environment-retention-"));
  const path = join(directory, "state.json");
  const first = await createFileStore(path);
  first.ensureUser({ userId: "user_1" });
  const environment = first.upsertEnvironment({
    userId: "user_1", label: "Studio", baseUrl: "https://studio.example", accessToken: "secret", scopes: [],
  });
  await first.archiveEnvironment({ userId: "user_1", environmentId: environment.id, retentionDays: 7, at: "2026-01-01T00:00:00.000Z" });
  await first.flush();
  assert.doesNotMatch(await readFile(path, "utf8"), /"accessToken": "secret"/u);

  const restarted = await createFileStore(path);
  const tombstone = restarted.listArchivedEnvironments("user_1")[0];
  assert.equal(tombstone.purgeAfter, "2026-01-08T00:00:00.000Z");
  const restored = await restarted.restoreEnvironment({ userId: "user_1", environmentId: environment.id, at: "2026-01-02T00:00:00.000Z" });
  assert.equal(restored.environment.status, "needs_repair");
  assert.equal((await restarted.restoreEnvironment({ userId: "user_1", environmentId: environment.id })).alreadyRestored, true);
});
