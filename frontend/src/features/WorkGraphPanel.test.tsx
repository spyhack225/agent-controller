import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import fixture from "../../../test/fixtures/t3-work-activities-contract.json";
import {
  applyThreadSnapshot,
  applyThreadStatus,
  createLiveThreadState,
} from "../liveThread";
import { WorkGraphPanel } from "./WorkGraphPanel";

const target = { environmentId: "env_1", threadId: "thread_1" };

function stateWith(activities: unknown[], status: "live" | "reconnecting" | "stopped" = "live") {
  let state = applyThreadSnapshot(createLiveThreadState(target), {
    ...target,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    thread: { id: "thread_1", messages: [], activities, session: null },
  });
  state = applyThreadStatus(state, {
    ...target,
    state: status,
    ...(status === "reconnecting" ? { attempt: 2, retryInMs: 2000 } : {}),
  });
  return state;
}

test("renders the verified parent/child task tree with status, identity and failure detail", () => {
  const state = stateWith(fixture.activities);
  render(<WorkGraphPanel state={state} status="live" />);

  fireEvent.click(screen.getByText("Agents & work"));

  expect(screen.getByText(/3 shown · 1 active · 1 complete · 1 failed/u)).toBeInTheDocument();
  expect(screen.getByText("Repository audit")).toBeInTheDocument();
  expect(screen.getByText("Frontend audit")).toBeInTheDocument();
  expect(screen.getByText("Deployment monitor")).toBeInTheDocument();
  expect(screen.getByText("Provider process exited")).toBeInTheDocument();
  expect(screen.getByText(/Hierarchy uses only parentAgentId\/agentId/u)).toBeInTheDocument();
  expect(screen.getByText(/no stable per-task input, stop, or resume command/u)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /stop agent|message agent|resume agent/iu })).toBeNull();
});

test("distinguishes empty, loading, reconnecting and stopped evidence states", () => {
  const loading = createLiveThreadState(target);
  const { rerender } = render(<WorkGraphPanel state={loading} status="connecting" />);
  expect(screen.getByText("Waiting for the authoritative task snapshot")).toBeInTheDocument();
  expect(screen.getByText("Connecting")).toBeInTheDocument();

  const empty = stateWith([]);
  rerender(<WorkGraphPanel state={empty} status="live" />);
  expect(screen.getByText("No structured T3 task activity in this window")).toBeInTheDocument();

  const reconnecting = stateWith(fixture.activities, "reconnecting");
  rerender(<WorkGraphPanel state={reconnecting} status="reconnecting" />);
  expect(screen.getByText("Reconnecting")).toBeInTheDocument();
  expect(screen.getByText(/may be stale while the thread stream reconnects/u)).toBeInTheDocument();

  const stopped = applyThreadStatus(reconnecting, {
    ...target,
    state: "stopped",
    error: "Connector unavailable",
    reason: "watch-failed",
  });
  rerender(<WorkGraphPanel state={stopped} status="stopped" />);
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByText(/last synchronized task state/u)).toBeInTheDocument();
  expect(screen.getByText("Connector unavailable")).toBeInTheDocument();
});

test("labels an unlinked task window as a roster instead of inventing a tree", () => {
  const state = stateWith([{
    id: "evt_legacy",
    kind: "task.started",
    tone: "info",
    summary: "Started three agents in parallel",
    payload: { taskId: "legacy_task", title: "Legacy task" },
    createdAt: "2026-08-27T12:00:00.000Z",
  }]);
  render(<WorkGraphPanel state={state} status="live" />);
  fireEvent.click(screen.getByText("Agents & work"));
  expect(screen.getByText(/no parent links in this window/u)).toBeInTheDocument();
  expect(screen.getByText("Task (legacy activity)")).toBeInTheDocument();
});
