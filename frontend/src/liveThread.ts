/**
 * The console's view of a live T3 thread.
 *
 * The gateway subscribes to T3's `orchestration.subscribeThread` and republishes it through the
 * existing SSE broker as three events (`src/threadStream.mjs`, docs/api.md "Live Thread Streams"):
 *
 *   t3.thread.snapshot   the whole thread, and an instruction to start from it
 *   t3.thread.event      one T3 orchestration event, in order
 *   t3.thread.status     connecting | resuming | live | reconnecting | stopped
 *
 * Everything in this file is a pure function over that stream. No fetch, no timer, no React — the
 * hook in `useThreadWatch.ts` owns those, and this owns the part that is easy to get wrong.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE THINGS THAT ARE EASY TO GET WRONG
 * ---------------------------------------------------------------------------------------------
 *
 * 1. A STREAMING `thread.message-sent` IS A DELTA, NOT THE MESSAGE.
 *
 *    T3's own projector appends it (`packages/.../projector.ts:497-515`). Rendering `payload.text`
 *    as the message body shows the last few tokens of every reply and nothing else. So a streaming
 *    frame is accumulated onto the entry with the same `messageId`, and only a terminal frame
 *    (`streaming: false`) replaces the body — and even then only when it carries text, because an
 *    empty terminal frame means "keep what you have".
 *
 * 2. A SNAPSHOT REPLACES; IT NEVER APPENDS.
 *
 *    `reset` is always true on a snapshot. `gap: true` additionally means T3 abandoned an
 *    unfillable replay: nothing is lost from the *current state* — the snapshot is the thread in
 *    full — but the individual events between the old cursor and now were never delivered.
 *    Appending would duplicate the entire transcript, so `applyThreadSnapshot` rebuilds `entries`
 *    from the snapshot and clears the dedup memory with it. `historyGap` is how the reader is told
 *    that intermediate steps are missing, rather than being shown a seamless-looking lie.
 *
 * 3. THE SAME EVENT CAN ARRIVE TWICE.
 *
 *    The replay window and the live subscription overlap by design (the gateway's own doc comment),
 *    and an `EventSource` that reconnects can re-deliver as well. Dedup is on the global
 *    `sequence`, falling back to `eventId` where a sequence is absent, remembered in a bounded ring
 *    so a long-lived thread does not grow an unbounded key set.
 *
 *    The ring — not a "greater than the cursor" test — is the dedup, because arrival order is not
 *    assumed to be monotonic. The cursor is used for exactly two things it can be trusted for: as
 *    the floor established by a snapshot (an event at or below `baseSequence` is already *in* the
 *    snapshot), and as a horizon older than the ring can remember.
 */

import {
  collectProviderApprovals,
  foldApprovalActivity,
  type ProviderApproval,
} from "./providerApprovals";

export const LIVE_THREAD_SEEN_LIMIT = 512;

/** The five states `t3.thread.status` reports, plus the one before anything has been said. */
export type LiveThreadStatus =
  | "idle"
  | "connecting"
  | "resuming"
  | "live"
  | "reconnecting"
  | "stopped";

export type LiveThreadRole = "user" | "assistant" | "system" | "tool";

export type LiveThreadTone = "info" | "tool" | "approval" | "error";

interface LiveThreadEntryBase {
  /** Stable across updates; the React key and the upsert key. */
  key: string;
  /** ISO timestamp used to interleave snapshot entries. Null when T3 did not give one. */
  at: string | null;
  /** Arrival order, so entries without a timestamp keep a stable position. */
  order: number;
}

export interface LiveThreadMessageEntry extends LiveThreadEntryBase {
  kind: "message";
  id: string;
  role: LiveThreadRole;
  text: string;
  /** True while deltas are still arriving for this message. */
  streaming: boolean;
  turnId: string | null;
}

export interface LiveThreadActivityEntry extends LiveThreadEntryBase {
  kind: "activity";
  id: string;
  tone: LiveThreadTone;
  /** T3's own activity kind, e.g. `tool.started`, `approval.requested`. */
  activityKind: string;
  summary: string;
  turnId: string | null;
}

export interface LiveThreadTurnEntry extends LiveThreadEntryBase {
  kind: "turn";
  turnId: string;
  /** The checkpoint status T3 reports: ready | missing | error. */
  status: string;
  files: { path: string; additions: number; deletions: number }[];
}

