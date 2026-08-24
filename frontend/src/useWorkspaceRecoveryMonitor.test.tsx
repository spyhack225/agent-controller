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
