import { createHash } from "node:crypto";

const TERMINAL_FIRMWARE_STATES = new Set(["verified", "failed", "rolled_back"]);

/**
 * Durable, runtime-neutral release reconciler. It never widens a cohort and never completes a
 * rollout: both operations require an owner action carrying an evidence reference. The worker only
 * turns an already-authorized cohort into target assignments and projects observed target truth.
 */
export function createReleaseRolloutRunner({ store, events = null, intervalMs = 30_000, logger = console } = {}) {
  let timer = null;
  let running = false;

  async function runOnce({ limit = 25 } = {}) {
    if (running) return { skipped: true, processed: 0, assignments: 0 };
    running = true;
    try {
      const rollouts = await store.listRunnableReleaseRollouts({ limit });
      let assignments = 0;
      const results = [];
      for (const rollout of rollouts) {
        const result = await reconcile(rollout);
        assignments += result.assignments;
        results.push(result);
      }
      return { skipped: false, processed: results.length, assignments, results };
    } finally {
      running = false;
    }
  }

  async function reconcile(input) {
    const rollout = input.id ? input : await store.getReleaseRolloutForUser(input.userId, input.rolloutId);
    if (!rollout || !["running", "rolling_back"].includes(rollout.state)) {
      return { rolloutId: rollout?.id ?? null, assignments: 0, skipped: true };
    }
    const targets = rollout.targetKind === "firmware"
      ? (await store.listDevices(rollout.userId)).filter((device) => !device.revokedAt)
      : (await store.listConnectors(rollout.userId)).filter((connector) => !connector.revokedAt);
    const selected = targets.filter((target) => targetSelected(rollout, target.id));
    let changed = 0;
    for (const target of selected) {
      const result = rollout.targetKind === "firmware"
        ? await reconcileFirmwareTarget(rollout, target)
        : await reconcileConnectorTarget(rollout, target);
      if (result) changed += 1;
    }
    events?.broadcastToUser?.(rollout.userId, "release-rollout.changed", {
      rolloutId: rollout.id,
      state: rollout.state,
      changedAt: new Date().toISOString(),
    });
    return { rolloutId: rollout.id, assignments: changed, selected: selected.length, skipped: false };
  }

  async function reconcileFirmwareTarget(rollout, device) {
    const observedVersion = device.status?.firmwareVersion ?? null;
    const targetVersion = rollout.state === "rolling_back" ? rollout.rollbackVersion : rollout.targetVersion;
    const compatibility = await firmwareCompatibility(store, rollout, device, targetVersion);
    if (!compatibility.ok) {
      return await write(device.id, {
        status: "blocked", reasonCode: compatibility.reasonCode, observedVersion,
      });
    }
    if (observedVersion === targetVersion) {
      return await write(device.id, {
        status: rollout.state === "rolling_back" ? "rolled_back" : "succeeded",
        reasonCode: null, observedVersion, progress: 100,
      });
    }
    const policy = await store.getDeviceFirmwarePolicy({ userId: rollout.userId, deviceId: device.id });
    if (policy?.targetVersion === targetVersion && policy.lastUpdateStatus === "failed") {
      return await write(device.id, {
        status: "failed", reasonCode: "device_reported_failure", observedVersion,
        progress: policy.updateProgress,
      });
    }
    await store.updateDeviceFirmwarePolicy({
      userId: rollout.userId,
      deviceId: device.id,
      actorType: "system",
      actorId: rollout.id,
      policy: { channel: rollout.channel, desiredVersion: targetVersion },
    });
    const active = policy?.targetVersion === targetVersion && policy?.lastUpdateStatus
      && !TERMINAL_FIRMWARE_STATES.has(policy.lastUpdateStatus);
    return await write(device.id, {
      status: active ? "in_progress" : rollout.state === "rolling_back" ? "rollback_queued" : "queued",
      reasonCode: null,
      observedVersion,
      progress: active ? policy.updateProgress : null,
      attempted: policy?.desiredVersion !== targetVersion,
      previousDesiredVersion: policy?.desiredVersion ?? null,
    });

    async function write(targetId, patch) {
      return await store.upsertRolloutAssignment({ userId: rollout.userId, rolloutId: rollout.id, targetId, patch });
    }
  }

  async function reconcileConnectorTarget(rollout, connector) {
    const observedVersion = connector.connectorVersion ?? null;
    const targetVersion = rollout.state === "rolling_back" ? rollout.rollbackVersion : rollout.targetVersion;
    const compatibility = protocolCompatibility(rollout, connector);
    let patch;
    if (!compatibility.ok) {
      patch = { status: "blocked", reasonCode: compatibility.reasonCode, observedVersion };
    } else if (observedVersion === targetVersion) {
      patch = {
        status: rollout.state === "rolling_back" ? "rolled_back" : "succeeded",
        reasonCode: null, observedVersion, progress: 100,
      };
    } else {
      // The connector package deliberately has no remote self-update command. Cloud control may
      // select and observe a cohort, but installation remains an explicit local `npx ... update`.
      patch = {
        status: "awaiting_operator_update",
        reasonCode: "connector_update_requires_local_cli",
        observedVersion,
      };
    }
    return await store.upsertRolloutAssignment({
      userId: rollout.userId, rolloutId: rollout.id, targetId: connector.id, patch,
    });
  }

  async function reverseAssignments(rollout, { rolledBack = false } = {}) {
    const assignments = await store.listRolloutAssignments({ userId: rollout.userId, rolloutId: rollout.id });
    for (const assignment of assignments) {
      if (rollout.targetKind === "firmware") {
        const policy = await store.getDeviceFirmwarePolicy({ userId: rollout.userId, deviceId: assignment.targetId });
        const controlledVersion = rolledBack ? rollout.rollbackVersion : rollout.targetVersion;
        if (policy?.desiredVersion === controlledVersion) {
          await store.updateDeviceFirmwarePolicy({
            userId: rollout.userId,
            deviceId: assignment.targetId,
            actorType: "system",
            actorId: rollout.id,
            policy: { desiredVersion: assignment.previousDesiredVersion ?? null },
          });
        }
      }
      await store.upsertRolloutAssignment({
        userId: rollout.userId,
        rolloutId: rollout.id,
        targetId: assignment.targetId,
        patch: { status: rolledBack ? "rolled_back" : "cancelled", reasonCode: null },
      });
    }
    return { rolloutId: rollout.id, assignments: assignments.length };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => runOnce().catch((error) => logger?.warn?.(`release rollout run failed: ${safeCode(error)}`)), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, reconcile, reverseAssignments, start, stop };
}

