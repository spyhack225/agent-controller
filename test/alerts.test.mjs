import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, loadAlertThresholds, summarizeAlerts } from "../src/alerts.mjs";
import { createApp } from "../src/app.mjs";
import { buildUserObservabilitySummary } from "../src/observability.mjs";
import { createMemoryStore } from "../src/store.mjs";

const HEALTHY = {
  devices: { total: 1, online: 1, offline: 0, lowBatteryDevices: 0, lowestBatteryPercent: 88 },
  environments: { total: 1, reachable: 1, unreachable: 0, tokenExpired: 0, tokenExpiringSoon: 0 },
  commands: {
    total: 10,
    completed: 10,
    failed: 0,
    approvalRequired: 0,
    acknowledgement: { count: 10, medianMs: 400, p95Ms: 900 },
    dispatch: { count: 10, medianMs: 1200, p95Ms: 2000 },
  },
  media: { total: 2, failedProcessing: 0, pendingProcessing: 0 },
};

function withSummary(overrides) {
  return {
    ...HEALTHY,
    ...overrides,
    devices: { ...HEALTHY.devices, ...(overrides.devices ?? {}) },
    environments: { ...HEALTHY.environments, ...(overrides.environments ?? {}) },
    commands: { ...HEALTHY.commands, ...(overrides.commands ?? {}) },
    media: { ...HEALTHY.media, ...(overrides.media ?? {}) },
  };
}

test("a healthy fleet raises no alerts", () => {
  assert.deepEqual(evaluateAlerts(HEALTHY), []);
  assert.deepEqual(summarizeAlerts([]), { total: 0, critical: 0, warning: 0, info: 0, worst: null });
});

test("expired tokens and unreachable environments are critical", () => {
  const alerts = evaluateAlerts(withSummary({
    environments: { total: 2, reachable: 0, unreachable: 1, tokenExpired: 1 },
  }));
  const ids = alerts.map((alert) => alert.id);
  assert.ok(ids.includes("environment.token_expired"));
  assert.ok(ids.includes("environment.unreachable"));
  assert.equal(alerts.every((alert) => alert.severity === "critical"), true);
  assert.equal(summarizeAlerts(alerts).worst, "critical");
});

test("all controllers offline is more severe than some offline", () => {
  const some = evaluateAlerts(withSummary({ devices: { total: 2, online: 1, offline: 1 } }));
  assert.equal(some.find((alert) => alert.id === "device.offline").severity, "warning");

  const all = evaluateAlerts(withSummary({ devices: { total: 2, online: 0, offline: 2 } }));
  assert.equal(all.find((alert) => alert.id === "device.offline").severity, "critical");
});

test("a fleet with no devices does not alert about devices", () => {
  const alerts = evaluateAlerts(withSummary({ devices: { total: 0, online: 0, offline: 0 } }));
  assert.equal(alerts.some((alert) => alert.id === "device.offline"), false);
});

test("the command failure ratio only fires with enough settled commands", () => {
  // 2 of 4 failed is a bad ratio but too small a sample.
  const small = evaluateAlerts(withSummary({ commands: { completed: 2, failed: 2 } }));
  assert.equal(small.some((alert) => alert.id === "command.failure_rate"), false);

  const enough = evaluateAlerts(withSummary({ commands: { completed: 5, failed: 5 } }));
  const alert = enough.find((entry) => entry.id === "command.failure_rate");
  assert.equal(alert.severity, "critical");
  assert.equal(alert.value, 0.5);
  assert.match(alert.detail, /50%/u);
});

