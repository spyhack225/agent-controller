import { expect, test, vi } from "vitest";

import { createFrameBatcher, type FrameScheduler } from "./frameBatcher";

test("coalesces an event burst into one ordered animation-frame batch", () => {
  let callback: FrameRequestCallback = () => {
    throw new Error("frame callback was not scheduled");
  };
  const scheduler: FrameScheduler = {
    request: vi.fn((next) => {
      callback = next;
      return 17;
    }),
    cancel: vi.fn(),
  };
  const flush = vi.fn();
  const batcher = createFrameBatcher(flush, scheduler);

  for (let index = 0; index < 100; index += 1) batcher.push(index);

  expect(scheduler.request).toHaveBeenCalledTimes(1);
  expect(flush).not.toHaveBeenCalled();
  callback(16.7);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledWith(Array.from({ length: 100 }, (_, index) => index));
});

test("can flush immediately before an authoritative snapshot", () => {
  const scheduler: FrameScheduler = {
    request: vi.fn(() => 19),
    cancel: vi.fn(),
  };
  const flush = vi.fn();
  const batcher = createFrameBatcher(flush, scheduler);
  batcher.push("older event");

  batcher.flush();

  expect(scheduler.cancel).toHaveBeenCalledWith(19);
  expect(flush).toHaveBeenCalledWith(["older event"]);
});

test("cancels queued work when its stream is closed", () => {
  const scheduler: FrameScheduler = {
    request: vi.fn(() => 21),
    cancel: vi.fn(),
  };
  const flush = vi.fn();
  const batcher = createFrameBatcher(flush, scheduler);

  batcher.push("private transcript delta");
  batcher.cancel();

  expect(scheduler.cancel).toHaveBeenCalledWith(21);
  expect(flush).not.toHaveBeenCalled();
});

test("bounds a hidden-tab queue without dropping or reordering events", () => {
  const scheduler: FrameScheduler = {
    request: vi.fn(() => 23),
    cancel: vi.fn(),
  };
  const batches: number[][] = [];
  const batcher = createFrameBatcher<number>(
    (batch) => batches.push([...batch]),
    scheduler,
    3,
  );

  for (let index = 0; index < 8; index += 1) batcher.push(index);
  batcher.flush();

  expect(batches.map((batch) => batch.length)).toEqual([3, 3, 2]);
  expect(batches.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(scheduler.cancel).toHaveBeenCalledTimes(3);
});
