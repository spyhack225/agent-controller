import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { useWorkspaceRecoveryMonitor } from "./useWorkspaceRecoveryMonitor";

afterEach(() => {
  vi.useRealTimers();
});

test("checks sequentially and reloads the workspace as soon as T3 becomes available", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const reloadWorkspace = vi.fn().mockResolvedValue(undefined);
  const onRecovered = vi.fn();

  const { result } = renderHook(() => useWorkspaceRecoveryMonitor({
    environmentId: "env_1",
    checkAvailability,
    reloadWorkspace,
    onRecovered,
    initialDelayMs: 25,
    intervalMs: 100,
  }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(25);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(1);
  expect(reloadWorkspace).not.toHaveBeenCalled();
  expect(result.current.checking).toBe(false);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(2);
  expect(reloadWorkspace).toHaveBeenCalledWith("env_1");
  expect(onRecovered).toHaveBeenCalledOnce();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(2);
});

test("stops checking when the recovery prompt closes", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn().mockResolvedValue(false);
  const { rerender } = renderHook(
    ({ environmentId }: { environmentId: string | null }) => useWorkspaceRecoveryMonitor({
      environmentId,
      checkAvailability,
      reloadWorkspace: vi.fn(),
      onRecovered: vi.fn(),
      initialDelayMs: 25,
      intervalMs: 100,
    }),
    { initialProps: { environmentId: "env_1" as string | null } },
  );

  rerender({ environmentId: null });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });

  expect(checkAvailability).not.toHaveBeenCalled();
});

test("backs off exponentially while the failure stays retryable", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn().mockResolvedValue(false);

  renderHook(() => useWorkspaceRecoveryMonitor({
    environmentId: "env_1",
    checkAvailability,
    reloadWorkspace: vi.fn(),
    onRecovered: vi.fn(),
    initialDelayMs: 25,
    intervalMs: 100,
    maxIntervalMs: 300,
  }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(25);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(1);

  // 100, then 200, then capped at 300.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(99);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(199);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(3);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(4);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(5);
});

test("never polls a failure the owner has to fix", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn().mockResolvedValue(false);

  const { result } = renderHook(() => useWorkspaceRecoveryMonitor({
    environmentId: "env_1",
    retryable: false,
    credentialKey: "epoch-0",
    checkAvailability,
    reloadWorkspace: vi.fn(),
    onRecovered: vi.fn(),
    initialDelayMs: 25,
    intervalMs: 100,
  }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(checkAvailability).not.toHaveBeenCalled();
  expect(result.current.checking).toBe(false);
});

test("resumes once for a replaced credential and pauses again if it is still refused", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn().mockResolvedValue(false);

  const { rerender } = renderHook(
    ({ credentialKey }: { credentialKey: string }) => useWorkspaceRecoveryMonitor({
      environmentId: "env_1",
      retryable: false,
      credentialKey,
      checkAvailability,
      reloadWorkspace: vi.fn(),
      onRecovered: vi.fn(),
      initialDelayMs: 25,
      intervalMs: 100,
    }),
    { initialProps: { credentialKey: "epoch-0" } },
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(checkAvailability).not.toHaveBeenCalled();

  rerender({ credentialKey: "epoch-1" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(checkAvailability).toHaveBeenCalledTimes(1);
});

test("recovers on the single probe a replaced credential earns", async () => {
  vi.useFakeTimers();
  const checkAvailability = vi.fn().mockResolvedValue(true);
  const reloadWorkspace = vi.fn().mockResolvedValue(undefined);
  const onRecovered = vi.fn();

  const { rerender } = renderHook(
    ({ credentialKey }: { credentialKey: string }) => useWorkspaceRecoveryMonitor({
      environmentId: "env_1",
      retryable: false,
      credentialKey,
      checkAvailability,
      reloadWorkspace,
      onRecovered,
      initialDelayMs: 25,
      intervalMs: 100,
    }),
    { initialProps: { credentialKey: "epoch-0" } },
  );

  rerender({ credentialKey: "epoch-1" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(25);
  });

  expect(reloadWorkspace).toHaveBeenCalledWith("env_1");
  expect(onRecovered).toHaveBeenCalledOnce();
});
