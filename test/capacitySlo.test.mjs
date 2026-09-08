import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BETA_CAPACITY_BUDGET } from "../scripts/capacity-local.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("Cloudflare control plane stays a singleton standard-1 during the beta capacity decision", async () => {
  const wrangler = await readFile(join(ROOT, "cloudflare-control-plane/wrangler.jsonc"), "utf8");
  const instanceTypes = [...wrangler.matchAll(/"instance_type"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]);
  const maxInstances = [...wrangler.matchAll(/"max_instances"\s*:\s*(\d+)/gu)].map((match) => Number(match[1]));
  assert.deepEqual(instanceTypes, ["standard-1", "standard-1", "standard-1"]);
  assert.deepEqual(maxInstances, [1, 1, 1]);
  assert.equal(BETA_CAPACITY_BUDGET.singletonContainer.instanceType, "standard-1");
  assert.equal(BETA_CAPACITY_BUDGET.singletonContainer.maxInstances, 1);
});

test("the local capacity budget mirrors every per-environment hard bound", async () => {
  const [hub, protocol] = await Promise.all([
    readFile(join(ROOT, "cloudflare/src/hub.ts"), "utf8"),
    readFile(join(ROOT, "cloudflare/src/protocol.ts"), "utf8"),
  ]);
  const budget = BETA_CAPACITY_BUDGET.environmentHub;
  assert.match(protocol, new RegExp(`MAX_PENDING_REQUESTS = ${budget.pendingRequests}\\b`, "u"));
  assert.match(protocol, new RegExp(`MAX_CONNECTOR_FRAME_BYTES = ${budget.frameBytes / (1024 * 1024)}024 \\* 1024`, "u"));
  assert.match(hub, new RegExp(`MAX_SUBSCRIPTIONS = ${budget.subscriptionLeases}\\b`, "u"));
  assert.match(hub, /MAX_ACTIVE_LONG_POLLS = MAX_PENDING_REQUESTS \+ MAX_SUBSCRIPTIONS/u);
  assert.equal(budget.activeLongPollWaiters, budget.pendingRequests + budget.subscriptionLeases);
  assert.match(hub, /MAX_LONG_POLL_MS = 25_000\b/u);
});

test("CG-08 budget remains explicitly provisional until hosted capacity and cost are observed", async () => {
  assert.equal(BETA_CAPACITY_BUDGET.decisionStatus, "provisional-local-qualification-only");
  const docs = await readFile(join(ROOT, "docs/capacity-slo.md"), "utf8");
  assert.match(docs, /not a hosted-capacity claim/u);
  assert.match(docs, /Cloudflare billing observation/u);
  assert.match(docs, /process-local\s+counters reset/u);
  assert.match(docs, /RATE_LIMIT_REDIS_URL/u);
});
