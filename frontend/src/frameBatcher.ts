/**
 * Coalesce high-frequency work into one callback per animation frame.
 *
 * Streaming agent output can arrive much faster than a display can paint. Buffering until the
 * next frame preserves every ordered delta while preventing one React commit per network frame.
 * The scheduler is injectable so the batching contract is deterministic in tests.
 */
export interface FrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface FrameBatcher<T> {
  push(value: T): void;
  /** Apply queued work immediately, preserving ordering before a snapshot/reset. */
  flush(): void;
  cancel(): void;
}

/**
 * A hidden tab may not receive an animation frame for minutes while its SSE connection keeps
 * delivering transcript deltas. Flush a bounded batch synchronously before that queue can grow
 * without limit. Every event is still applied in order; this is backpressure, not dropping.
 */
export const DEFAULT_MAX_FRAME_BATCH_SIZE = 256;

export function createFrameBatcher<T>(
  flush: (batch: readonly T[]) => void,
  scheduler: FrameScheduler = {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  },
  maxBatchSize = DEFAULT_MAX_FRAME_BATCH_SIZE,
): FrameBatcher<T> {
  const batchLimit = Number.isFinite(maxBatchSize)
    ? Math.max(1, Math.floor(maxBatchSize))
    : DEFAULT_MAX_FRAME_BATCH_SIZE;
  let queued: T[] = [];
  let frame: number | null = null;

  const flushQueued = () => {
    frame = null;
    const batch = queued;
    queued = [];
    if (batch.length > 0) flush(batch);
  };

  return {
    push(value) {
      queued.push(value);
      if (queued.length >= batchLimit) {
        if (frame !== null) scheduler.cancel(frame);
        flushQueued();
        return;
      }
      if (frame !== null) return;
      frame = scheduler.request(flushQueued);
    },
    flush() {
      if (frame !== null) scheduler.cancel(frame);
      flushQueued();
    },
    cancel() {
      queued = [];
      if (frame === null) return;
      scheduler.cancel(frame);
      frame = null;
    },
  };
}
