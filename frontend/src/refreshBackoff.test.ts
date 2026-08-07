import { vi } from "vitest";

import { ApiError, requestJson } from "./api";

// Regression for the dashboard hammering the gateway: a 429 rejected the whole Promise.all,
// produced an unhandled rejection, and the next state.changed immediately retried all nine
// requests with no backoff.

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("a 429 surfaces retry-after so the client can back off", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => jsonResponse(
    { error: { message: "Rate limit exceeded." } },
    429,
    { "retry-after": "17" },
  )) as unknown as typeof fetch;

  try {
    await expect(requestJson("/v1/devices")).rejects.toBeInstanceOf(ApiError);
    try {
      await requestJson("/v1/devices");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(429);
      expect(apiError.retryAfterSeconds).toBe(17);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("a response without retry-after reports null rather than a bogus number", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => jsonResponse(
    { error: { message: "Rate limit exceeded." } },
    429,
  )) as unknown as typeof fetch;

  try {
    await requestJson("/v1/devices");
  } catch (error) {
    expect((error as ApiError).retryAfterSeconds).toBeNull();
  } finally {
    globalThis.fetch = original;
  }
});

test("one throttled endpoint does not discard the other responses", async () => {
  // allSettled is what lets a partial refresh still render; Promise.all threw everything away.
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path.includes("/v1/audit")) {
      return jsonResponse({ error: { message: "Rate limit exceeded." } }, 429, { "retry-after": "5" });
    }
    return jsonResponse({ devices: [{ id: "dev_1" }] });
  }) as unknown as typeof fetch;

  try {
    const results = await Promise.allSettled([
      requestJson<{ devices: unknown[] }>("/v1/devices"),
      requestJson("/v1/audit"),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");

    const throttled = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .find((reason) => reason instanceof ApiError && reason.status === 429) as ApiError;
    expect(throttled.retryAfterSeconds).toBe(5);
    expect(calls).toHaveLength(2);
  } finally {
    globalThis.fetch = original;
  }
});
