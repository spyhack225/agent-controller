import assert from "node:assert/strict";
import { createServer } from "node:http";
import { arch, cpus, platform, release, totalmem } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { createContainerServers } from "../src/containerServer.mjs";
import { createMemoryBackend, createRateLimiter } from "../src/rateLimit.mjs";

export const BETA_CAPACITY_BUDGET = Object.freeze({
  decisionStatus: "provisional-local-qualification-only",
  cloudAvailabilityTargetPercent: 99.5,
  cloudApiP95Ms: 500,
  commandAcceptanceP95Ms: 2_000,
  singletonContainer: Object.freeze({
    instanceType: "standard-1",
    maxInstances: 1,
    qualificationConcurrentRequests: 48,
    startupTimeoutMs: 20_000,
    responseHeaderTimeoutMs: 30_000,
    localFreshAdapterP95Ms: 2_000,
    localWarmAdapterRestartP95Ms: 1_000,
    localWarmPublicP95Ms: 100,
    localWarmPublicP99Ms: 250,
    localWarmPrivateP95Ms: 150,
    localWarmPrivateP99Ms: 300,
    localSaturatedP95Ms: 500,
    localSaturatedP99Ms: 1_000,
    localRssGrowthMiB: 64,
    localHeapGrowthMiB: 32,
    localCpuMsPerRequest: 20,
  }),
  environmentHub: Object.freeze({
    qualificationConcurrentEnvironments: 16,
    pendingRequests: 32,
    subscriptionLeases: 16,
    activeLongPollWaiters: 48,
    longPollMaxMs: 25_000,
    frameBytes: 1024 * 1024,
  }),
});

const DEFAULT_COLD_STARTS = 5;
const DEFAULT_WARM_SAMPLES = 100;
const DEFAULT_WARM_RESTARTS = 5;
const DEFAULT_SATURATION_BATCHES = 4;