test("latency budgets follow the beta success criteria", () => {
  // The roadmap's criterion is a <2s median command acknowledgement.
  assert.equal(DEFAULT_ALERT_THRESHOLDS.acknowledgementMedianMs, 2000);
  assert.equal(DEFAULT_ALERT_THRESHOLDS.dispatchMedianMs, 10_000);

  const ok = evaluateAlerts(withSummary({ commands: { acknowledgement: { medianMs: 1999, p95Ms: 10 } } }));
  assert.equal(ok.some((alert) => alert.id === "command.acknowledgement_median"), false);

  const slow = evaluateAlerts(withSummary({ commands: { acknowledgement: { medianMs: 2500, p95Ms: 9000 } } }));
  assert.equal(slow.find((alert) => alert.id === "command.acknowledgement_median").value, 2500);
  assert.ok(slow.some((alert) => alert.id === "command.acknowledgement_p95"));

  // Missing measurements must not raise a false alarm.
  const unmeasured = evaluateAlerts(withSummary({
    commands: { acknowledgement: { count: 0, medianMs: null, p95Ms: null }, dispatch: { count: 0, medianMs: null, p95Ms: null } },
  }));
  assert.deepEqual(unmeasured, []);
});

test("alerts are ordered most severe first", () => {
  const alerts = evaluateAlerts(withSummary({
    environments: { tokenExpired: 1 },
    devices: { total: 2, online: 1, offline: 1 },
    commands: { approvalRequired: 3 },
  }));
  const severities = alerts.map((alert) => alert.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => (
    { critical: 0, warning: 1, info: 2 }[a] - { critical: 0, warning: 1, info: 2 }[b]
  )));
  assert.equal(severities[0], "critical");
  assert.equal(severities.at(-1), "info");
});

test("thresholds are configurable from the environment", () => {
  assert.deepEqual(loadAlertThresholds({}), DEFAULT_ALERT_THRESHOLDS);

  const custom = loadAlertThresholds({ ALERT_ACK_MEDIAN_MS: "300", ALERT_COMMAND_FAILURE_RATIO: "0.5" });
  assert.equal(custom.acknowledgementMedianMs, 300);
  assert.equal(custom.commandFailureRatio, 0.5);

  // Garbage falls back rather than disabling the alert.
  assert.equal(loadAlertThresholds({ ALERT_ACK_MEDIAN_MS: "nonsense" }).acknowledgementMedianMs, 2000);

  // The same fleet that is healthy at the default budget breaches a tighter one (median 400ms).
  assert.deepEqual(evaluateAlerts(HEALTHY), []);
  const alerts = evaluateAlerts(HEALTHY, custom);
  assert.equal(alerts.some((alert) => alert.id === "command.acknowledgement_median"), true);
});

test("the alerts endpoint reports real store state", async (t) => {
  const store = createMemoryStore();
  await store.ensureUser({ userId: "user_dev", email: "dev@example.local" });
  const environment = await store.upsertEnvironment({
    userId: "user_dev",
    label: "Mac T3",
    baseUrl: "https://mock-t3.example",
    accessToken: "token",
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await store.updateEnvironmentHealth({
    userId: "user_dev",
    environmentId: environment.id,
    status: "unreachable",
    health: { lastError: "timed out" },
  });

  const { server } = createApp({ store, config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const token = await store.createUserToken({ userId: "user_dev", label: "test" });
  const headers = { authorization: `Bearer ${token.secret}` };

  const response = await fetch(new URL("/v1/observability/alerts", baseUrl), { headers });
  const body = await response.json();
  assert.equal(response.status, 200);

  const ids = body.alerts.map((alert) => alert.id);
  assert.ok(ids.includes("environment.token_expired"));
  assert.ok(ids.includes("environment.unreachable"));
  assert.equal(body.summary.worst, "critical");

  // The summary endpoint carries the same alerts so one call is enough for a dashboard.
  const summaryResponse = await fetch(new URL("/v1/observability/summary", baseUrl), { headers });
  const summaryBody = await summaryResponse.json();
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(summaryBody.alerts.map((alert) => alert.id).sort(), ids.sort());
  assert.ok(summaryBody.summary.environments);
});

test("alerts derive from the real observability summary shape", async () => {
  const store = createMemoryStore();
  await store.ensureUser({ userId: "user_1", email: "u@example.local" });
  const summary = await buildUserObservabilitySummary(store, "user_1");
  // An empty account is healthy, not noisy.
  assert.deepEqual(evaluateAlerts(summary), []);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
