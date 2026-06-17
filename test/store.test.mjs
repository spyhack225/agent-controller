import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUserDisplayState } from "../src/displayState.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { buildUserObservabilitySummary } from "../src/observability.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("platform tokens authenticate users without exposing token hashes", () => {
  const store = createMemoryStore();
  const { token, secret } = store.createUserToken({ userId: "user_1", label: "test" });

  assert.equal(token.tokenHash, undefined);
  assert.equal(store.authenticateUserToken(secret).id, "user_1");
  assert.equal(store.authenticateUserToken("wrong"), null);
});

test("device presence is computed from recent activity", async () => {
  const recent = new Date().toISOString();
  const store = createMemoryStore({
    devices: [
      {
        id: "dev_online",
        userId: "user_1",
        label: "Online controller",
        profile: "agent-controller",
        claimedAt: recent,
        lastSeenAt: recent,
        status: { lastHeartbeatAt: recent, firmwareVersion: "0.1.7" },
        config: {},
        createdAt: recent,
      },
      {
        id: "dev_offline",
        userId: "user_1",
        label: "Offline controller",
        profile: "agent-controller",
        claimedAt: "2000-01-01T00:00:00.000Z",
        lastSeenAt: "2000-01-01T00:00:00.000Z",
        status: { lastHeartbeatAt: "2000-01-01T00:00:00.000Z" },
        config: {},
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    ],
  });

  const devices = store.listDevices("user_1");
  assert.equal(devices[0].presence.state, "online");
  assert.equal(devices[0].presence.online, true);
  assert.equal(devices[0].presence.staleAfterMs, 90_000);
  assert.equal(devices[1].presence.state, "offline");
  assert.equal(devices[1].presence.online, false);

  const display = await buildUserDisplayState(store, "user_1");
  assert.equal(display.counts.onlineDevices, 1);
  assert.equal(display.counts.offlineDevices, 1);
});

test("observability summary rolls up reliability signals", async () => {
  const now = Date.parse("2026-06-16T14:00:00.000Z");
  const recent = "2026-06-16T13:59:30.000Z";
  const old = "2000-01-01T00:00:00.000Z";
  const store = createMemoryStore({
    devices: [
      {
        id: "dev_online",
        userId: "user_1",
        label: "Online controller",
        profile: "agent-controller",
        claimedAt: recent,
        lastSeenAt: recent,
        status: { lastHeartbeatAt: recent, firmwareVersion: "0.2.0", batteryPercent: 18 },
        config: {},
        createdAt: recent,
      },
      {
        id: "dev_offline",
        userId: "user_1",
        label: "Offline controller",
        profile: "agent-controller",
        claimedAt: old,
        lastSeenAt: old,
        status: { lastHeartbeatAt: old, firmwareVersion: "0.1.0", batteryPercent: 91 },
        config: {},
        createdAt: old,
      },
    ],
    environments: [
      {
        id: "env_reachable",
        userId: "user_1",
        label: "Reachable T3",
        baseUrl: "https://reachable.example",
        accessToken: "token",
        accessTokenExpiresAt: "2026-06-18T14:00:00.000Z",
        scopes: [],
        status: "reachable",
        health: { lastCheckedAt: "2026-06-16T13:58:00.000Z" },
        createdAt: recent,
        updatedAt: recent,
      },
      {
        id: "env_expired",
        userId: "user_1",
        label: "Expired T3",
        baseUrl: "https://expired.example",
        accessToken: "token",
        accessTokenExpiresAt: "2026-06-15T14:00:00.000Z",
        scopes: [],
        status: "token_expired",
        health: { lastCheckedAt: "2026-06-16T13:59:00.000Z" },
        createdAt: recent,
        updatedAt: recent,
      },
    ],
    mediaUploads: [
      {
        id: "media_failed",
        userId: "user_1",
        kind: "audio",
        contentType: "audio/webm",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        storagePath: "/tmp/failed.webm",
        processing: { transcriptionStatus: "failed", lastError: "provider unavailable" },
        expiresAt: "2026-06-17T14:00:00.000Z",
        createdAt: recent,
      },
      {
        id: "media_image",
        userId: "user_1",
        kind: "image",
        contentType: "image/png",
        sizeBytes: 20,
        sha256: "b".repeat(64),
        storagePath: "/tmp/image.png",
        expiresAt: null,
        createdAt: recent,
      },
    ],
    commands: [
      {
        id: "cmd_dispatched",
        userId: "user_1",
        deviceId: "dev_online",
        environmentId: "env_reachable",
        threadId: "thread_1",
        intent: { type: "agent_prompt", text: "test" },
        normalized: null,
        status: "dispatched",
        risk: "low",
        result: {},
        metrics: { acknowledgementDurationMs: 100, dispatchDurationMs: 50 },
        createdAt: recent,
        updatedAt: recent,
      },
      {
        id: "cmd_failed",
        userId: "user_1",
        deviceId: "dev_online",
        environmentId: "env_reachable",
        threadId: "thread_1",
        intent: { type: "agent_prompt", text: "test" },
        normalized: null,
        status: "failed",
        risk: "low",
        result: {},
        metrics: { acknowledgementDurationMs: 300, dispatchDurationMs: 150 },
        createdAt: recent,
        updatedAt: recent,
      },
    ],
  });

  const summary = await buildUserObservabilitySummary(store, "user_1", now);
  assert.equal(summary.devices.total, 2);
  assert.equal(summary.devices.online, 1);
  assert.equal(summary.devices.offline, 1);
  assert.equal(summary.devices.lowBatteryDevices, 1);
  assert.equal(summary.devices.lowestBatteryPercent, 18);
  assert.deepEqual(summary.devices.firmwareVersions, { "0.2.0": 1, "0.1.0": 1 });
  assert.equal(summary.environments.reachable, 1);
  assert.equal(summary.environments.tokenExpired, 1);
  assert.equal(summary.environments.tokenExpiringSoon, 1);
  assert.equal(summary.commands.failed, 1);
  assert.equal(summary.commands.acknowledgement.medianMs, 100);
  assert.equal(summary.commands.acknowledgement.p95Ms, 300);
  assert.equal(summary.commands.dispatch.p95Ms, 150);
  assert.equal(summary.media.failedProcessing, 1);
  assert.equal(summary.media.expiringSoon, 1);
  assert.deepEqual(summary.media.byKind, { audio: 1, image: 1 });
});

test("file store persists users, tokens, devices, and audit logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-controller-store-"));
  const dataFile = join(dir, "store.json");
  try {
    const first = await createFileStore(dataFile);
    const { secret: platformSecret } = first.createUserToken({ userId: "user_1", label: "test" });
    const { device, secret: deviceSecret } = first.createDevice({
      userId: "user_1",
      label: "Controller",
    });
    const environment = first.upsertEnvironment({
      userId: "user_1",
      label: "T3",
      baseUrl: "https://healthy-t3.example",
      accessToken: "mock-token",
      accessTokenExpiresAt: "2026-06-15T00:00:00.000Z",
      scopes: ["orchestration:read", "orchestration:operate"],
      status: "paired",
    });
    first.updateEnvironmentHealth({
      userId: "user_1",
      environmentId: environment.id,
      status: "reachable",
      health: {
        lastCheckedAt: "2026-06-14T23:20:00.000Z",
        lastReachableAt: "2026-06-14T23:20:00.000Z",
        lastError: null,
        snapshot: { line1: "2 projects", line2: "1 threads" },
      },
    });
    first.updateDeviceConfig({
      userId: "user_1",
      deviceId: device.id,
      config: {
        environmentId: "env_1",
        threadId: "thread_1",
        defaultPrompt: "Persisted prompt.",
        shellCommand: "npm test",
        menu: ["status", "prompt", "shell"],
      },
    });
    first.recordDeviceHeartbeat({
      deviceId: device.id,
      status: {
        firmwareVersion: "0.1.7",
        hardwareModel: "e213-esp32-s3r8",
        ipAddress: "192.168.4.20",
        wifiRssi: -61,
        freeHeap: 184320,
        uptimeMs: 120000,
      },
    });
    first.createFirmwareRelease({
      version: "0.2.0",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/fw.bin",
      sha256: "b".repeat(64),
      sizeBytes: 1234,
      mandatory: false,
      releaseNotes: "Test release.",
    });
    const media = first.createMediaUpload({
      userId: "user_1",
      deviceId: device.id,
      kind: "audio",
      contentType: "audio/wav",
      sizeBytes: 4,
      sha256: "abcd",
      storagePath: "/tmp/audio.wav",
      transcript: "Persisted audio transcript.",
    });
    first.updateMediaTranscript({
      userId: "user_1",
      mediaId: media.id,
      transcript: "Updated persisted audio transcript.",
    });
    const macro = first.createMacro({
      userId: "user_1",
      label: "Run tests",
      environmentId: environment.id,
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
    });
    const command = first.createCommand({
      userId: "user_1",
      deviceId: device.id,
      environmentId: "env_1",
      threadId: "thread_1",
      intent: { type: "shell_input", command: "rm -rf build" },
      normalized: null,
      status: "approval_required",
      risk: "high",
      result: { reason: "Needs approval." },
      metrics: {
        acknowledgementDurationMs: 42,
        dispatchDurationMs: null,
        completedAt: null,
        failureAt: null,
      },
    });
    first.updateCommand({
      userId: "user_1",
      commandId: command.id,
      status: "rejected",
      result: { reason: "Rejected by user." },
      metrics: {
        acknowledgementDurationMs: 84,
        dispatchDurationMs: null,
        completedAt: null,
        failureAt: "2026-06-14T23:25:00.000Z",
      },
    });

    await first.flush();

    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(persisted.users.length, 1);
    assert.equal(persisted.apiTokens.length, 1);
    assert.equal(persisted.apiTokens[0].tokenHash.length, 64);
    assert.equal(persisted.devices[0].secretHash.length, 64);
    assert.equal(persisted.devices[0].config.environmentId, "env_1");
    assert.equal(persisted.devices[0].config.shellCommand, "npm test");
    assert.equal(persisted.devices[0].status.firmwareVersion, "0.1.7");
    assert.equal(persisted.devices[0].status.wifiRssi, -61);
    assert.equal(persisted.environments[0].status, "reachable");
    assert.equal(persisted.environments[0].accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");
    assert.equal(persisted.environments[0].health.snapshot.line1, "2 projects");
    assert.equal(persisted.firmwareReleases[0].version, "0.2.0");
    assert.equal(persisted.mediaUploads.length, 1);
    assert.equal(persisted.mediaUploads[0].transcript, "Updated persisted audio transcript.");
    assert.equal(persisted.mediaUploads[0].processing.transcriptionStatus, "ready");
    assert.equal(persisted.mediaUploads[0].processing.transcriptSource, "manual");
    assert.equal(persisted.macros[0].label, "Run tests");
    assert.equal(persisted.commands[0].status, "rejected");
    assert.equal(persisted.commands[0].metrics.acknowledgementDurationMs, 84);
    assert.equal(persisted.commands[0].metrics.failureAt, "2026-06-14T23:25:00.000Z");
    assert.equal(persisted.commandEvents.length, 2);
    assert.deepEqual(persisted.commandEvents.map((event) => event.status), ["approval_required", "rejected"]);
    assert.equal(persisted.commandEvents[0].metrics.acknowledgementDurationMs, 42);
    assert.equal(persisted.commandEvents[1].metrics.acknowledgementDurationMs, 84);
    assert.notEqual(persisted.apiTokens[0].tokenHash, platformSecret);
    assert.notEqual(persisted.devices[0].secretHash, deviceSecret);

    const second = await createFileStore(dataFile);
    assert.equal(second.authenticateUserToken(platformSecret).id, "user_1");
    assert.equal(second.authenticateDevice(device.id, deviceSecret).id, device.id);
    assert.equal(second.getDeviceForUser("user_1", device.id).config.defaultPrompt, "Persisted prompt.");
    assert.equal(second.getDeviceForUser("user_1", device.id).config.shellCommand, "npm test");
    assert.equal(second.getDeviceForUser("user_1", device.id).status.ipAddress, "192.168.4.20");
    assert.equal(second.listEnvironments("user_1")[0].health.lastReachableAt, "2026-06-14T23:20:00.000Z");
    assert.equal(second.listEnvironments("user_1")[0].accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");
    assert.equal(second.getLatestFirmwareRelease({ hardwareModel: "e213-esp32-s3r8" }).version, "0.2.0");
    assert.equal(second.getMediaForUser("user_1", media.id).id, media.id);
    assert.equal(second.getMediaForUser("user_1", media.id).transcript, "Updated persisted audio transcript.");
    assert.equal(second.getMediaForUser("user_1", media.id).processing.transcriptionStatus, "ready");
    assert.equal(second.getMacroForUser("user_1", macro.id).intent.command, "npm test");
    assert.equal(second.getCommandForUser("user_1", command.id).status, "rejected");
    assert.equal(second.getCommandForUser("user_1", command.id).metrics.failureAt, "2026-06-14T23:25:00.000Z");
    assert.deepEqual(
      second.listCommandEvents({ userId: "user_1", commandId: command.id }).map((event) => event.status),
      ["approval_required", "rejected"],
    );
    assert.equal(
      second.listCommandEvents({ userId: "user_1", commandId: command.id })[1].metrics.failureAt,
      "2026-06-14T23:25:00.000Z",
    );
    assert.ok(second.listAuditLogs("user_1").length >= 2);
    await second.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file store encrypts T3 access tokens when a token key is configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-controller-encrypted-store-"));
  const dataFile = join(dir, "store.json");
  try {
    const first = await createFileStore(dataFile, {
      t3TokenEncryptionKey: "test-token-encryption-key",
    });
    const environment = first.upsertEnvironment({
      userId: "user_1",
      label: "Encrypted T3",
      baseUrl: "https://encrypted-t3.example",
      accessToken: "raw-t3-access-token",
      scopes: ["orchestration:read", "orchestration:operate"],
      status: "paired",
    });
    assert.equal(environment.accessToken, undefined);
    await first.flush();

    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(persisted.environments[0].accessToken, undefined);
    assert.match(persisted.environments[0].accessTokenCiphertext, /^v1:/u);
    assert.notEqual(persisted.environments[0].accessTokenCiphertext, "raw-t3-access-token");

    const second = await createFileStore(dataFile, {
      t3TokenEncryptionKey: "test-token-encryption-key",
    });
    const internalEnvironment = second.getEnvironmentForUser("user_1", environment.id);
    assert.equal(internalEnvironment.accessToken, "raw-t3-access-token");
    assert.equal(second.listEnvironments("user_1")[0].accessToken, undefined);
    assert.equal(second.listEnvironments("user_1")[0].accessTokenCiphertext, undefined);
    await second.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
