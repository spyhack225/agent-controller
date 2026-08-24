import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT3ReleaseStatus,
  compareT3Versions,
  evaluateT3Compatibility,
} from "../src/t3Compatibility.mjs";

const environment = { id: "env_1", label: "Studio Mac" };
const snapshot = { projects: [], threads: [] };

test("T3 semantic versions compare stable and prerelease builds", () => {
  assert.equal(compareT3Versions("0.0.28", "0.0.28"), 0);
  assert.equal(compareT3Versions("0.0.29", "0.0.28"), 1);
  assert.equal(compareT3Versions("0.0.28-nightly.1", "0.0.28"), -1);
  assert.equal(compareT3Versions("not-a-version", "0.0.28"), null);
});

test("a newer unverified T3 release raises a review warning", () => {
  const release = buildT3ReleaseStatus("0.0.33");
  assert.equal(release.status, "review_required");
  assert.equal(release.recommendedVersion, "0.0.32");
  assert.match(release.alert, /newer than/u);
});

test("a version change beyond the tested release is marked as a breaking risk", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.0.33",
    previous: { installedVersion: "0.0.32" },
    checkedAt: "2026-08-08T12:00:00.000Z",
    metadata: { serverVersion: "0.0.33" },
    snapshot,
    serverConfig: { providers: [] },
  });

  assert.equal(result.status, "review_required");
  assert.equal(result.versionChanged, true);
  assert.equal(result.breakingRisk, true);
  assert.equal(result.previousVersion, "0.0.32");
  assert.equal(result.checks.every((check) => check.passed), true);
  assert.match(result.recommendation, /0\.0\.32/u);
});

test("a broken orchestration response is incompatible even on a supported version", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.0.28",
    metadata: { serverVersion: "0.0.28" },
    snapshot: { projects: [] },
    serverConfig: { providers: [] },
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.breakingRisk, true);
  assert.equal(result.checks.find((check) => check.id === "snapshot_contract").passed, false);
});

test("a broken websocket provider contract is incompatible", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.0.32",
    metadata: { serverVersion: "0.0.32" },
    snapshot,
    serverConfig: { environment: {} },
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.breakingRisk, true);
  assert.equal(result.checks.find((check) => check.id === "websocket_rpc").passed, true);
  assert.equal(result.checks.find((check) => check.id === "provider_catalogue_contract").passed, false);
});
