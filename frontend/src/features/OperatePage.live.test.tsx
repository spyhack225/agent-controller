import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { Controller } from "../controller";
import {
  applyThreadEvent,
  applyThreadSnapshot,
  applyThreadStatus,
  createLiveThreadState,
  type LiveThreadState,
} from "../liveThread";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

// The live state is built with the real reducers rather than hand-written, so these tests exercise
// the same path the SSE stream takes: a page that renders a delta as a whole message fails here.
function liveState(build: (state: LiveThreadState) => LiveThreadState): LiveThreadState {
  return build(createLiveThreadState(TARGET));
}

function snapshotPayload(thread: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: { id: "thread_1", messages: [], activities: [], session: null, ...thread },
    ...overrides,
  };
}

function eventPayload(sequence: number, type: string, payload: unknown) {
  return {
    ...TARGET,
    sequence,
    eventId: `evt_${sequence}`,
    type,
    occurredAt: "2026-08-24T12:00:01.000Z",
    event: { sequence, eventId: `evt_${sequence}`, type, occurredAt: "2026-08-24T12:00:01.000Z", payload },
  };
}

function assistantDelta(sequence: number, text: string, streaming = true) {
  return eventPayload(sequence, "thread.message-sent", {
    threadId: "thread_1",
    messageId: "msg_1",
    role: "assistant",
    text,
    turnId: "turn_1",
    streaming,
    createdAt: "2026-08-24T12:00:01.000Z",
    updatedAt: "2026-08-24T12:00:01.000Z",
  });
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    connection: "live",
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedProjectId: "project_1",
    selectedProject: { id: "project_1", title: "Tacs" },
    environments: [{ id: "env_1", label: "Mac T3" }],
    threads: [{ id: "thread_1", label: "Thread", projectId: "project_1", messages: [] }],
    projects: [{ id: "project_1", title: "Tacs" }],
    harnesses: [],
    harnessCatalogueSource: "registered",
    sessionFailures: [],
    suggestedModelSelection: null,
    commands: [],
    commandEvents: [],
    macros: [],
    media: [],
    actions: [],
    pendingApprovals: [],
    recentCommands: [],
    display: { counts: {} },
    busyAction: null,
    liveThread: null,
    watchThread: vi.fn(),
    setNotice: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(),
    refreshAll: vi.fn(),
    loadSnapshot: vi.fn(async () => ({})),
    launchProject: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderOperate(overrides: Record<string, unknown> = {}) {
  const c = controller(overrides);
  const result = render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);
  return { c, ...result };
}

// -----------------------------------------------------------------------------------------------
// The watch lifecycle
// -----------------------------------------------------------------------------------------------

test("leases a watch for the thread on screen and releases it on unmount", () => {
  const watchThread = vi.fn();
  const { unmount } = renderOperate({ watchThread });

  expect(watchThread).toHaveBeenCalledWith({ environmentId: "env_1", threadId: "thread_1" });

  watchThread.mockClear();
  unmount();
  expect(watchThread).toHaveBeenCalledWith(null);
});

test("leases nothing while no thread is on screen", () => {
  const watchThread = vi.fn();
  renderOperate({ watchThread, selectedThreadId: "", threads: [], projects: [] });

  expect(watchThread).toHaveBeenCalledWith(null);
  expect(watchThread).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: expect.anything() }));
});

test("moves the lease when the operator switches thread", () => {
  const watchThread = vi.fn();
  const { rerender } = render(
    <ConfirmProvider><OperatePage controller={controller({ watchThread })} /></ConfirmProvider>,
  );
  watchThread.mockClear();

  rerender(
    <ConfirmProvider>
      <OperatePage controller={controller({
        watchThread,
        selectedThreadId: "thread_2",
        threads: [
          { id: "thread_1", label: "Thread", projectId: "project_1", messages: [] },
          { id: "thread_2", label: "Second", projectId: "project_1", messages: [] },
        ],
      })} />
    </ConfirmProvider>,
  );

  expect(watchThread).toHaveBeenCalledWith(null);
  expect(watchThread).toHaveBeenCalledWith({ environmentId: "env_1", threadId: "thread_2" });
});

// -----------------------------------------------------------------------------------------------
// The transcript
// -----------------------------------------------------------------------------------------------

