import { describe, expect, test } from "vitest";

import { connectorFailureFromMetadata, connectorForEnvironment, environmentHealthLayers } from "./connectorHealth";
import type { Connector, Environment } from "./types";

const NOW = Date.parse("2026-08-27T18:00:00.000Z");

const environment: Environment = {
  id: "env_1",
  label: "Studio Mac",
  baseUrl: null,
  transportMode: "connector",
  connectorId: "ctr_1",
  freshness: "live",
  providerCatalogue: {
    instances: [{ instanceId: "codex", status: "ready", auth: { status: "authenticated" }, models: [{ id: "gpt-5" }] }],
  },
};

const connector: Connector = {
  id: "ctr_1",
  environmentId: "env_1",
  label: "Studio Mac Connector",
  status: "online",
  protocolVersion: 1,
  connectorVersion: "0.1.0",
  platform: "darwin-arm64",
  lastSeenAt: "2026-08-27T17:59:40.000Z",
  lastT3Health: "ready",
  lastT3HealthAt: "2026-08-27T17:59:40.000Z",
};

describe("connector-first layered health", () => {
  test("keeps cloud, connector, T3, provider, and proof as separate evidence", () => {
    expect(environmentHealthLayers({
      environment,
      connector,
      cloudConnection: "live",
      proofReady: true,
      now: NOW,
    }).map(({ label, state, stale }) => ({ label, state, stale }))).toEqual([
      { label: "Cloud", state: "operational", stale: false },
      { label: "Connector", state: "online", stale: false },
      { label: "T3", state: "ready", stale: false },
      { label: "Provider", state: "ready", stale: false },
      { label: "Proof", state: "complete", stale: false },
    ]);
  });

  test("does not present a late heartbeat or cached T3 report as live", () => {
    const layers = environmentHealthLayers({
      environment: { ...environment, freshness: "stale" },
      connector: { ...connector, lastSeenAt: "2026-08-27T17:58:40.000Z" },
      cloudConnection: "connected",
      now: NOW,
    });
    expect(layers.find((item) => item.key === "connector")).toMatchObject({ state: "reconnecting", stale: true });
    expect(layers.find((item) => item.key === "t3")).toMatchObject({ state: "ready", tone: "warning", stale: true });
    expect(layers.find((item) => item.key === "provider")).toMatchObject({ state: "ready", tone: "warning", stale: true });
  });

  test("reports revoked credentials and never suggests reusing the old secret", () => {
    const layer = environmentHealthLayers({
      environment,
      connector: { ...connector, status: "revoked", revokedAt: "2026-08-27T17:50:00.000Z" },
      cloudConnection: "connected",
      now: NOW,
    }).find((item) => item.key === "connector");
    expect(layer).toMatchObject({ state: "revoked", tone: "danger", stale: true });
    expect(layer?.detail).toMatch(/new enrollment/u);
    expect(layer?.detail).not.toMatch(/reuse.*secret/u);
  });

  test("finds the active connector by explicit binding before an older revoked row", () => {
    expect(connectorForEnvironment([
      { ...connector, id: "ctr_old", status: "revoked", revokedAt: "2026-08-27T17:00:00.000Z" },
      connector,
    ], environment)?.id).toBe("ctr_1");
  });

  test("does not claim provider readiness from models without explicit status and authentication", () => {
    const layers = environmentHealthLayers({
      environment: {
        ...environment,
        providerCatalogue: { instances: [{ instanceId: "codex", models: [{ id: "gpt-5" }] }] },
      },
      connector,
      cloudConnection: "connected",
      now: NOW,
    });
    expect(layers.find((item) => item.key === "provider")).toMatchObject({ state: "unknown", tone: "neutral" });
  });

  test("refines snapshot recovery only from conclusive connector metadata", () => {
    expect(connectorFailureFromMetadata(environment, {
      ...connector,
      status: "offline",
    }, NOW)).toMatchObject({ reason: "connector_offline", retryable: true });
    expect(connectorFailureFromMetadata(environment, {
      ...connector,
      status: "revoked",
      revokedAt: "2026-08-27T17:50:00.000Z",
    }, NOW)).toMatchObject({ reason: "connector_revoked", retryable: false });
    expect(connectorFailureFromMetadata(environment, {
      ...connector,
      protocolVersion: 2,
    }, NOW)).toMatchObject({ reason: "connector_incompatible", retryable: false });
    expect(connectorFailureFromMetadata(environment, {
      ...connector,
      status: "enrolled",
      lastSeenAt: null,
    }, NOW)).toBeNull();
  });
});
