const DEFAULT_LIMIT = 100;

// User-scoped for the same reason as media retention: cloud Cron fans out durable owner ids and
// this runner never performs a cross-tenant scan. Purging removes only the environment tombstone;
// immutable command/audit history and user-owned media keep their own retention policies.
export function createEnvironmentRetentionRunner({ store, limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  if (!store) throw new Error("A Store is required for environment retention.");

  async function runOnce({ userId, checkedAt = new Date(now()).toISOString() } = {}) {
    if (typeof userId !== "string" || !userId) throw terminalError("environment_retention_user_required");
    const expired = await store.listExpiredEnvironments({ userId, now: checkedAt });
    const purged = [];
    for (const environment of (expired ?? []).slice(0, normalizeLimit(limit))) {
      const result = await store.purgeEnvironment({ userId, environmentId: environment.id, now: checkedAt });
      if (result && !result.notDue) purged.push(result.environment);
    }
    return {
      purged,
      count: purged.length,
      hasMore: (expired?.length ?? 0) > normalizeLimit(limit),
      checkedAt,
    };
  }

  return { runOnce };
}

function normalizeLimit(value) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(500, value)) : DEFAULT_LIMIT;
}

function terminalError(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}