test("renders the whole streamed reply, not the last delta that arrived", () => {
  const liveThread = liveState((state) => {
    let next = applyThreadSnapshot(state, snapshotPayload({
      messages: [{
        id: "msg_0",
        role: "user",
        text: "Refactor the poller",
        streaming: false,
        createdAt: "2026-08-24T12:00:00.000Z",
      }],
    }));
    next = applyThreadStatus(next, { ...TARGET, state: "live", sequence: 100 });
    next = applyThreadEvent(next, assistantDelta(101, "The poller "));
    next = applyThreadEvent(next, assistantDelta(102, "now tracks "));
    next = applyThreadEvent(next, assistantDelta(103, "present users."));
    return next;
  });

  renderOperate({ liveThread });

  const feed = screen.getByLabelText("Thread messages");
  expect(feed).toHaveTextContent("The poller now tracks present users.");
  expect(feed).toHaveTextContent("Refactor the poller");
  // The bug this exists to catch: only the final delta on screen.
  expect(feed.textContent).not.toMatch(/Agent\s*present users\.$/u);
});

test("shows tool activity and a finished turn alongside the reply", () => {
  const liveThread = liveState((state) => {
    let next = applyThreadSnapshot(state, snapshotPayload());
    next = applyThreadStatus(next, { ...TARGET, state: "live" });
    next = applyThreadEvent(next, eventPayload(101, "thread.activity-appended", {
      threadId: "thread_1",
      activity: {
        id: "act_1",
        tone: "tool",
        kind: "tool.started",
        summary: "Read src/snapshotPoller.mjs",
        turnId: "turn_1",
        createdAt: "2026-08-24T12:00:01.000Z",
      },
    }));
    next = applyThreadEvent(next, eventPayload(102, "thread.turn-diff-completed", {
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointTurnCount: 1,
      checkpointRef: "ref_1",
      status: "ready",
      files: [
        { path: "src/snapshotPoller.mjs", kind: "modified", additions: 12, deletions: 4 },
        { path: "test/poller.test.mjs", kind: "modified", additions: 30, deletions: 0 },
      ],
      assistantMessageId: "msg_1",
      completedAt: "2026-08-24T12:00:09.000Z",
    }));
    return next;
  });

  renderOperate({ liveThread });

  const feed = screen.getByLabelText("Thread messages");
  expect(feed).toHaveTextContent("Read src/snapshotPoller.mjs");
  expect(feed).toHaveTextContent("Turn finished");
  expect(feed).toHaveTextContent("2 files changed · +42 −4");
});

test("replaces the transcript after a gap and says the intermediate steps were lost", () => {
  const liveThread = liveState((state) => {
    let next = applyThreadSnapshot(state, snapshotPayload());
    next = applyThreadEvent(next, assistantDelta(101, "Early progress.", false));
    next = applyThreadSnapshot(next, snapshotPayload(
      {
        messages: [{
          id: "msg_9",
          role: "assistant",
          text: "Everything is done.",
          streaming: false,
          createdAt: "2026-08-24T12:09:00.000Z",
        }],
      },
      { gap: true, snapshotSequence: 5000 },
    ));
    return applyThreadStatus(next, { ...TARGET, state: "live", sequence: 5000 });
  });

  renderOperate({ liveThread });

  const feed = screen.getByLabelText("Thread messages");
  expect(feed).toHaveTextContent("Everything is done.");
  expect(feed).not.toHaveTextContent("Early progress.");
  expect(screen.getByRole("note")).toHaveTextContent(/gap T3 could not replay/u);
});

test("keeps the polled snapshot view for a thread nobody is streaming", () => {
  renderOperate({
    liveThread: null,
    threads: [{
      id: "thread_1",
      label: "Thread",
      projectId: "project_1",
      messages: [
        { id: "msg_1", role: "user", text: "Polled question", createdAt: "2026-08-24T12:00:00.000Z" },
        { id: "msg_2", role: "assistant", text: "Polled answer", createdAt: "2026-08-24T12:00:05.000Z" },
      ],
    }],
  });

  const feed = screen.getByLabelText("Thread messages");
  expect(feed).toHaveTextContent("Polled question");
  expect(feed).toHaveTextContent("Polled answer");
  expect(feed).not.toHaveAttribute("data-live");
  expect(screen.queryByLabelText("Live thread stream")).toBeNull();
});

