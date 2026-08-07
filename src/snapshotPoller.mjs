import { createHash } from "node:crypto";

import { compressSnapshot, fetchT3Snapshot, isEnvironmentTokenExpired } from "./t3Client.mjs";
import { extractThreadOutcomes, reconcileCommandStatus } from "./t3Harness.mjs";

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_ACTIVE_TTL_MS = 5 * 60 * 1000;

// Roadmap Phase 2 asks the gateway to keep T3 state warm rather than only fetching on demand.
// Polling every environment on the platform would not scale and is impossible on the Convex
// store (which exposes no global enumeration), so the poller tracks the users who are actually
// present — an open SSE stream or a recent device heartbeat — and refreshes only their
// environments. State is pushed to subscribers only when the compressed screen actually changes.
export function createSnapshotPoller({
  store,
  events = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  activeTtlMs = DEFAULT_ACTIVE_TTL_MS,
  fetchSnapshot = fetchT3Snapshot,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const activeUsers = new Map();
  const lastScreenDigests = new Map();
  let timer = null;
  let inFlight = false;

  function trackUser(userId) {
    if (typeof userId === "string" && userId.length > 0) activeUsers.set(userId, now());
  }

  function activeUserIds() {
    const cutoff = now() - activeTtlMs;
    for (const [userId, lastActiveAt] of activeUsers) {
      if (lastActiveAt < cutoff) activeUsers.delete(userId);
    }
    return [...activeUsers.keys()];
  }

  function forgetEnvironment(environmentId) {
    lastScreenDigests.delete(environmentId);
  }

  async function runOnce() {
    if (inFlight) return { skipped: true, polled: [] };
    inFlight = true;
    try {
      const polled = [];
      for (const userId of activeUserIds()) {
        polled.push(...(await pollUser(userId)));
      }
      return { skipped: false, polled };
    } finally {
      inFlight = false;
    }
  }

  async function pollUser(userId) {
    let listed;
    try {
      listed = await store.listEnvironments(userId);
    } catch (error) {
      logger?.warn?.(`snapshot poll: listing environments failed for ${userId}: ${message(error)}`);
      return [];
    }

    const outcomes = [];
    for (const summary of listed ?? []) {
      outcomes.push(await pollEnvironment(userId, summary.id));
    }
    return outcomes;
  }

  async function pollEnvironment(userId, environmentId) {
    // listEnvironments returns redacted records; the gateway view carries the decrypted token.
    let environment;
    try {
      environment = await store.getEnvironmentForUser(userId, environmentId);
    } catch (error) {
      return { environmentId, status: "error", error: message(error) };
    }
    if (!environment) {
      forgetEnvironment(environmentId);
      return { environmentId, status: "missing" };
    }

    const checkedAt = new Date(now()).toISOString();

    if (isEnvironmentTokenExpired(environment, now())) {
      await updateHealth(userId, environment, "token_expired", {
        checkedAt,
        lastError: "T3 access token has expired. Re-pair this environment.",
      });
      publishScreen(userId, environment, {
        title: "T3 Code",
        state: "token_expired",
        line1: environment.label ?? "Environment",
        line2: "Re-pair required",
      });
      return { environmentId, status: "token_expired" };
    }

    try {
      const snapshot = await fetchSnapshot(environment);
      await updateHealth(userId, environment, "reachable", { checkedAt, lastError: null });
      const changed = publishScreen(userId, environment, compressSnapshot(snapshot));
      const reconciled = await reconcileCommands(userId, environmentId, snapshot);
      return { environmentId, status: "reachable", changed, reconciled };
    } catch (error) {
      const lastError = message(error);
      await updateHealth(userId, environment, "unreachable", { checkedAt, lastError });
      publishScreen(userId, environment, {
        title: "T3 Code",
        state: "unreachable",
        line1: environment.label ?? "Environment",
        line2: "Unreachable",
      });
      return { environmentId, status: "unreachable", error: lastError };
    }
  }

  /**
   * A dispatch only means T3 accepted the command. The turn can still fail on the provider, so
   * without reading thread state back a failed command stays "dispatched" forever.
   */
  async function reconcileCommands(userId, environmentId, snapshot) {
    const outcomes = extractThreadOutcomes(snapshot);
    if (outcomes.size === 0) return [];

    let commands;
    try {
      commands = await store.listCommands(userId);
    } catch (error) {
      logger?.warn?.(`snapshot poll: listing commands failed for ${userId}: ${message(error)}`);
      return [];
    }

    const applied = [];
    for (const command of commands ?? []) {
      if (command.status !== "dispatched") continue;
      if (command.environmentId !== environmentId) continue;

      const update = reconcileCommandStatus(command, outcomes.get(command.threadId));
      if (!update) continue;

      try {
        await store.updateCommand({
          userId,
          commandId: command.id,
          status: update.status,
          result: update.result,
          metrics: {
            ...(command.metrics ?? {}),
            ...(update.status === "failed"
              ? { failureAt: new Date(now()).toISOString() }
              : { completedAt: new Date(now()).toISOString() }),
          },
        });
        applied.push({ commandId: command.id, status: update.status });
        events?.broadcastToUser?.(userId, "command.reconciled", {
          commandId: command.id,
          threadId: command.threadId,
          environmentId,
          status: update.status,
          reason: update.result.reason,
          observedAt: new Date(now()).toISOString(),
        });
      } catch (error) {
        logger?.warn?.(`snapshot poll: reconciling ${command.id} failed: ${message(error)}`);
      }
    }
    return applied;
  }

  /**
   * Writes health only when it actually changed.
   *
   * `updateEnvironmentHealth` audits and notifies unconditionally, and every notify becomes a
   * `state.changed` that makes each connected dashboard refetch its whole world. Writing on every
   * tick therefore produced a refresh storm and an audit row every poll interval, forever.
   */
  async function updateHealth(userId, environment, status, health) {
    const unchanged = environment.status === status
      && (environment.health?.lastError ?? null) === (health.lastError ?? null);
    if (unchanged) return false;

    try {
      await store.updateEnvironmentHealth({
        userId,
        environmentId: environment.id,
        status,
        health,
      });
      return true;
    } catch (error) {
      logger?.warn?.(`snapshot poll: health update failed for ${environment.id}: ${message(error)}`);
      return false;
    }
  }

  function publishScreen(userId, environment, screen) {
    const digest = createHash("sha256").update(JSON.stringify(screen)).digest("hex");
    if (lastScreenDigests.get(environment.id) === digest) return false;
    lastScreenDigests.set(environment.id, digest);
    events?.broadcastToUser?.(userId, "t3.snapshot", {
      environmentId: environment.id,
      label: environment.label ?? null,
      screen,
      observedAt: new Date(now()).toISOString(),
    });
    return true;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((error) => logger?.warn?.(`snapshot poll failed: ${message(error)}`));
    }, intervalMs);
    // Never hold the process open purely to poll.
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { trackUser, activeUserIds, runOnce, start, stop, forgetEnvironment };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