export interface LiveThreadPlanEntry extends LiveThreadEntryBase {
  kind: "plan";
  id: string;
  planMarkdown: string;
  turnId: string | null;
}

export interface LiveThreadNoteEntry extends LiveThreadEntryBase {
  kind: "note";
  id: string;
  summary: string;
}

export type LiveThreadEntry =
  | LiveThreadMessageEntry
  | LiveThreadActivityEntry
  | LiveThreadTurnEntry
  | LiveThreadPlanEntry
  | LiveThreadNoteEntry;

export interface LiveThreadState {
  environmentId: string;
  threadId: string;
  status: LiveThreadStatus;
  /** False until a snapshot arrives. Before that there is no live transcript to render. */
  hasSnapshot: boolean;
  /** True when the last snapshot arrived in place of a replay T3 could not fill. */
  historyGap: boolean;
  /** True when the snapshot was windowed and older history was never sent. */
  historyTruncated: boolean;
  entries: LiveThreadEntry[];
  /**
   * Provider approvals — the questions T3 asks mid-turn, not the gateway policy holds. Derived
   * from the same activity rows the transcript is built from, because a pending approval IS an
   * activity; see `frontend/src/providerApprovals.ts`. Kept as its own field rather than filtered
   * out of `entries` at render time, because an entry drops the payload (and with it the
   * requestId) and there would be nothing left to answer with.
   */
  approvals: ProviderApproval[];
  /** Highest sequence seen. Display and diagnostics only — dedup is `seen`. */
  sequence: number | null;
  /** The sequence the current snapshot represents; anything at or below it is already applied. */
  baseSequence: number | null;
  sessionStatus: string | null;
  activeTurnId: string | null;
  sessionError: string | null;
  /** Reconnect detail, straight off `t3.thread.status`. */
  attempt: number;
  retryInMs: number | null;
  statusError: string | null;
  stoppedReason: string | null;
  /** When the gateway observed the most recent frame for this thread. */
  observedAt: string | null;
  /** Bounded ring of dedup keys, oldest first. */
  seen: string[];
  order: number;
}

export interface LiveThreadTarget {
  environmentId: string;
  threadId: string;
}

export function createLiveThreadState({ environmentId, threadId }: LiveThreadTarget): LiveThreadState {
  return {
    environmentId,
    threadId,
    status: "idle",
    hasSnapshot: false,
    historyGap: false,
    historyTruncated: false,
    entries: [],
    approvals: [],
    sequence: null,
    baseSequence: null,
    sessionStatus: null,
    activeTurnId: null,
    sessionError: null,
    attempt: 0,
    retryInMs: null,
    statusError: null,
    stoppedReason: null,
    observedAt: null,
    seen: [],
    order: 0,
  };
}

