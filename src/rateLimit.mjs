export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  function check({ key, limit, windowMs }) {
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, limit: 0, remaining: Number.POSITIVE_INFINITY, resetAt: null };
    }

    const current = now();
    const bucketKey = String(key);
    let bucket = buckets.get(bucketKey);
    if (!bucket || current >= bucket.resetAt) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(bucketKey, bucket);
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  function reset() {
    buckets.clear();
  }

  return { check, reset };
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
  };
}

function intEnv(env, key, fallback) {
  const value = Number.parseInt(env[key] ?? String(fallback), 10);
  return Number.isFinite(value) ? value : fallback;
}
