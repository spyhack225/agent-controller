import { expect, test } from "vitest";
import workFixture from "../../test/fixtures/t3-work-activities-contract.json";

import {
  LIVE_THREAD_ENTRY_LIMIT,
  applyThreadEvent,
  applyThreadSnapshot,
  applyThreadStatus,
  applyWatchFailure,
  applyWatchRecord,
  createLiveThreadState,
  liveThreadIsCurrent,
  liveThreadTurnInFlight,
  payloadMatchesThread,
  type LiveThreadMessageEntry,
  type LiveThreadState,
} from "./liveThread";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

function start(): LiveThreadState {
  return createLiveThreadState(TARGET);
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "env_1",
    threadId: "thread_1",
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: {
      id: "thread_1",
      title: "Refactor the poller",
      messages: [],
      activities: [],
      session: null,
    },
    observedAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function event(sequence: number, type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    environmentId: "env_1",
    threadId: "thread_1",
    sequence,
    eventId: `evt_${sequence}`,
    type,
    occurredAt: "2026-08-24T12:00:01.000Z",
    commandId: null,
    event: { sequence, eventId: `evt_${sequence}`, type, occurredAt: "2026-08-24T12:00:01.000Z", payload },
    observedAt: "2026-08-24T12:00:01.000Z",
    ...extra,
  };
}

function delta(sequence: number, messageId: string, text: string, streaming = true) {
  return event(sequence, "thread.message-sent", {
    threadId: "thread_1",
    messageId,
    role: "assistant",
    text,
    turnId: "turn_1",
    streaming,
    createdAt: "2026-08-24T12:00:01.000Z",
    updatedAt: "2026-08-24T12:00:01.000Z",
  });
}

function messages(state: LiveThreadState): LiveThreadMessageEntry[] {
  return state.entries.filter((entry): entry is LiveThreadMessageEntry => entry.kind === "message");
}

// -----------------------------------------------------------------------------------------------
// TRAP 1: a streaming message-sent carries a DELTA, not the message.
// -----------------------------------------------------------------------------------------------

test("accumulates streaming deltas into one message body instead of showing the last delta", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "The poller "));
  state = applyThreadEvent(state, delta(102, "msg_1", "now polls "));
  state = applyThreadEvent(state, delta(103, "msg_1", "only present users."));

  expect(messages(state)).toHaveLength(1);
  expect(messages(state)[0].text).toBe("The poller now polls only present users.");
  // The specific failure this guards: rendering payload.text as the body.
  expect(messages(state)[0].text).not.toBe("only present users.");
  expect(messages(state)[0].streaming).toBe(true);
});

test("a terminal frame with empty text keeps the accumulated body and ends the stream", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "Half a "));
  state = applyThreadEvent(state, delta(102, "msg_1", "sentence."));
  state = applyThreadEvent(state, delta(103, "msg_1", "", false));

  expect(messages(state)[0].text).toBe("Half a sentence.");
  expect(messages(state)[0].streaming).toBe(false);
  expect(liveThreadTurnInFlight(state)).toBe(false);
});

test("a terminal frame carrying full text replaces the accumulated body", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "Draf"));
  state = applyThreadEvent(state, delta(102, "msg_1", "Drafted the final answer.", false));

  expect(messages(state)[0].text).toBe("Drafted the final answer.");
  expect(messages(state)[0].streaming).toBe(false);
});

test("keeps two concurrent messages apart by id", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "one "));
  state = applyThreadEvent(state, delta(102, "msg_2", "two "));
  state = applyThreadEvent(state, delta(103, "msg_1", "more"));

  expect(messages(state).map((entry) => entry.text)).toEqual(["one more", "two "]);
});

// -----------------------------------------------------------------------------------------------
// TRAP 2: a snapshot replaces. `gap: true` says the intermediate history is gone.
// -----------------------------------------------------------------------------------------------

test("a gap snapshot replaces the transcript rather than appending to it", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "First reply.", false));
  state = applyThreadEvent(state, event(102, "thread.activity-appended", {
    threadId: "thread_1",
    activity: {
      id: "act_1",
      tone: "tool",
      kind: "tool.started",
      summary: "Read file",
      turnId: "turn_1",
      createdAt: "2026-08-24T12:00:02.000Z",
    },
  }));
  expect(state.entries).toHaveLength(2);

  state = applyThreadSnapshot(state, snapshot({
    gap: true,
    snapshotSequence: 5000,
    thread: {
      id: "thread_1",
      title: "Refactor the poller",
      messages: [
        { id: "msg_1", role: "assistant", text: "First reply.", streaming: false, turnId: "turn_1", createdAt: "2026-08-24T12:00:01.000Z" },
        { id: "msg_9", role: "assistant", text: "Latest reply.", streaming: false, turnId: "turn_4", createdAt: "2026-08-24T12:09:00.000Z" },
      ],
      activities: [],
      session: { status: "stopped", activeTurnId: null, lastError: null },
    },
  }));

  // Appending would have produced four entries and a duplicated msg_1.
  expect(state.entries).toHaveLength(2);
  expect(messages(state).map((entry) => entry.id)).toEqual(["msg_1", "msg_9"]);
  expect(state.historyGap).toBe(true);
  expect(state.baseSequence).toBe(5000);
});