export async function runLocalCapacityHarness({
  assertBudgets = false,
  coldStarts = DEFAULT_COLD_STARTS,
  warmSamples = DEFAULT_WARM_SAMPLES,
  warmRestarts = DEFAULT_WARM_RESTARTS,
  saturationBatches = DEFAULT_SATURATION_BATCHES,
} = {}) {
  const runAt = new Date().toISOString();
  const baselineMemory = process.memoryUsage();
  const coldStartMs = [];
  let runtime;

  for (let index = 0; index < coldStarts; index += 1) {
    const candidate = await createLocalRuntime(index);
    const startedAt = performance.now();
    await candidate.start();
    const response = await fetch(`${publicBase(candidate)}/health`);
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    coldStartMs.push(performance.now() - startedAt);
    if (runtime) await runtime.stop();
    runtime = candidate;
  }
  if (!runtime) throw new Error("capacity harness requires at least one cold start");

  try {
    const warmRestartMs = [];
    for (let index = 0; index < warmRestarts; index += 1) {
      await runtime.stop();
      const startedAt = performance.now();
      await runtime.start();
      const response = await fetch(`${publicBase(runtime)}/health`);
      await response.arrayBuffer();
      assert.equal(response.status, 200);
      warmRestartMs.push(performance.now() - startedAt);
    }

    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${publicBase(runtime)}/health`);
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }

    const warmPublicMs = [];
    for (let index = 0; index < warmSamples; index += 1) {
      warmPublicMs.push(await timedFetch(`${publicBase(runtime)}/health`));
    }

    const warmPrivateMs = [];
    for (let index = 0; index < warmSamples; index += 1) {
      warmPrivateMs.push(await timedFetch(
        `http://127.0.0.1:${runtime.internalPort}/v1/internal/background/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            taskId: `capacity_private_${index}`,
            kind: "maintenance.targets",
            payload: {},
          }),
        },
      ));
    }

    const saturationStartedAt = performance.now();
    const cpuStartedAt = process.cpuUsage();
    const loopStartedAt = performance.eventLoopUtilization();
    const saturatedMs = [];
    let peakRssBytes = process.memoryUsage().rss;
    let requestFailures = 0;
    const concurrency = BETA_CAPACITY_BUDGET.singletonContainer.qualificationConcurrentRequests;
    for (let batch = 0; batch < saturationBatches; batch += 1) {
      const results = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const startedAt = performance.now();
        const response = await fetch(`${publicBase(runtime)}/health?batch=${batch}&request=${index}`);
        await response.arrayBuffer();
        if (response.status !== 200) requestFailures += 1;
        return performance.now() - startedAt;
      }));
      saturatedMs.push(...results);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    const saturationDurationMs = performance.now() - saturationStartedAt;
    const cpu = process.cpuUsage(cpuStartedAt);
    const loop = performance.eventLoopUtilization(loopStartedAt);
    const finalMemory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, finalMemory.rss);
    const saturatedRequests = saturatedMs.length;
    const cpuMs = (cpu.user + cpu.system) / 1_000;

    const rateLimitRestart = await measureRateLimitRestartCaveat();
    const result = {
      schemaVersion: 1,
      runAt,
      scope: "local-node-adapter; not Cloudflare standard-1 or hosted capacity evidence",
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        hostMemoryMiB: bytesToMiB(totalmem()),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      budget: BETA_CAPACITY_BUDGET,
      workload: {
        coldStarts,
        warmRestarts,
        warmPublicRequests: warmPublicMs.length,
        warmPrivateRequests: warmPrivateMs.length,
        saturationBatches,
        concurrentRequestsPerBatch: concurrency,
        saturatedRequests,
      },
      results: {
        localFreshAdapterMs: distribution(coldStartMs),
        localWarmAdapterRestartMs: distribution(warmRestartMs),
        localWarmPublicHealthMs: distribution(warmPublicMs),
        localWarmPrivateCapabilityMs: distribution(warmPrivateMs),
        localSaturatedPublicHealthMs: distribution(saturatedMs),
        saturationDurationMs: round(saturationDurationMs),
        saturationRequestsPerSecond: round(saturatedRequests / (saturationDurationMs / 1_000)),
        requestFailures,
        processMemory: {
          baselineRssMiB: bytesToMiB(baselineMemory.rss),
          finalRssMiB: bytesToMiB(finalMemory.rss),
          peakRssMiB: bytesToMiB(peakRssBytes),
          rssGrowthMiB: bytesToMiB(Math.max(0, peakRssBytes - baselineMemory.rss)),
          baselineHeapUsedMiB: bytesToMiB(baselineMemory.heapUsed),
          finalHeapUsedMiB: bytesToMiB(finalMemory.heapUsed),
          heapGrowthMiB: bytesToMiB(Math.max(0, finalMemory.heapUsed - baselineMemory.heapUsed)),
        },
        processCpu: {
          userMs: round(cpu.user / 1_000),
          systemMs: round(cpu.system / 1_000),
          totalMs: round(cpuMs),
          msPerSaturatedRequest: round(cpuMs / saturatedRequests),
          eventLoopUtilization: round(loop.utilization, 6),
        },
        rateLimitRestart,
      },
      hostedDecisionGates: {
        standard1CpuAndMemory: "unmeasured-locally",
        cloudflareColdStartAndRollover: "staging-required",
        hostedConcurrentConnectionsAndLatency: "staging-required",
        monthlyCost: "staging-billing-observation-required",
        rateLimitDurability: "process-local counters reset on restart; shared backend required before max_instances > 1",
      },
    };

    if (assertBudgets) assertLocalBudgets(result);
    return result;
  } finally {
    await runtime.stop();
  }
}