export function targetSelected(rollout, targetId) {
  if (rollout.cohort?.type === "allowlist") return rollout.cohort.targetIds.includes(targetId);
  const percentage = rollout.cohort?.percentage ?? 0;
  if (percentage >= 100) return true;
  const bucket = createHash("sha256").update(`${rollout.id}:${targetId}`).digest().readUInt32BE(0) % 10_000;
  return bucket < percentage * 100;
}

function protocolCompatibility(rollout, target) {
  if ((target.protocolVersion ?? 0) < rollout.minimumProtocolVersion) {
    return { ok: false, reasonCode: "protocol_version_too_old" };
  }
  const capabilities = new Set(target.capabilities ?? target.status?.features ?? []);
  if (rollout.requiredCapabilities.some((capability) => !capabilities.has(capability))) {
    return { ok: false, reasonCode: "required_capability_missing" };
  }
  return { ok: true };
}

async function firmwareCompatibility(store, rollout, device, targetVersion) {
  const protocol = protocolCompatibility(rollout, {
    protocolVersion: device.status?.protocolVersion ?? 1,
    capabilities: device.status?.features ?? [],
  });
  if (!protocol.ok) return protocol;
  const hardwareModel = device.status?.hardwareModel ?? device.hardwareModel ?? null;
  if (!hardwareModel) return { ok: false, reasonCode: "hardware_model_unknown" };
  const releases = await store.listFirmwareReleases({ hardwareModel, channel: rollout.channel });
  const release = releases.find((candidate) => candidate.version === targetVersion);
  if (!release) return { ok: false, reasonCode: "compatible_release_missing" };
  if (rollout.state !== "rolling_back" && rollout.releaseId && release.id !== rollout.releaseId) {
    return { ok: false, reasonCode: "release_identity_mismatch" };
  }
  return { ok: true };
}

function safeCode(error) {
  return typeof error?.code === "string" ? error.code : "rollout_reconcile_failed";
}