test("a snapshot replaces the T3 work projection and its parent links with the authoritative window", () => {
  let state = applyThreadSnapshot(start(), snapshot({
    thread: {
      id: "thread_1",
      messages: [],
      activities: workFixture.activities,
      session: null,
      backgroundLiveness: "monitoring",
    },
  }));
  expect(state.work.nodes.map((node) => node.id).sort()).toEqual([
    "agent_child",
    "agent_parent",
    "monitor_1",
  ]);
  expect(state.work.relationshipMode).toBe("tree");
  expect(state.backgroundLiveness).toBe("monitoring");

  state = applyThreadSnapshot(state, snapshot({
    gap: true,
    snapshotSequence: 5000,
    thread: {
      id: "thread_1",
      messages: [],
      activities: [workFixture.activities[1]],
      session: null,
    },
  }));
  expect(state.work.nodes.map((node) => node.id)).toEqual(["agent_child"]);
  expect(state.work.nodes[0].parentId).toBe("agent_parent");
  expect(state.work.relationshipMode).toBe("tree");
  expect(state.backgroundLiveness).toBe("working");
  expect(state.historyGap).toBe(true);
});

test("a clean snapshot clears a gap that a previous one reported", () => {
  let state = applyThreadSnapshot(start(), snapshot({ gap: true }));
  expect(state.historyGap).toBe(true);
  state = applyThreadSnapshot(state, snapshot({ gap: false, snapshotSequence: 200 }));
  expect(state.historyGap).toBe(false);
});

test("a windowed snapshot says that older history was never loaded", () => {
  const state = applyThreadSnapshot(start(), snapshot({
    page: { beforeCursor: "cur_1", hasMore: true, snapshotSequence: 100 },
  }));
  expect(state.historyTruncated).toBe(true);
});

test("bounds a large snapshot and truthfully reports the omitted history", () => {
  const allMessages = Array.from({ length: LIVE_THREAD_ENTRY_LIMIT + 17 }, (_, index) => ({
    id: `msg_${index}`,
    role: "assistant",
    text: `Reply ${index}`,
    streaming: false,
    createdAt: new Date(Date.UTC(2026, 7, 24, 12, 0, index)).toISOString(),
  }));
  const state = applyThreadSnapshot(start(), snapshot({
    thread: { id: "thread_1", messages: allMessages, activities: [], session: null },
  }));

  expect(state.entries).toHaveLength(LIVE_THREAD_ENTRY_LIMIT);
  expect(state.entries[0].key).toBe("message:msg_17");
  expect(state.entries.at(-1)?.key).toBe(`message:msg_${allMessages.length - 1}`);
  expect(state.historyTruncated).toBe(true);
});

test("keeps a long-running live projection bounded while retaining the newest rows", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  for (let index = 0; index < LIVE_THREAD_ENTRY_LIMIT + 25; index += 1) {
    state = applyThreadEvent(state, delta(101 + index, `msg_${index}`, `Reply ${index}`, false));
  }

  expect(state.entries).toHaveLength(LIVE_THREAD_ENTRY_LIMIT);
  expect(state.entries[0].key).toBe("message:msg_25");
  expect(state.entries.at(-1)?.key).toBe(`message:msg_${LIVE_THREAD_ENTRY_LIMIT + 24}`);
  expect(state.historyTruncated).toBe(true);
});

test("interleaves the snapshot's messages and activities by their own timestamps", () => {
  const state = applyThreadSnapshot(start(), snapshot({
    thread: {
      id: "thread_1",
      messages: [
        { id: "msg_1", role: "user", text: "Go", streaming: false, createdAt: "2026-08-24T12:00:00.000Z" },
        { id: "msg_2", role: "assistant", text: "Done", streaming: false, createdAt: "2026-08-24T12:00:30.000Z" },
      ],
      activities: [
        { id: "act_1", tone: "tool", kind: "tool.started", summary: "Read file", turnId: "t", createdAt: "2026-08-24T12:00:10.000Z" },
      ],
      session: null,
    },
  }));
  expect(state.entries.map((entry) => entry.key)).toEqual([
    "message:msg_1",
    "activity:act_1",
    "message:msg_2",
  ]);
});

