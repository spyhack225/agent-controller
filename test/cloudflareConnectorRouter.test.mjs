import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { createCloudflareConnectorRouter } from "../src/cloudflareConnectorRouter.mjs";
import { ConnectorT3Transport } from "../src/t3Transport.mjs";

const environment = { id: "environment_contract", connectorId: "connector_contract", transportMode: "connector" };

test("Container connector router emits the CLI's canonical request methods and returns terminal results", async () => {
  const posted = [];
  const resultReads = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/v1/requests" && init.method === "POST") {
      posted.push(JSON.parse(init.body));
      return Response.json({ requestId: "request_contract", status: "dispatched", deadlineAt: Date.now() + 1_000 });
    }
    if (url.pathname.startsWith("/v1/requests/")) {
      resultReads.push(url);
      return Response.json({ status: "completed", result: { ok: true } });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
  };
  const router = createCloudflareConnectorRouter({ fetchImpl, randomUUID: () => "request_contract", pollIntervalMs: 1 });
  const transport = new ConnectorT3Transport(router);

  assert.deepEqual(await transport.snapshot(environment, { timeoutMs: 1_000 }), { ok: true });
  assert.equal(posted[0].request.method, "snapshot");
  assert.equal(posted[0].request.connectorId, "connector_contract");

  await transport.dispatch(environment, { type: "send_message" }, { timeoutMs: 1_000 });
  assert.equal(posted[1].request.method, "dispatch");
  assert.deepEqual(posted[1].request.payload, { command: { type: "send_message" } });

  await transport.callRpc(environment, "thread.list", { limit: 10 }, { timeoutMs: 1_000 });
  assert.equal(posted[2].request.method, "callRpc");
  assert.deepEqual(posted[2].request.payload, { tag: "thread.list", payload: { limit: 10 } });
  assert.equal(resultReads.length, 3, "each operation uses one bounded result wait after dispatch");
  assert.ok(resultReads.every((url) => Number(url.searchParams.get("waitMs")) >= 900));
});

test("Container connector request wait wakes at terminal state with O(1) private calls", async () => {
  let reads = 0;
  const startedAt = performance.now();
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/v1/requests" && init.method === "POST") {
        return Response.json({ requestId: "request_wait", status: "dispatched", deadlineAt: Date.now() + 30_000 });
      }
      if (url.pathname === "/v1/requests/request_wait") {
        reads += 1;
        assert.equal(url.searchParams.get("waitMs"), "25000");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ status: "completed", result: { woke: true } });
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "request_wait",
  });

  assert.deepEqual(await router.request(environment, { method: "snapshot", payload: {} }), { woke: true });
  assert.equal(reads, 1);
  assert.ok(performance.now() - startedAt < 250, "terminal delivery should not wait for the 25 second lease");
});

test("Container connector request cancellation aborts its wait and sends one durable cancel", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancels = 0;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/v1/requests" && init.method === "POST") {
        return Response.json({ requestId: "request_cancel", status: "dispatched", deadlineAt: Date.now() + 30_000 });
      }
      if (url.pathname.endsWith("/cancel") && init.method === "POST") {
        cancels += 1;
        return Response.json({ cancelled: true });
      }
      if (url.pathname === "/v1/requests/request_cancel") {
        reads += 1;
        return await pendingUntilAbort(init.signal);
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "request_cancel",
  });
  const operation = router.request(environment, { method: "snapshot", payload: {} }, { signal: controller.signal });
  await eventually(() => reads === 1);
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(cancels, 1, "request rejection waits for the bounded durable cancel attempt");
  assert.equal(reads, 1);
});

test("request cancellation bounds a stalled durable cancel attempt", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancels = 0;
  let cleanupAborts = 0;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/v1/requests" && init.method === "POST") {
        return Response.json({ requestId: "request_stalled_cancel", status: "dispatched", deadlineAt: Date.now() + 30_000 });
      }
      if (url.pathname.endsWith("/cancel") && init.method === "POST") {
        cancels += 1;
        init.signal?.addEventListener("abort", () => { cleanupAborts += 1; }, { once: true });
        return await pendingUntilAbort(init.signal);
      }
      if (url.pathname === "/v1/requests/request_stalled_cancel") {
        reads += 1;
        return await pendingUntilAbort(init.signal);
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "request_stalled_cancel",
  });
  const operation = router.request(environment, { method: "snapshot", payload: {} }, { signal: controller.signal });
  await eventually(() => reads === 1);
  const startedAt = performance.now();
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(cancels, 1);
  assert.equal(cleanupAborts, 1);
  assert.ok(performance.now() - startedAt < 500, "a stalled cleanup cannot hold cancellation open");
});