test("falls back to the polled messages while the stream has sent no snapshot yet", () => {
  const liveThread = liveState((state) => applyThreadStatus(state, { ...TARGET, state: "connecting" }));

  renderOperate({
    liveThread,
    threads: [{
      id: "thread_1",
      label: "Thread",
      projectId: "project_1",
      messages: [{ id: "msg_1", role: "assistant", text: "Polled answer", createdAt: "2026-08-24T12:00:05.000Z" }],
    }],
  });

  expect(screen.getByLabelText("Thread messages")).toHaveTextContent("Polled answer");
  expect(screen.getByLabelText("Live thread stream")).toHaveTextContent("Connecting");
});

// -----------------------------------------------------------------------------------------------
// Lifecycle honesty
// -----------------------------------------------------------------------------------------------

test("does not claim to be live while it is still catching up", () => {
  const liveThread = liveState((state) => {
    const next = applyThreadSnapshot(state, snapshotPayload());
    return applyThreadStatus(next, { ...TARGET, state: "resuming", sequence: 100 });
  });

  renderOperate({ liveThread });

  const banner = screen.getByLabelText("Live thread stream");
  expect(banner).toHaveAttribute("data-state", "resuming");
  expect(banner).toHaveTextContent("Catching up");
  expect(banner).not.toHaveTextContent(/^Live/u);
});

test("tells the reader the view may be stale while the stream is reconnecting", () => {
  const liveThread = liveState((state) => {
    let next = applyThreadSnapshot(state, snapshotPayload());
    next = applyThreadStatus(next, { ...TARGET, state: "live" });
    return applyThreadStatus(next, {
      ...TARGET,
      state: "reconnecting",
      attempt: 2,
      retryInMs: 2000,
      error: "T3 thread stream ended (socket-closed).",
    });
  });

  renderOperate({ liveThread });

  const banner = screen.getByLabelText("Live thread stream");
  expect(banner).toHaveAttribute("data-state", "reconnecting");
  expect(banner).toHaveTextContent("Reconnecting");
  expect(banner).toHaveTextContent("may be out of date");
  expect(banner).toHaveTextContent("Attempt 2.");
});

test("says the thread is not live once the stream stops", () => {
  const liveThread = liveState((state) => {
    const next = applyThreadSnapshot(state, snapshotPayload());
    return applyThreadStatus(next, { ...TARGET, state: "stopped", reason: "environment-missing" });
  });

  renderOperate({ liveThread });

  const banner = screen.getByLabelText("Live thread stream");
  expect(banner).toHaveAttribute("data-state", "stopped");
  expect(banner).toHaveTextContent("Not live");
  expect(banner).toHaveTextContent("no longer paired");
});

test("reports reconnecting when the SSE broker itself is down, whatever the last status said", () => {
  const liveThread = liveState((state) => {
    const next = applyThreadSnapshot(state, snapshotPayload());
    return applyThreadStatus(next, { ...TARGET, state: "live" });
  });

  renderOperate({ liveThread, connection: "reconnecting" });

  const banner = screen.getByLabelText("Live thread stream");
  expect(banner).toHaveAttribute("data-state", "reconnecting");
  expect(banner).toHaveTextContent("Reconnecting");
});

test("shows the live badge only once the gateway says the catch-up is finished", () => {
  const liveThread = liveState((state) => {
    const next = applyThreadSnapshot(state, snapshotPayload());
    return applyThreadStatus(next, { ...TARGET, state: "live", sequence: 100 });
  });

  renderOperate({ liveThread });

  const banner = screen.getByLabelText("Live thread stream");
  expect(banner).toHaveAttribute("data-state", "live");
  expect(banner).toHaveTextContent("Live");
});

test("surfaces a session error the stream reported", () => {
  const liveThread = liveState((state) => {
    let next = applyThreadSnapshot(state, snapshotPayload());
    next = applyThreadStatus(next, { ...TARGET, state: "live" });
    return applyThreadEvent(next, eventPayload(101, "thread.session-set", {
      threadId: "thread_1",
      session: {
        threadId: "thread_1",
        status: "stopped",
        activeTurnId: null,
        lastError: "The 'gpt-5..6' model is not supported.",
        updatedAt: "2026-08-24T12:00:09.000Z",
      },
    }));
  });

  renderOperate({ liveThread });

  expect(screen.getByLabelText("Live thread stream"))
    .toHaveTextContent("The 'gpt-5..6' model is not supported.");
});