// -----------------------------------------------------------------------------------------------
// TRAP 3: the same event can arrive twice.
// -----------------------------------------------------------------------------------------------

test("ignores a repeated event instead of appending its delta twice", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(101, "msg_1", "Once."));
  const duplicated = applyThreadEvent(state, delta(101, "msg_1", "Once."));

  expect(messages(duplicated)[0].text).toBe("Once.");
  expect(duplicated).toBe(state);
});

test("ignores a repeated activity delivered by the replay/live overlap", () => {
  const activity = event(101, "thread.activity-appended", {
    threadId: "thread_1",
    activity: { id: "act_1", tone: "tool", kind: "tool.started", summary: "Grep", turnId: "t", createdAt: "2026-08-24T12:00:02.000Z" },
  });
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, activity);
  state = applyThreadEvent(state, activity);
  expect(state.entries).toHaveLength(1);
});

test("deduplicates live task events and keeps background work active after the parent turn settles", () => {
  const started = event(101, "thread.activity-appended", {
    threadId: "thread_1",
    activity: workFixture.activities[0],
  });
  let state = applyThreadSnapshot(start(), snapshot({
    thread: {
      id: "thread_1",
      messages: [],
      activities: [],
      session: { status: "stopped", activeTurnId: null, lastError: null },
    },
  }));
  state = applyThreadEvent(state, started);
  state = applyThreadEvent(state, started);
  expect(state.work.nodes).toHaveLength(1);
  expect(state.work.nodes[0].activities).toHaveLength(1);
  expect(state.backgroundLiveness).toBe("working");
  expect(liveThreadTurnInFlight(state)).toBe(true);

  state = applyThreadEvent(state, event(102, "thread.activity-appended", {
    threadId: "thread_1",
    activity: {
      ...workFixture.activities[5],
      payload: {
        ...workFixture.activities[5].payload,
        taskId: "agent_parent",
        parentAgentId: undefined,
      },
    },
  }));
  expect(state.work.nodes[0].status).toBe("completed");
  expect(state.backgroundLiveness).toBeNull();
  expect(liveThreadTurnInFlight(state)).toBe(false);
});

test("deduplicates on eventId when no usable sequence is present", () => {
  const unsequenced = {
    ...event(0, "thread.activity-appended", {
      threadId: "thread_1",
      activity: { id: "act_1", tone: "info", kind: "note", summary: "Started", turnId: null, createdAt: "2026-08-24T12:00:02.000Z" },
    }),
    sequence: null,
    eventId: "evt_no_sequence",
  };
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, unsequenced);
  const again = applyThreadEvent(state, unsequenced);
  expect(state.entries).toHaveLength(1);
  expect(again).toBe(state);
});

test("drops an event already contained in the snapshot it is based on", () => {
  const state = applyThreadSnapshot(start(), snapshot({ snapshotSequence: 100 }));
  const stale = applyThreadEvent(state, delta(100, "msg_1", "already in the snapshot"));
  expect(stale).toBe(state);
  expect(messages(stale)).toHaveLength(0);
});

test("applies an out-of-order event that is new, rather than assuming arrival is monotonic", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, delta(105, "msg_2", "later"));
  state = applyThreadEvent(state, delta(102, "msg_1", "earlier"));

  expect(messages(state).map((entry) => entry.id)).toEqual(["msg_2", "msg_1"]);
  expect(state.sequence).toBe(105);
});

// -----------------------------------------------------------------------------------------------
// Session, turns and lifecycle
// -----------------------------------------------------------------------------------------------

test("tracks the running turn from thread.session-set", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  expect(liveThreadTurnInFlight(state)).toBe(false);

  state = applyThreadEvent(state, event(101, "thread.session-set", {
    threadId: "thread_1",
    session: { threadId: "thread_1", status: "running", activeTurnId: "turn_1", lastError: null, updatedAt: "2026-08-24T12:00:01.000Z" },
  }));
  expect(state.activeTurnId).toBe("turn_1");
  expect(liveThreadTurnInFlight(state)).toBe(true);

  state = applyThreadEvent(state, event(102, "thread.session-set", {
    threadId: "thread_1",
    session: { threadId: "thread_1", status: "stopped", activeTurnId: null, lastError: null, updatedAt: "2026-08-24T12:00:09.000Z" },
  }));
  expect(state.activeTurnId).toBeNull();
  expect(liveThreadTurnInFlight(state)).toBe(false);
});

