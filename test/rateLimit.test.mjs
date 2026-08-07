import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createMemoryBackend,
  createRateLimiter,
  createRedisBackend,
  loadRateLimitConfig,
} from "../src/rateLimit.mjs";
import { parseReply, parseRedisUrl } from "../src/resp.mjs";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("the in-process limiter allows up to the limit then refuses", async () => {
  let clock = 1_000;
  const limiter = createRateLimiter({ now: () => clock });
  const call = () => limiter.check({ key: "user:1", limit: 3, windowMs: 1000 });

  assert.equal((await call()).allowed, true);
  assert.equal((await call()).allowed, true);
  const third = await call();
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const fourth = await call();
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.remaining, 0);
  assert.equal(fourth.resetAt, 2000);
});

test("a new window restores the allowance", async () => {
  let clock = 1_000;
  const limiter = createRateLimiter({ now: () => clock });
  const call = () => limiter.check({ key: "user:1", limit: 1, windowMs: 1000 });

  assert.equal((await call()).allowed, true);
  assert.equal((await call()).allowed, false);

  clock += 1001;
  assert.equal((await call()).allowed, true);
});

test("keys are isolated from each other", async () => {
  const limiter = createRateLimiter();
  assert.equal((await limiter.check({ key: "a", limit: 1, windowMs: 1000 })).allowed, true);
  assert.equal((await limiter.check({ key: "a", limit: 1, windowMs: 1000 })).allowed, false);
  assert.equal((await limiter.check({ key: "b", limit: 1, windowMs: 1000 })).allowed, true);
});

test("a non-positive limit disables the check", async () => {
  const limiter = createRateLimiter();
  for (const limit of [0, -1, Number.NaN, undefined]) {
    const result = await limiter.check({ key: "k", limit, windowMs: 1000 });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, Number.POSITIVE_INFINITY);
  }
});

test("a shared backend outage fails open rather than locking everyone out", async () => {
  const limiter = createRateLimiter({
    backend: {
      increment: async () => {
        throw new Error("redis unreachable");
      },
    },
  });

  const result = await limiter.check({ key: "user:1", limit: 1, windowMs: 1000 });
  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true);
});

test("two limiter instances sharing a backend enforce one window", async () => {
  // This is the whole point of the pluggable backend: separate processes, one allowance.
  const shared = createMemoryBackend();
  const instanceA = createRateLimiter({ backend: shared });
  const instanceB = createRateLimiter({ backend: shared });

  assert.equal((await instanceA.check({ key: "user:1", limit: 2, windowMs: 1000 })).allowed, true);
  assert.equal((await instanceB.check({ key: "user:1", limit: 2, windowMs: 1000 })).allowed, true);
  assert.equal((await instanceB.check({ key: "user:1", limit: 2, windowMs: 1000 })).allowed, false);
  assert.equal((await instanceA.check({ key: "user:1", limit: 2, windowMs: 1000 })).allowed, false);
});

test("the redis backend issues INCR plus a first-write-only expiry", async () => {
  const issued = [];
  let counter = 0;
  const backend = createRedisBackend({
    connect: async () => ({
      pipeline: async (commands) => {
        issued.push(commands);
        counter += 1;
        return [counter, 1];
      },
    }),
  });

  const first = await backend.increment({ key: "user:read:u1", windowMs: 60_000, now: 120_000 });
  assert.equal(first.count, 1);
  // Window 2 of 60s ends at 180000.
  assert.equal(first.resetAt, 180_000);

  const [[incr, pexpire]] = issued;
  assert.deepEqual(incr, ["INCR", "agentctl:rl:user:read:u1:2"]);
  assert.deepEqual(pexpire, ["PEXPIRE", "agentctl:rl:user:read:u1:2", "60000", "NX"]);

  const second = await backend.increment({ key: "user:read:u1", windowMs: 60_000, now: 130_000 });
  assert.equal(second.count, 2, "the same window must keep counting up");
});

test("redis backend requires a connect factory", () => {
  assert.throws(() => createRedisBackend({}), /connect\(\)/u);
});

test("RESP replies parse, including partial buffers", () => {
  const parse = (text) => parseReply(Buffer.from(text, "utf8"), 0);

  assert.deepEqual(parse(":42\r\n"), { value: 42, offset: 5 });
  assert.equal(parse("+OK\r\n").value, "OK");
  assert.equal(parse("$5\r\nhello\r\n").value, "hello");
  assert.equal(parse("$-1\r\n").value, null);
  assert.deepEqual(parse("*2\r\n:1\r\n:2\r\n").value, [1, 2]);

  const error = parse("-ERR bad command\r\n").value;
  assert.ok(error instanceof Error);
  assert.equal(error.message, "ERR bad command");

  // Incomplete frames must report "not yet", never a wrong value.
  assert.equal(parse("$5\r\nhel"), null);
  assert.equal(parse(":42"), null);
  assert.equal(parse("*2\r\n:1\r\n"), null);
});

test("redis URLs resolve host, port and TLS", () => {
  assert.deepEqual(parseRedisUrl("redis://127.0.0.1:6379"), {
    host: "127.0.0.1",
    port: 6379,
    tls: false,
  });
  assert.deepEqual(parseRedisUrl("rediss://cache.example.com"), {
    host: "cache.example.com",
    port: 6379,
    tls: true,
  });
  assert.throws(() => parseRedisUrl(null), /Redis URL is required/u);
});

test("the rate limit config exposes a shared-store URL", () => {
  assert.equal(loadRateLimitConfig({}).redisUrl, null);
  assert.equal(
    loadRateLimitConfig({ RATE_LIMIT_REDIS_URL: "redis://cache:6379" }).redisUrl,
    "redis://cache:6379",
  );
});

// Guard rail. rateLimiter.check is async, so an un-awaited enforce* call would neither block the
// request nor return 429 — it would silently pass and then crash the process on the rejection.
test("every rate limit enforcement in app.mjs is awaited", async () => {
  const source = await readFile(join(SRC_DIR, "app.mjs"), "utf8");
  const lines = source.split("\n");
  const callPattern = /(^|[^a-zA-Z_.])(enforce[A-Za-z]+)\s*\(/u;

  const offenders = [];
  lines.forEach((line, index) => {
    const match = line.match(callPattern);
    if (!match) return;
    if (/^\s*(async )?function /u.test(line)) return; // declaration, not a call
    if (/await\s+enforce[A-Za-z]+\s*\(/u.test(line)) return;
    offenders.push(`${index + 1}: ${line.trim()}`);
  });

  assert.deepEqual(offenders, [], "these enforcement calls are missing await");
});
