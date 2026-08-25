import { describe, expect, test } from "vitest";

import {
  applyThreadEvent,
  applyThreadSnapshot,
  createLiveThreadState,
} from "./liveThread";
import {
  PROVIDER_APPROVAL_DECISION_CATALOGUE,
  collectProviderApprovals,
  isProviderApprovalDecision,
  isStaleProviderRequestDetail,
  mergeProviderApprovalDecisions,
  offeredProviderApprovalDecisions,
  pendingProviderApprovals,
  providerApprovalTitle,
} from "./providerApprovals";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

function requested(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `act_${requestId}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "File-change approval requested",
    payload: {
      requestId,
      requestKind: "file-change",
      requestType: "file_change_approval",
      detail: "src/app.mjs",
    },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function snapshotPayload(activities: unknown[]) {
  return {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: { id: "thread_1", messages: [], activities, session: null },
  };
}

function activityEvent(sequence: number, activity: unknown) {
  return {
    ...TARGET,
    sequence,
    eventId: `evt_${sequence}`,
    type: "thread.activity-appended",
    occurredAt: "2026-08-24T12:00:01.000Z",
    event: {
      sequence,
      eventId: `evt_${sequence}`,
      type: "thread.activity-appended",
      occurredAt: "2026-08-24T12:00:01.000Z",
      payload: { threadId: "thread_1", activity },
    },
  };
}

describe("the decision vocabulary", () => {
  test("offers T3's four decisions, exactly one of which is a standing grant", () => {
    expect(PROVIDER_APPROVAL_DECISION_CATALOGUE.map((entry) => entry.decision)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
    expect(
      PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => entry.persistent)
        .map((entry) => entry.decision),
    ).toEqual(["acceptForSession"]);
    expect(isProviderApprovalDecision("acceptForSession")).toBe(true);
    expect(isProviderApprovalDecision("approve")).toBe(false);
  });

  test("only offers what the gateway said this actor may give", () => {
    // A controller: allow-always is withheld, the other three stand.
    expect(
      offeredProviderApprovalDecisions(["accept", "decline", "cancel"]).map((entry) => entry.decision),
    ).toEqual(["accept", "decline", "cancel"]);
    // A read-only actor: an empty list is a real answer, not a loading state.
    expect(offeredProviderApprovalDecisions([])).toEqual([]);
    // Nothing said: the console falls back to the full set, and the gateway still enforces.
    expect(offeredProviderApprovalDecisions(undefined)).toHaveLength(4);
  });
});

describe("deriving approvals from the live stream", () => {
  test("a snapshot carries the pending approval, with the requestId needed to answer it", () => {
    const state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].requestId).toBe("req_1");
    expect(state.approvals[0].status).toBe("pending");
    expect(state.approvals[0].detail).toBe("src/app.mjs");
    expect(providerApprovalTitle(state.approvals[0])).toBe("Change a file");
  });

  test("an approval arriving live is picked up from the activity event", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([]));
    expect(state.approvals).toEqual([]);
    state = applyThreadEvent(state, activityEvent(101, requested("req_live")));
    expect(pendingProviderApprovals(state.approvals).map((entry) => entry.requestId))
      .toEqual(["req_live"]);
    // The row is still in the transcript too — the approval card and the work log are both true.
    expect(state.entries.some((entry) => entry.kind === "activity" && entry.tone === "approval"))
      .toBe(true);
  });

  test("a resolution closes it, so the card stops being offered", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
    state = applyThreadEvent(state, activityEvent(101, {
      id: "act_resolved",
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      payload: { requestId: "req_1", decision: "accept" },
      turnId: "turn_1",
      createdAt: "2026-08-24T12:00:02.000Z",
    }));
    expect(pendingProviderApprovals(state.approvals)).toEqual([]);
    expect(state.approvals[0].status).toBe("resolved");
  });

  test("a stale failure closes it; any other failure leaves the agent still waiting", () => {
    const stale = "Stale pending approval request: req_1. Provider callback state does not survive "
      + "app restarts or recovered sessions. Restart the turn to continue.";
    expect(isStaleProviderRequestDetail(stale)).toBe(true);
    expect(isStaleProviderRequestDetail("socket hang up")).toBe(false);

    const after = (detail: string) => {
      let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
      state = applyThreadEvent(state, activityEvent(101, {
        id: "act_failed",
        tone: "error",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        payload: { requestId: "req_1", detail },
        turnId: null,
        createdAt: "2026-08-24T12:00:03.000Z",
      }));
      return state.approvals[0];
    };

    expect(after(stale).status).toBe("stale");
    expect(after("socket hang up").status).toBe("pending");
    expect(after("socket hang up").failure).toBe("socket hang up");
  });

  test("a snapshot replaces the approval list rather than appending to it", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_old")]));
    state = applyThreadSnapshot(state, snapshotPayload([requested("req_new")]));
    expect(state.approvals.map((entry) => entry.requestId)).toEqual(["req_new"]);
  });

  test("a duplicate event does not duplicate the approval", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([]));
    state = applyThreadEvent(state, activityEvent(101, requested("req_1")));
    state = applyThreadEvent(state, activityEvent(101, requested("req_1")));
    expect(state.approvals).toHaveLength(1);
  });

  test("collectProviderApprovals orders by sequence, not array order", () => {
    const approvals = collectProviderApprovals({
      activities: [
        {
          id: "act_resolved",
          kind: "approval.resolved",
          payload: { requestId: "req_1", decision: "decline" },
          sequence: 2,
          createdAt: "2026-08-24T12:00:02.000Z",
        },
        requested("req_1"),
      ],
    }, "thread_1");
    expect(approvals[0].status).toBe("resolved");
    expect(approvals[0].decision).toBe("decline");
  });
});

test("a decision this account already made is folded onto the approval", () => {
  const approvals = collectProviderApprovals({ activities: [requested("req_1")] }, "thread_1");
  const merged = mergeProviderApprovalDecisions(approvals, [{
    requestId: "req_1",
    decision: "accept",
    status: "dispatched",
    actorType: "device",
    commandId: "cmd_1",
    error: null,
    decidedAt: "2026-08-24T12:00:04.000Z",
  }]);
  expect(merged[0].localDecision?.decision).toBe("accept");
  // Still "pending" as far as T3 is concerned — the provider has not acted on it yet. The two
  // facts are separate on purpose, and the console suppresses the buttons on the local one.
  expect(merged[0].status).toBe("pending");
});