test("surfaces a session error without inventing a failed turn", () => {
  const state = applyThreadEvent(applyThreadSnapshot(start(), snapshot()), event(101, "thread.session-set", {
    threadId: "thread_1",
    session: {
      threadId: "thread_1",
      status: "stopped",
      activeTurnId: null,
      lastError: "The 'gpt-5..6' model is not supported.",
      updatedAt: "2026-08-24T12:00:09.000Z",
    },
  }));
  expect(state.sessionError).toBe("The 'gpt-5..6' model is not supported.");
});

test("records a finished turn's diff once, even when the event repeats", () => {
  const diff = event(101, "thread.turn-diff-completed", {
    threadId: "thread_1",
    turnId: "turn_1",
    checkpointTurnCount: 1,
    checkpointRef: "ref_1",
    status: "ready",
    files: [{ path: "src/app.mjs", kind: "modified", additions: 12, deletions: 4 }],
    assistantMessageId: "msg_1",
    completedAt: "2026-08-24T12:00:09.000Z",
  });
  let state = applyThreadSnapshot(start(), snapshot());
  state = applyThreadEvent(state, diff);
  state = applyThreadEvent(state, diff);
  expect(state.entries.filter((entry) => entry.kind === "turn")).toHaveLength(1);
});

test("an unrendered event type still advances the cursor so a duplicate cannot reappear", () => {
  let state = applyThreadSnapshot(start(), snapshot());
  const unknown = event(101, "thread.interaction-mode-set", { threadId: "thread_1" });
  state = applyThreadEvent(state, unknown);
  expect(state.sequence).toBe(101);
  expect(applyThreadEvent(state, unknown)).toBe(state);
});

test("reports each lifecycle state, and only calls the view current when it is live", () => {
  let state = applyThreadStatus(start(), { environmentId: "env_1", threadId: "thread_1", state: "connecting" });
  expect(state.status).toBe("connecting");
  expect(liveThreadIsCurrent(state)).toBe(false);

  state = applyThreadSnapshot(state, snapshot());
  // A snapshot alone is not "live": the catch-up replay may still be draining.
  expect(liveThreadIsCurrent(state)).toBe(false);

  state = applyThreadStatus(state, { state: "resuming", environmentId: "env_1", threadId: "thread_1" });
  expect(state.status).toBe("resuming");
  expect(liveThreadIsCurrent(state)).toBe(false);

  state = applyThreadStatus(state, { state: "live", environmentId: "env_1", threadId: "thread_1", sequence: 140 });
  expect(liveThreadIsCurrent(state)).toBe(true);
  expect(state.sequence).toBe(140);

  state = applyThreadStatus(state, {
    state: "reconnecting",
    environmentId: "env_1",
    threadId: "thread_1",
    attempt: 3,
    retryInMs: 4000,
    error: "T3 thread stream ended (socket-closed).",
  });
  expect(liveThreadIsCurrent(state)).toBe(false);
  expect(state.attempt).toBe(3);
  expect(state.retryInMs).toBe(4000);
  expect(state.statusError).toMatch(/socket-closed/u);
  // The transcript survives a drop; what changes is the claim made about it.
  expect(state.hasSnapshot).toBe(true);

  state = applyThreadStatus(state, { state: "stopped", environmentId: "env_1", threadId: "thread_1", reason: "no-watchers" });
  expect(state.status).toBe("stopped");
  expect(state.stoppedReason).toBe("no-watchers");
  expect(state.attempt).toBe(0);
});

test("ignores a status frame naming a state the gateway does not publish", () => {
  const state = start();
  expect(applyThreadStatus(state, { state: "vibing" })).toBe(state);
});

test("seeds the status from the watch record only on first registration", () => {
  const seeded = applyWatchRecord(start(), { state: "live", sequence: 40213 });
  expect(seeded.status).toBe("live");
  expect(seeded.sequence).toBe(40213);

  // A renewal answering "connecting" must not overwrite a live view.
  const renewed = applyWatchRecord(seeded, { state: "connecting", sequence: 1 });
  expect(renewed).toBe(seeded);
});

test("says the watch could not be registered rather than showing a blank live view", () => {
  const state = applyWatchFailure(start(), "Environment not found.");
  expect(state.status).toBe("stopped");
  expect(state.statusError).toBe("Environment not found.");
  expect(liveThreadIsCurrent(state)).toBe(false);
});

test("ignores a payload published for a different thread on the same user's stream", () => {
  const state = applyThreadSnapshot(start(), snapshot());
  expect(payloadMatchesThread(state, { environmentId: "env_1", threadId: "thread_2" })).toBe(false);
  expect(payloadMatchesThread(state, { environmentId: "env_2", threadId: "thread_1" })).toBe(false);
  expect(payloadMatchesThread(state, { environmentId: "env_1", threadId: "thread_1" })).toBe(true);
  expect(payloadMatchesThread(null, { environmentId: "env_1", threadId: "thread_1" })).toBe(false);
});
