/**
 * The demand side of a live thread subscription.
 *
 * The gateway opens exactly one WebSocket to T3 per thread somebody says they are watching, and
 * "says they are watching" is a LEASE, not a registration (`src/threadStream.mjs`,
 * docs/api.md "Live Thread Streams"): `POST .../watch` registers *and* renews with a 90s TTL, and
 * the subscription is dropped on the first tick after the lease lapses.
 *
 * That shape decides everything here:
 *
 *   REGISTER   when a thread is on screen. `watchThread(target)` is what the Operate view calls;
 *              it is idempotent, so re-rendering costs nothing.
 *   RENEW      on a timer comfortably inside the lease. Stop renewing and the socket goes away on
 *              its own — which is why a crashed tab needs no cleanup at all.
 *   RELEASE    `DELETE .../watch` on unmount, on navigation, and on selecting another thread. This
 *              is politeness, not correctness: it returns the socket in a second instead of in a
 *              TTL.
 *
 * A CLOSING TAB is the case worth being precise about. `pagehide` fires, and the release is
 * attempted with `keepalive` so the browser is allowed to finish it after the document is gone.
 * It is best-effort by nature — the Clerk session token is fetched per request and that fetch may
 * not resolve before the process does — so the lease, not this handler, is the guarantee. A leaked
 * watch costs one TTL and no more.
 *
 * The three `t3.thread.*` SSE events are fanned in here through `apply*`; the EventSource itself
 * stays in `useController()` with every other subscriber, because there is only one stream.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiOptions } from "./api";
import {
  applyThreadEvent,
  applyThreadSnapshot,
  applyThreadStatus,
  applyWatchFailure,
  applyWatchRecord,
  createLiveThreadState,
  isSameThreadTarget,
  payloadMatchesThread,
  type LiveThreadState,
  type LiveThreadTarget,
} from "./liveThread";

/** Comfortably inside the gateway's default 90s lease, with room for one lost request. */
export const THREAD_WATCH_RENEW_MS = 30_000;

type ApiFn = <T>(path: string, options?: ApiOptions) => Promise<T>;

export interface ThreadWatchOptions {
  api: ApiFn;
  /** No watch is registered while signed out; the route is platform-user realm. */
  enabled: boolean;
  renewIntervalMs?: number;
}

export interface ThreadWatch {
  liveThread: LiveThreadState | null;
  /** Declare the thread being viewed, or null when none is. Stable identity, safe in an effect. */
  watchThread: (target: LiveThreadTarget | null) => void;
  applyThreadSnapshotEvent: (payload: unknown) => void;
  applyThreadEventEvent: (payload: unknown) => void;
  /** Apply one display-frame batch with a single React state transition. */
  applyThreadEventEvents: (payloads: readonly unknown[]) => void;
  applyThreadStatusEvent: (payload: unknown) => void;
}

function watchPath({ environmentId, threadId }: LiveThreadTarget): string {
  return `/v1/t3/environments/${encodeURIComponent(environmentId)}`
    + `/threads/${encodeURIComponent(threadId)}/watch`;
}

export function useThreadWatch({
  api,
  enabled,
  renewIntervalMs = THREAD_WATCH_RENEW_MS,
}: ThreadWatchOptions): ThreadWatch {
  const [target, setTarget] = useState<LiveThreadTarget | null>(null);
  const [liveThread, setLiveThread] = useState<LiveThreadState | null>(null);
  // `api` is rebuilt whenever the Clerk bridge changes identity. Reading it through a ref keeps
  // that from tearing down a healthy subscription and re-registering it.
  const apiRef = useRef(api);
  apiRef.current = api;

  const watchThread = useCallback((next: LiveThreadTarget | null) => {
    const normalized = next?.environmentId && next?.threadId
      ? { environmentId: next.environmentId, threadId: next.threadId }
      : null;
    setTarget((current) => isSameThreadTarget(current, normalized) ? current : normalized);
  }, []);

  useEffect(() => {
    if (!target) {
      setLiveThread(null);
      return;
    }
    if (!enabled) {
      setLiveThread(null);
      return;
    }

    setLiveThread(createLiveThreadState(target));
    const path = watchPath(target);
    let cancelled = false;
    let registered = false;

    const renew = async () => {
      try {
        const result = await apiRef.current<{ watch?: unknown }>(path, { method: "POST" });
        if (cancelled) return;
        registered = true;
        setLiveThread((current) => current && isSameThreadTarget(current, target)
          ? applyWatchRecord(current, result?.watch)
          : current);
      } catch (error) {
        if (cancelled) return;
        // Renewals that fail after a good registration are not fatal on their own — the next tick
        // may succeed inside the lease — so only an unregistered watch is reported as stopped.
        if (registered) return;
        const message = error instanceof Error ? error.message : "Could not watch this thread.";
        setLiveThread((current) => current && isSameThreadTarget(current, target)
          ? applyWatchFailure(current, message)
          : current);
      }
    };

    const release = (keepalive: boolean) => {
      void apiRef.current(path, { method: "DELETE", keepalive }).catch(() => {
        // The lease expires on its own within one TTL. There is nothing to recover here.
      });
    };

    void renew();
    const timer = window.setInterval(() => {
      void renew();
    }, renewIntervalMs);

    // A closing tab gets one best-effort release; the lease covers the case where it does not land.
    const onPageHide = () => release(true);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      release(false);
    };
  }, [enabled, renewIntervalMs, target]);

  const applyIfCurrent = useCallback((
    payload: unknown,
    reducer: (state: LiveThreadState, payload: unknown) => LiveThreadState,
  ) => {
    setLiveThread((current) => {
      // The broker is user-scoped: a second tab watching another thread publishes here too.
      if (!payloadMatchesThread(current, payload)) return current;
      return reducer(current as LiveThreadState, payload);
    });
  }, []);

  const applyThreadSnapshotEvent = useCallback(
    (payload: unknown) => applyIfCurrent(payload, applyThreadSnapshot),
    [applyIfCurrent],
  );
  const applyThreadEventEvent = useCallback(
    (payload: unknown) => applyIfCurrent(payload, applyThreadEvent),
    [applyIfCurrent],
  );
  const applyThreadEventEvents = useCallback((payloads: readonly unknown[]) => {
    if (payloads.length === 0) return;
    setLiveThread((current) => payloads.reduce<LiveThreadState | null>((state, payload) => {
      if (!payloadMatchesThread(state, payload)) return state;
      return applyThreadEvent(state as LiveThreadState, payload);
    }, current));
  }, []);
  const applyThreadStatusEvent = useCallback(
    (payload: unknown) => applyIfCurrent(payload, applyThreadStatus),
    [applyIfCurrent],
  );

  return {
    liveThread,
    watchThread,
    applyThreadSnapshotEvent,
    applyThreadEventEvent,
    applyThreadEventEvents,
    applyThreadStatusEvent,
  };
}
