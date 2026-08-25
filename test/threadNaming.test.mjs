import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_THREAD_TITLE,
  MINTED_TITLE_TTL_MS,
  mintDeviceThreadTitle,
  normalizeTitle,
  resetMintedThreadTitles,
} from "../src/threadNaming.mjs";

const device = { id: "dev_1a2b3c4d-5e6f", label: "Hosyond Touch screen" };
const at = (hour, minute) => new Date(2026, 7, 24, hour, minute, 0);

test.beforeEach(() => resetMintedThreadTitles());

test("the minted name puts the discriminating instant first and the controller second", () => {
  const title = mintDeviceThreadTitle({ environmentId: "env_1", device, now: at(19, 32) });
  assert.equal(title, "24 Aug 19:32 · Hosyond Touch screen");
});

test("an unlabelled controller is still named, and a nameless one still gets a title", () => {
  assert.equal(
    mintDeviceThreadTitle({ environmentId: "env_1", device: { id: device.id }, now: at(8, 5) }),
    "24 Aug 08:05 · Controller 1a2b3c",
  );
  assert.equal(
    mintDeviceThreadTitle({ environmentId: "env_1", device: null, now: at(8, 5) }),
    "24 Aug 08:05",
  );
});

test("a name already in the environment's snapshot is not minted twice", () => {
  const snapshot = { threads: [{ title: "24 Aug 19:32 · Hosyond Touch screen" }] };
  assert.equal(
    mintDeviceThreadTitle({ environmentId: "env_1", device, snapshot, now: at(19, 32) }),
    "24 Aug 19:32 · Hosyond Touch screen (2)",
  );
});

test("two creates in the same minute do not collide even before the snapshot catches up", () => {
  // The snapshot is deliberately stale: T3 answers a dispatch as soon as the event is appended,
  // so the second create genuinely cannot see the first one there. Local memory is what separates
  // them, and without it this is the case that produced two identical rows.
  const stale = { threads: [] };
  const titles = [0, 1, 2].map(() => mintDeviceThreadTitle({
    environmentId: "env_1",
    device,
    snapshot: stale,
    now: at(19, 32),
  }));
  assert.deepEqual(titles, [
    "24 Aug 19:32 · Hosyond Touch screen",
    "24 Aug 19:32 · Hosyond Touch screen (2)",
    "24 Aug 19:32 · Hosyond Touch screen (3)",
  ]);
});

test("the local memory is scoped per environment and expires", () => {
  // A fixed requested title isolates the memory from the clock: any suffix here is the memory
  // talking, not a different minute.
  const mint = (environmentId, now) => mintDeviceThreadTitle({
    environmentId,
    device,
    requestedTitle: "Ship the release",
    now,
  });

  assert.equal(mint("env_1", at(19, 32)), "Ship the release");
  assert.equal(mint("env_1", at(19, 32)), "Ship the release (2)");
  // A different environment has never heard of it.
  assert.equal(mint("env_2", at(19, 32)), "Ship the release");

  // Past the window the memory is gone; by then the snapshot the caller passes is the source of
  // truth again, and holding titles forever would only grow the map.
  const later = new Date(at(19, 32).getTime() + MINTED_TITLE_TTL_MS + 1);
  assert.equal(mint("env_1", later), "Ship the release");
});

test("a firmware title is collapsed to one line and capped, and beats the minted one", () => {
  assert.equal(normalizeTitle("  Fix   the\tbuild\r\n "), "Fix the build");
  assert.equal(normalizeTitle("   "), null);
  assert.equal(normalizeTitle(""), null);
  assert.equal(normalizeTitle(42), null);
  assert.equal(normalizeTitle(null), null);

  const long = normalizeTitle("x".repeat(500));
  assert.equal(long.length, MAX_THREAD_TITLE);

  assert.equal(
    mintDeviceThreadTitle({ environmentId: "env_1", device, requestedTitle: "Ship the release", now: at(19, 32) }),
    "Ship the release",
  );
});

test("a suffixed title still fits inside T3's length cap", () => {
  const long = "y".repeat(MAX_THREAD_TITLE);
  const first = mintDeviceThreadTitle({ environmentId: "env_1", device, requestedTitle: long });
  const second = mintDeviceThreadTitle({ environmentId: "env_1", device, requestedTitle: long });
  assert.equal(first.length, MAX_THREAD_TITLE);
  assert.notEqual(second, first);
  assert.ok(second.length <= MAX_THREAD_TITLE, `${second.length} > ${MAX_THREAD_TITLE}`);
  assert.ok(second.endsWith(" (2)"));
});