export function isSameThreadTarget(
  left: LiveThreadTarget | null,
  right: LiveThreadTarget | null,
): boolean {
  if (!left || !right) return left === right;
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/** True only when the transcript on screen is provably current. */
export function liveThreadIsCurrent(state: LiveThreadState | null): boolean {
  return Boolean(state && state.hasSnapshot && state.status === "live");
}

/** True while a turn is running: T3 holds an active turn, or a reply is still arriving. */
export function liveThreadTurnInFlight(state: LiveThreadState | null): boolean {
  if (!state) return false;
  if (state.activeTurnId) return true;
  return state.entries.some((entry) => entry.kind === "message" && entry.streaming);
}

/**
 * Does this SSE payload belong to the thread this state is tracking? Every apply* function asks
 * first: the broker is user-scoped, so a second console tab watching a different thread on the
 * same account publishes onto the same stream.
 */
export function payloadMatchesThread(state: LiveThreadState | null, payload: unknown): boolean {
  if (!state) return false;
  const record = asRecord(payload);
  if (!record) return false;
  return record.environmentId === state.environmentId && record.threadId === state.threadId;
}

// ---------------------------------------------------------------------------------------------
// t3.thread.snapshot
// ---------------------------------------------------------------------------------------------

export function applyThreadSnapshot(state: LiveThreadState, payload: unknown): LiveThreadState {
  const record = asRecord(payload);
  if (!record) return state;
  const thread = asRecord(record.thread);
  const page = asRecord(record.page);
  const snapshotSequence = numberOrNull(record.snapshotSequence);

  // REPLACE. A snapshot is T3 saying "start from this", so the previous transcript — and the
  // dedup memory that only makes sense relative to it — is discarded rather than appended to.
  const built = buildSnapshotEntries(thread);
  const session = asRecord(thread?.session);

  return {
    ...state,
    hasSnapshot: true,
    historyGap: record.gap === true,
    historyTruncated: page?.hasMore === true,
    entries: built.entries,
    order: built.order,
    // REPLACE, like the transcript: the snapshot is the thread's approval state in full, and an
    // approval carried over from a stale transcript is a card offering to answer a dead request.
    approvals: collectProviderApprovals(thread, state.threadId),
    sequence: snapshotSequence,
    baseSequence: snapshotSequence,
    seen: [],
    sessionStatus: stringOrNull(session?.status),
    activeTurnId: stringOrNull(session?.activeTurnId),
    sessionError: stringOrNull(session?.lastError),
    observedAt: stringOrNull(record.observedAt) ?? state.observedAt,
  };
}

function buildSnapshotEntries(thread: Record<string, unknown> | null): {
  entries: LiveThreadEntry[];
  order: number;
} {
  const staged: { entry: LiveThreadEntry; time: number }[] = [];

  const stage = (entry: LiveThreadEntry) => {
    staged.push({ entry, time: timeOf(entry.at) });
  };

  for (const raw of asArray(thread?.messages)) {
    const entry = messageEntryFrom(raw);
    if (entry) stage(entry);
  }
  for (const raw of asArray(thread?.activities)) {
    const entry = activityEntryFrom(raw);
    if (entry) stage(entry);
  }
  for (const raw of asArray(thread?.proposedPlans)) {
    const entry = planEntryFrom(raw);
    if (entry) stage(entry);
  }
  for (const raw of asArray(thread?.checkpoints)) {
    const entry = turnEntryFrom(raw);
    if (entry) stage(entry);
  }

  // Array.prototype.sort is stable, so entries T3 gave no timestamp for keep the order above.
  staged.sort((left, right) => left.time - right.time);
  const entries = staged.map(({ entry }, index) => ({ ...entry, order: index }));
  return { entries, order: entries.length };
}

// ---------------------------------------------------------------------------------------------
// t3.thread.event
// ---------------------------------------------------------------------------------------------

export function applyThreadEvent(state: LiveThreadState, payload: unknown): LiveThreadState {
  const record = asRecord(payload);
  if (!record) return state;

  const sequence = numberOrNull(record.sequence);
  const eventId = stringOrNull(record.eventId);
  const key = sequence !== null ? `s:${sequence}` : eventId ? `e:${eventId}` : null;

  // Already applied as part of the snapshot this state is based on.
  if (sequence !== null && state.baseSequence !== null && sequence <= state.baseSequence) {
    return state;
  }
  // Older than the ring can vouch for. Applying it would risk a duplicate we cannot detect.
  if (sequence !== null
    && state.sequence !== null
    && sequence <= state.sequence - LIVE_THREAD_SEEN_LIMIT) {
    return state;
  }
  if (key !== null && state.seen.includes(key)) return state;

  const seen = key === null ? state.seen : [...state.seen, key].slice(-LIVE_THREAD_SEEN_LIMIT);
  const next: LiveThreadState = {
    ...state,
    seen,
    sequence: sequence === null
      ? state.sequence
      : state.sequence === null ? sequence : Math.max(state.sequence, sequence),
    observedAt: stringOrNull(record.observedAt) ?? state.observedAt,
  };

  const event = asRecord(record.event);
  const type = stringOrNull(record.type) ?? stringOrNull(event?.type);
  const eventPayload = asRecord(event?.payload);
  const occurredAt = stringOrNull(record.occurredAt) ?? stringOrNull(event?.occurredAt);

  if (type === "thread.message-sent") return applyMessageSent(next, eventPayload, occurredAt);
  if (type === "thread.activity-appended") {
    const activity = eventPayload?.activity;
    const approvals = foldApprovalActivity(next.approvals, activity, next.threadId);
    const withApprovals = approvals === next.approvals
      ? next
      : { ...next, approvals: [...approvals] };
    return upsert(withApprovals, activityEntryFrom(activity, occurredAt));
  }
  if (type === "thread.turn-diff-completed") {
    return upsert(next, turnEntryFrom(eventPayload, occurredAt));
  }
  if (type === "thread.proposed-plan-upserted") {
    return upsert(next, planEntryFrom(eventPayload?.proposedPlan, occurredAt));
  }
  if (type === "thread.session-set") return applySessionSet(next, eventPayload);
  if (type === "thread.reverted") {
    const turnCount = numberOrNull(eventPayload?.turnCount);
    return upsert(next, {
      kind: "note",
      key: `note:${eventId ?? sequence ?? next.order}`,
      id: String(eventId ?? sequence ?? next.order),
      summary: turnCount === null
        ? "Reverted to an earlier checkpoint."
        : `Reverted to an earlier checkpoint (${turnCount} ${turnCount === 1 ? "turn" : "turns"} undone).`,
      at: occurredAt,
      order: 0,
    });
  }

  // An event type this console does not render yet still counts as delivered: it advanced the
  // cursor and the dedup ring above, which is what keeps a later duplicate from re-appearing.
  return next;
}

/**
 * TRAP 1. `streaming: true` carries a delta. Accumulate it onto the message with the same id —
 * never assign it.
 */
function applyMessageSent(
  state: LiveThreadState,
  payload: Record<string, unknown> | null,
  occurredAt: string | null,
): LiveThreadState {
  const messageId = stringOrNull(payload?.messageId) ?? stringOrNull(payload?.id);
  if (!messageId) return state;
  const key = `message:${messageId}`;
  const streaming = payload?.streaming === true;
  const text = typeof payload?.text === "string" ? payload.text : "";
  const index = state.entries.findIndex((entry) => entry.key === key);
  const candidate = index === -1 ? null : state.entries[index];
  const existing = candidate?.kind === "message" ? candidate : null;

  if (!existing) {
    const entry: LiveThreadMessageEntry = {
      kind: "message",
      key,
      id: messageId,
      role: roleOf(payload?.role),
      // A first streaming frame is a delta onto an empty body, which is the same string.
      text,
      streaming,
      turnId: stringOrNull(payload?.turnId),
      at: stringOrNull(payload?.createdAt) ?? occurredAt,
      order: state.order,
    };
    return { ...state, entries: [...state.entries, entry], order: state.order + 1 };
  }

  const nextText = streaming
    ? existing.text + text
    // A terminal frame carries the full text, or empty text meaning "keep what you have".
    : text.length > 0 ? text : existing.text;
  const entries = [...state.entries];
  entries[index] = {
    ...existing,
    text: nextText,
    streaming,
    role: roleOf(payload?.role, existing.role),
    turnId: stringOrNull(payload?.turnId) ?? existing.turnId,
    at: existing.at ?? stringOrNull(payload?.createdAt) ?? occurredAt,
  };
  return { ...state, entries };
}

function applySessionSet(
  state: LiveThreadState,
  payload: Record<string, unknown> | null,
): LiveThreadState {
  const session = asRecord(payload?.session);
  if (!session) return state;
  return {
    ...state,
    sessionStatus: stringOrNull(session.status),
    activeTurnId: stringOrNull(session.activeTurnId),
    sessionError: stringOrNull(session.lastError),
  };
}

function upsert(state: LiveThreadState, entry: LiveThreadEntry | null): LiveThreadState {
  if (!entry) return state;
  const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
  if (index === -1) {
    return {
      ...state,
      entries: [...state.entries, { ...entry, order: state.order }],
      order: state.order + 1,
    };
  }
  const entries = [...state.entries];
  entries[index] = { ...entry, order: entries[index].order };
  return { ...state, entries };
}

// ---------------------------------------------------------------------------------------------
// t3.thread.status
// ---------------------------------------------------------------------------------------------

const STATUS_STATES: readonly LiveThreadStatus[] = [
  "connecting",
  "resuming",
  "live",
  "reconnecting",
  "stopped",
];

export function applyThreadStatus(state: LiveThreadState, payload: unknown): LiveThreadState {
  const record = asRecord(payload);
  if (!record) return state;
  const reported = stringOrNull(record.state);
  if (!reported || !STATUS_STATES.includes(reported as LiveThreadStatus)) return state;
  const status = reported as LiveThreadStatus;

  return {
    ...state,
    status,
    sequence: numberOrNull(record.sequence) ?? state.sequence,
    attempt: status === "reconnecting" ? numberOrNull(record.attempt) ?? state.attempt + 1 : 0,
    retryInMs: status === "reconnecting" ? numberOrNull(record.retryInMs) : null,
    statusError: status === "reconnecting" || status === "stopped"
      ? stringOrNull(record.error)
      : null,
    stoppedReason: status === "stopped" ? stringOrNull(record.reason) : null,
    observedAt: stringOrNull(record.observedAt) ?? state.observedAt,
  };
}

/**
 * The gateway's own view of the subscription, returned by `POST .../watch`. Used to seed the
 * status on first registration so the view is not blank until the first `t3.thread.status`
 * arrives. Renewals deliberately do not re-apply it: a renewal's answer can be older than a status
 * event already delivered, and a stale "connecting" over a live view is exactly the dishonesty
 * this module exists to prevent.
 */
export function applyWatchRecord(state: LiveThreadState, watch: unknown): LiveThreadState {
  if (state.status !== "idle") return state;
  const record = asRecord(watch);
  const hub = stringOrNull(record?.state);
  const status: LiveThreadStatus = hub === "live"
    ? "live"
    : hub === "catching-up"
      ? "resuming"
      : hub === "backoff"
        ? "reconnecting"
        : "connecting";
  return { ...state, status, sequence: numberOrNull(record?.sequence) ?? state.sequence };
}

/** The watch could not be registered at all. Say so rather than showing an empty live view. */
export function applyWatchFailure(state: LiveThreadState, message: string): LiveThreadState {
  return { ...state, status: "stopped", stoppedReason: "watch-failed", statusError: message };
}

// ---------------------------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------------------------

function messageEntryFrom(raw: unknown): LiveThreadMessageEntry | null {
  const record = asRecord(raw);
  const id = stringOrNull(record?.id) ?? stringOrNull(record?.messageId);
  if (!record || !id) return null;
  return {
    kind: "message",
    key: `message:${id}`,
    id,
    role: roleOf(record.role),
    text: typeof record.text === "string" ? record.text : "",
    streaming: record.streaming === true,
    turnId: stringOrNull(record.turnId),
    at: stringOrNull(record.createdAt) ?? stringOrNull(record.updatedAt),
    order: 0,
  };
}

function activityEntryFrom(raw: unknown, occurredAt: string | null = null): LiveThreadActivityEntry | null {
  const record = asRecord(raw);
  const id = stringOrNull(record?.id);
  if (!record || !id) return null;
  const summary = stringOrNull(record.summary) ?? stringOrNull(record.kind) ?? "Activity";
  const tone = stringOrNull(record.tone);
  return {
    kind: "activity",
    key: `activity:${id}`,
    id,
    tone: tone === "tool" || tone === "approval" || tone === "error" ? tone : "info",
    activityKind: stringOrNull(record.kind) ?? "activity",
    summary,
    turnId: stringOrNull(record.turnId),
    at: stringOrNull(record.createdAt) ?? occurredAt,
    order: 0,
  };
}

function planEntryFrom(raw: unknown, occurredAt: string | null = null): LiveThreadPlanEntry | null {
  const record = asRecord(raw);
  const id = stringOrNull(record?.id);
  const planMarkdown = stringOrNull(record?.planMarkdown);
  if (!record || !id || !planMarkdown) return null;
  return {
    kind: "plan",
    key: `plan:${id}`,
    id,
    planMarkdown,
    turnId: stringOrNull(record.turnId),
    at: stringOrNull(record.updatedAt) ?? stringOrNull(record.createdAt) ?? occurredAt,
    order: 0,
  };
}

function turnEntryFrom(raw: unknown, occurredAt: string | null = null): LiveThreadTurnEntry | null {
  const record = asRecord(raw);
  const turnId = stringOrNull(record?.turnId);
  if (!record || !turnId) return null;
  const files = asArray(record.files).flatMap((file) => {
    const entry = asRecord(file);
    const path = stringOrNull(entry?.path);
    if (!path) return [];
    return [{
      path,
      additions: numberOrNull(entry?.additions) ?? 0,
      deletions: numberOrNull(entry?.deletions) ?? 0,
    }];
  });
  return {
    kind: "turn",
    key: `turn:${turnId}`,
    turnId,
    status: stringOrNull(record.status) ?? "ready",
    files,
    at: stringOrNull(record.completedAt) ?? occurredAt,
    order: 0,
  };
}

// ---------------------------------------------------------------------------------------------

function roleOf(value: unknown, fallback: LiveThreadRole = "system"): LiveThreadRole {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") return role;
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timeOf(at: string | null): number {
  if (!at) return 0;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}