test("Container connector deadline bounds a stalled wait and terminalizes it through cancel", async () => {
  let reads = 0;
  let cancels = 0;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/v1/requests" && init.method === "POST") {
        return Response.json({ requestId: "request_timeout", status: "dispatched", deadlineAt: Date.now() + 1_000 });
      }
      if (url.pathname.endsWith("/cancel") && init.method === "POST") {
        cancels += 1;
        return Response.json({ cancelled: true });
      }
      if (url.pathname === "/v1/requests/request_timeout") {
        reads += 1;
        const waitMs = Number(url.searchParams.get("waitMs"));
        assert.ok(waitMs >= 1 && waitMs <= 1_000, "the long poll uses only the request deadline remaining after dispatch");
        return await pendingUntilAbort(init.signal);
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "request_timeout",
  });
  const startedAt = performance.now();
  await assert.rejects(
    router.request(environment, { method: "snapshot", payload: {} }, { timeoutMs: 1_000 }),
    (error) => error.code === "connector_timeout" && error.retryable === true,
  );
  assert.equal(cancels, 1, "deadline rejection waits for the bounded durable cancel attempt");
  assert.equal(reads, 1);
  assert.ok(performance.now() - startedAt < 1_300);
});

test("early-return retries remove abort listeners after every delay", async () => {
  let reads = 0;
  let deadlineSignal;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      deadlineSignal = init.signal;
      if (url.pathname === "/v1/requests" && init.method === "POST") {
        return Response.json({ requestId: "request_retries", status: "dispatched", deadlineAt: Date.now() + 1_000 });
      }
      if (url.pathname === "/v1/requests/request_retries") {
        reads += 1;
        return reads < 4
          ? Response.json({ status: "dispatched" })
          : Response.json({ status: "completed", result: { ok: true } });
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "request_retries",
    pollIntervalMs: 1,
  });

  assert.deepEqual(
    await router.request(environment, { method: "snapshot", payload: {} }, { timeoutMs: 1_000 }),
    { ok: true },
  );
  assert.equal(reads, 4);
  assert.equal(getEventListeners(deadlineSignal, "abort").length, 0);
});

test("Container connector router propagates revocation through the private virtual host", async () => {
  let seen;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      seen = { url: String(input), method: init.method, body: JSON.parse(init.body) };
      return Response.json({ revoked: true });
    },
  });
  await router.revoke({ environmentId: "environment_contract", connectorId: "connector_contract", reason: "owner_revoked" });
  assert.equal(new URL(seen.url).pathname, "/v1/revoke");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { environmentId: "environment_contract", connectorId: "connector_contract", reason: "owner_revoked" });
});

test("Container connector router returns a synchronous stream handle and deduplicates durable delivery pages", async () => {
  const calls = [];
  let handle;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/subscriptions" && init.method === "POST") return Response.json({ leaseId: "lease_contract" });
    if (url.pathname.startsWith("/v1/subscriptions/") && init.method === "DELETE") return Response.json({ closed: true });
    if (url.pathname.startsWith("/v1/subscriptions/")) {
      assert.equal(url.searchParams.get("waitMs"), "25000");
      return Response.json({ items: [
        { sequence: 1, value: { kind: "snapshot", snapshot: { id: "thread_contract" } } },
        { sequence: 1, value: { kind: "snapshot", snapshot: { duplicate: true } } },
        { sequence: 2, value: { kind: "event", event: { sequence: 42 } } },
      ] });
    }
    throw new Error("unexpected request");
  };
  const items = [];
  const router = createCloudflareConnectorRouter({ fetchImpl, randomUUID: () => "lease_contract", pollIntervalMs: 1 });
  handle = router.openThreadStream(environment, {
    threadId: "thread_contract",
    afterSequence: 41,
    onItem(item) {
      items.push(item);
      if (items.length === 2) handle.close();
    },
  });
  assert.equal(typeof handle.close, "function");
  await eventually(() => items.length === 2);
  assert.deepEqual(items.map((item) => item.kind), ["snapshot", "event"]);
  assert.ok(calls.includes("POST /v1/subscriptions"));
  await eventually(() => calls.includes("DELETE /v1/subscriptions/lease_contract"));
});

test("idle subscriptions hold one private read for the 25 second heartbeat interval", async () => {
  let reads = 0;
  let handle;
  const router = createCloudflareConnectorRouter({
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/v1/subscriptions" && init.method === "POST") return Response.json({ leaseId: "lease_idle" });
      if (url.pathname.endsWith("/lease_idle") && init.method === "DELETE") return Response.json({ closed: true });
      if (url.pathname.endsWith("/lease_idle")) {
        reads += 1;
        assert.equal(url.searchParams.get("waitMs"), "25000");
        return await pendingUntilAbort(init.signal);
      }
      throw new Error(`unexpected ${init.method ?? "GET"} ${url.pathname}`);
    },
    randomUUID: () => "lease_idle",
  });
  handle = router.openThreadStream(environment, { threadId: "thread_idle" });
  await eventually(() => reads === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 1, "an idle stream must not issue 100ms polling calls");
  await handle.close();
});

async function eventually(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not met");
}

async function pendingUntilAbort(signal) {
  return await new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
