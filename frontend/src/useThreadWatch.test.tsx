import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { ApiOptions } from "./api";
import { useThreadWatch } from "./useThreadWatch";

afterEach(() => {
  vi.useRealTimers();
});

const WATCH_PATH = "/v1/t3/environments/env_1/threads/thread_1/watch";
const OTHER_PATH = "/v1/t3/environments/env_1/threads/thread_2/watch";

function recordingApi() {
  const calls: { path: string; options: ApiOptions }[] = [];
  const api = vi.fn(async (path: string, options: ApiOptions = {}) => {
    calls.push({ path, options });
    return { watch: { state: "connecting", sequence: null } } as never;
  });
  return { api: api as unknown as <T>(path: string, options?: ApiOptions) => Promise<T>, calls };
}

function methods(calls: { path: string; options: ApiOptions }[], method: string) {
  return calls.filter((call) => call.options.method === method).map((call) => call.path);
}

test("registers a watch when a thread goes on screen and releases it when it leaves", async () => {
  const { api, calls } = recordingApi();
  const { result, unmount } = renderHook(() => useThreadWatch({ api, enabled: true }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  expect(methods(calls, "POST")).toEqual([WATCH_PATH]);
  expect(result.current.liveThread?.threadId).toBe("thread_1");

  await act(async () => {
    unmount();
  });
  expect(methods(calls, "DELETE")).toEqual([WATCH_PATH]);
});

test("renews the lease on a timer while the view stays open", async () => {
  vi.useFakeTimers();
  const { api, calls } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true, renewIntervalMs: 1000 }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  expect(methods(calls, "POST")).toHaveLength(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  // The lease is 90s; three renewals inside it is what keeps the socket from being dropped.
  expect(methods(calls, "POST")).toHaveLength(4);
});

test("stops renewing once the thread is no longer being viewed", async () => {
  vi.useFakeTimers();
  const { api, calls } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true, renewIntervalMs: 1000 }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(methods(calls, "POST")).toHaveLength(2);

  await act(async () => {
    result.current.watchThread(null);
  });
  expect(methods(calls, "DELETE")).toEqual([WATCH_PATH]);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(methods(calls, "POST")).toHaveLength(2);
  expect(result.current.liveThread).toBeNull();
});

test("moves the watch when another thread is selected", async () => {
  const { api, calls } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_2" });
  });

  expect(methods(calls, "DELETE")).toEqual([WATCH_PATH]);
  expect(methods(calls, "POST")).toEqual([WATCH_PATH, OTHER_PATH]);
  expect(result.current.liveThread?.threadId).toBe("thread_2");
  // The previous thread's transcript is gone, not left on screen under a new heading.
  expect(result.current.liveThread?.entries).toEqual([]);
});

test("re-declaring the same thread does not re-register the lease", async () => {
  const { api, calls } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });

  expect(methods(calls, "POST")).toEqual([WATCH_PATH]);
  expect(methods(calls, "DELETE")).toEqual([]);
});

test("a closing tab gets one keepalive release, because a normal fetch would not survive it", async () => {
  const { api, calls } = recordingApi();
  renderHookWithWatch(api);

  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });

  const release = calls.find((call) => call.options.method === "DELETE");
  expect(release?.path).toBe(WATCH_PATH);
  expect(release?.options.keepalive).toBe(true);
});

function renderHookWithWatch(api: <T>(path: string, options?: ApiOptions) => Promise<T>) {
  const rendered = renderHook(() => useThreadWatch({ api, enabled: true }));
  act(() => {
    rendered.result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  return rendered;
}

test("registers nothing while signed out", async () => {
  const { api, calls } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: false }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });

  expect(calls).toEqual([]);
  expect(result.current.liveThread).toBeNull();
});

test("says the thread is not live when the watch cannot be registered at all", async () => {
  const api = vi.fn(async () => {
    throw new Error("Environment not found.");
  }) as unknown as <T>(path: string, options?: ApiOptions) => Promise<T>;
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });

  expect(result.current.liveThread?.status).toBe("stopped");
  expect(result.current.liveThread?.statusError).toBe("Environment not found.");
});

test("a renewal that fails inside the lease does not tear down a working view", async () => {
  vi.useFakeTimers();
  let call = 0;
  const api = vi.fn(async () => {
    call += 1;
    if (call === 1) return { watch: { state: "live", sequence: 10 } } as never;
    throw new Error("Too many requests.");
  }) as unknown as <T>(path: string, options?: ApiOptions) => Promise<T>;
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true, renewIntervalMs: 1000 }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });
  expect(result.current.liveThread?.status).toBe("live");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.liveThread?.status).toBe("live");
});

test("applies the three stream events, and only for the thread being watched", async () => {
  const { api } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true }));

  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });

  await act(async () => {
    result.current.applyThreadSnapshotEvent({
      environmentId: "env_1",
      threadId: "thread_1",
      reset: true,
      gap: false,
      snapshotSequence: 10,
      thread: { id: "thread_1", messages: [], activities: [], session: null },
    });
    result.current.applyThreadStatusEvent({
      environmentId: "env_1",
      threadId: "thread_1",
      state: "live",
      sequence: 10,
    });
  });
  expect(result.current.liveThread?.status).toBe("live");
  expect(result.current.liveThread?.hasSnapshot).toBe(true);

  await act(async () => {
    // Another tab on the same account, watching a different thread, publishes onto this stream too.
    result.current.applyThreadEventEvent({
      environmentId: "env_1",
      threadId: "thread_2",
      sequence: 11,
      eventId: "evt_11",
      type: "thread.message-sent",
      event: {
        type: "thread.message-sent",
        payload: { messageId: "msg_other", role: "assistant", text: "not yours", streaming: false },
      },
    });
  });
  expect(result.current.liveThread?.entries).toEqual([]);

  await act(async () => {
    result.current.applyThreadEventEvent({
      environmentId: "env_1",
      threadId: "thread_1",
      sequence: 11,
      eventId: "evt_11",
      type: "thread.message-sent",
      event: {
        type: "thread.message-sent",
        payload: { messageId: "msg_1", role: "assistant", text: "yours", streaming: false },
      },
    });
  });
  expect(result.current.liveThread?.entries).toHaveLength(1);
});

test("reduces one display-frame event batch through a single ordered state update", async () => {
  const { api } = recordingApi();
  const { result } = renderHook(() => useThreadWatch({ api, enabled: true }));
  await act(async () => {
    result.current.watchThread({ environmentId: "env_1", threadId: "thread_1" });
  });

  await act(async () => {
    result.current.applyThreadEventEvents(Array.from({ length: 80 }, (_, index) => ({
      environmentId: "env_1",
      threadId: "thread_1",
      sequence: index + 1,
      eventId: `evt_${index + 1}`,
      type: "thread.message-sent",
      event: {
        type: "thread.message-sent",
        payload: {
          messageId: "msg_stream",
          role: "assistant",
          text: String(index % 10),
          streaming: true,
        },
      },
    })));
  });

  expect(result.current.liveThread?.entries).toHaveLength(1);
  expect(result.current.liveThread?.entries[0]).toMatchObject({
    kind: "message",
    text: Array.from({ length: 80 }, (_, index) => String(index % 10)).join(""),
  });
});
