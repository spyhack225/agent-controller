// Fixed-window rate limiting behind a pluggable backend.
//
// The default backend counts in this process, which is correct for a single instance. Multi-process
// deployments pass a shared backend (see redisRateLimitBackend) so one window is enforced across
// every instance. `check` is async for that reason: callers must await it, or a limit breach turns
// into an unhandled rejection instead of a 429.
export function createRateLimiter({ now = () => Date.now(), backend = null } = {}) {
  const store = backend ?? createMemoryBackend({ now });

  async function check({ key, limit, windowMs }) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY, resetAt: null };
    }

    let bucket;
    try {
      bucket = await store.increment({ key: String(key), windowMs, now: now() });
    } catch {
      // A shared backend outage must not take the gateway down with it. Fail open, which
      // matches the single-process behaviour that existed before the backend was pluggable.
      return { allowed: true, limit, remaining: limit, resetAt: null, degraded: true };
    }

    if (bucket.count > limit) {
      return { allowed: false, limit, remaining: 0, resetAt: bucket.resetAt };
    }
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  async function reset() {
    await store.reset?.();
  }

  return { check, reset };
}

export function createMemoryBackend({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  return {
    async increment({ key, windowMs, now: at = now() }) {
      let bucket = buckets.get(key);
      if (!bucket || at >= bucket.resetAt) {
        bucket = { count: 0, resetAt: at + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return { count: bucket.count, resetAt: bucket.resetAt };
    },
    async reset() {
      buckets.clear();
    },
  };
}

/**
 * Shared backend over a Redis-compatible server, spoken as raw RESP so src/ stays dependency-free.
 *
 * Each window is one key incremented with INCR; the first increment sets PEXPIRE, so the window
 * starts at the first request and the key disappears on its own.
 */
export function createRedisBackend({ connect, keyPrefix = "agentctl:rl:" } = {}) {
  if (typeof connect !== "function") {
    throw new Error("createRedisBackend requires a connect() returning a RESP command runner.");
  }

  return {
    async increment({ key, windowMs, now: at }) {
      const window = Math.floor(at / windowMs);
      const redisKey = `${keyPrefix}${key}:${window}`;
      const client = await connect();
      const [count] = await client.pipeline([
        ["INCR", redisKey],
        ["PEXPIRE", redisKey, String(windowMs), "NX"],
      ]);
      return {
        count: Number(count),
        resetAt: (window + 1) * windowMs,
      };
    },
  };
}

export function loadRateLimitConfig(env = process.env) {
  const windowMs = intEnv(env, "RATE_LIMIT_WINDOW_MS", 60_000);
  return {
    windowMs,
    auth: intEnv(env, "AUTH_RATE_LIMIT", 30),
    factoryWrite: intEnv(env, "FACTORY_WRITE_RATE_LIMIT", 30),
    userRead: intEnv(env, "USER_READ_RATE_LIMIT", 240),
    userWrite: intEnv(env, "USER_WRITE_RATE_LIMIT", 60),
    deviceHeartbeat: intEnv(env, "DEVICE_HEARTBEAT_RATE_LIMIT", 120),
    deviceRead: intEnv(env, "DEVICE_READ_RATE_LIMIT", 120),
    deviceWrite: intEnv(env, "DEVICE_WRITE_RATE_LIMIT", 30),
    redisUrl: env.RATE_LIMIT_REDIS_URL ?? null,
  };
}

function intEnv(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? String(fallback), 10);
  return Number.isFinite(value) ? value : fallback;
}