export function assertLocalBudgets(report) {
  const budget = report.budget.singletonContainer;
  const results = report.results;
  assert.equal(results.requestFailures, 0, "saturated local Container adapter requests must all succeed");
  assert.ok(results.localFreshAdapterMs.p95 <= budget.localFreshAdapterP95Ms, "fresh local adapter p95 exceeded budget");
  assert.ok(results.localWarmAdapterRestartMs.p95 <= budget.localWarmAdapterRestartP95Ms, "warm local adapter restart p95 exceeded budget");
  assert.ok(results.localWarmPublicHealthMs.p95 <= budget.localWarmPublicP95Ms, "warm public p95 exceeded budget");
  assert.ok(results.localWarmPublicHealthMs.p99 <= budget.localWarmPublicP99Ms, "warm public p99 exceeded budget");
  assert.ok(results.localWarmPrivateCapabilityMs.p95 <= budget.localWarmPrivateP95Ms, "warm private p95 exceeded budget");
  assert.ok(results.localWarmPrivateCapabilityMs.p99 <= budget.localWarmPrivateP99Ms, "warm private p99 exceeded budget");
  assert.ok(results.localSaturatedPublicHealthMs.p95 <= budget.localSaturatedP95Ms, "saturated public p95 exceeded budget");
  assert.ok(results.localSaturatedPublicHealthMs.p99 <= budget.localSaturatedP99Ms, "saturated public p99 exceeded budget");
  assert.ok(results.processMemory.rssGrowthMiB <= budget.localRssGrowthMiB, "RSS growth exceeded local budget");
  assert.ok(results.processMemory.heapGrowthMiB <= budget.localHeapGrowthMiB, "heap growth exceeded local budget");
  assert.ok(results.processCpu.msPerSaturatedRequest <= budget.localCpuMsPerRequest, "CPU/request exceeded local budget");
  assert.equal(results.rateLimitRestart.processLocalLimitReached, true);
  assert.equal(results.rateLimitRestart.freshProcessAllowsSameKey, true);
  assert.equal(results.rateLimitRestart.sharedBackendPreservesLimit, true);
}

async function createLocalRuntime(index) {
  const internalPort = await freePort();
  return await createContainerServers({
    env: {
      DEPLOYMENT_ENVIRONMENT: "local",
      HOST: "127.0.0.1",
      PORT: "0",
      INTERNAL_HOST: "127.0.0.1",
      INTERNAL_PORT: String(internalPort),
      STORAGE_PROVIDER: "memory",
      AUTH_PROVIDER: "dev",
      ENABLE_DEV_TOKENS: "0",
      DISCOVERY_ENABLED: "0",
      SNAPSHOT_POLL_ENABLED: "0",
      THREAD_STREAM_ENABLED: "0",
      TRANSCRIPTION_WORKER_ENABLED: "0",
      DATA_FILE: `.data/capacity-never-written-${index}.json`,
    },
    logger: { info() {}, error() {} },
  });
}

async function measureRateLimitRestartCaveat() {
  const input = { key: "capacity:actor", limit: 2, windowMs: 60_000 };
  const firstProcess = createRateLimiter({ now: () => 1_000 });
  await firstProcess.check(input);
  await firstProcess.check(input);
  const blocked = await firstProcess.check(input);

  const restartedProcess = createRateLimiter({ now: () => 1_000 });
  const afterRestart = await restartedProcess.check(input);

  const sharedBackend = createMemoryBackend({ now: () => 1_000 });
  const firstInstance = createRateLimiter({ now: () => 1_000, backend: sharedBackend });
  const secondInstance = createRateLimiter({ now: () => 1_000, backend: sharedBackend });
  await firstInstance.check({ ...input, limit: 1 });
  const sharedSecond = await secondInstance.check({ ...input, limit: 1 });
  return {
    processLocalLimitReached: blocked.allowed === false,
    freshProcessAllowsSameKey: afterRestart.allowed === true,
    sharedBackendPreservesLimit: sharedSecond.allowed === false,
  };
}

async function timedFetch(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  return performance.now() - startedAt;
}

function publicBase(runtime) {
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("public Container adapter is not listening");
  return `http://127.0.0.1:${address.port}`;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a local port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function distribution(values) {
  return {
    count: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}

function bytesToMiB(bytes) {
  return round(bytes / (1024 * 1024));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await runLocalCapacityHarness({ assertBudgets: process.argv.includes("--assert") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
