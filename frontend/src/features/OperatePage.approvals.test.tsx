import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { Controller } from "../controller";
import { applyThreadSnapshot, createLiveThreadState } from "../liveThread";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

function approvalRequested(requestId: string) {
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
  };
}

function liveWithApproval(requestId = "req_1") {
  return applyThreadSnapshot(createLiveThreadState(TARGET), {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: {
      id: "thread_1",
      messages: [],
      activities: [approvalRequested(requestId)],
      session: null,
    },
  });
}

/** A gateway policy hold — the other kind of approval entirely. */
const gatewayHold = {
  id: "cmd_1",
  status: "approval_required",
  risk: "high",
  threadId: "thread_1",
  environmentId: "env_1",
  intent: { type: "shell_input", command: "sudo rm -rf /" },
  createdAt: "2026-08-24T12:00:00.000Z",
};

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
    providerApprovalDecisions: {},
    answerProviderApproval: vi.fn(async () => ({})),
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

test("a pending provider approval offers T3's four decisions, not two", () => {
  renderOperate({ liveThread: liveWithApproval() });

  expect(screen.getByText("Agent is waiting")).toBeTruthy();
  expect(screen.getByText("Change a file")).toBeTruthy();
  expect(screen.getByText("src/app.mjs")).toBeTruthy();
  for (const label of ["Allow once", "Allow for this session", "Decline", "Cancel the turn"]) {
    expect(screen.getByRole("button", { name: new RegExp(label, "u") })).toBeTruthy();
  }
});

test("the two kinds of approval render as separate questions", () => {
  renderOperate({ liveThread: liveWithApproval(), pendingApprovals: [gatewayHold] });

  // A gateway hold: the gateway refused to send something the owner asked for.
  expect(screen.getByText("Approval required")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Approve/u })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Reject/u })).toBeTruthy();

  // A provider request: the agent stopped mid-turn. Different label, different buttons, and a
  // request id from T3 rather than a gateway command id.
  expect(screen.getByText("Agent is waiting")).toBeTruthy();
  expect(screen.getByText("req_1")).toBeTruthy();
  expect(screen.getByText("cmd_1")).toBeTruthy();

  const cards = document.querySelectorAll(".thread-approval");
  expect(cards.length).toBe(2);
  expect([...cards].filter((card) => card.getAttribute("data-approval-kind") === "provider"))
    .toHaveLength(1);
});

test("answering sends the decision the button says, on the thread on screen", () => {
  const answerProviderApproval = vi.fn(async () => ({}));
  renderOperate({ liveThread: liveWithApproval(), answerProviderApproval });

  fireEvent.click(screen.getByRole("button", { name: /Allow for this session/u }));

  expect(answerProviderApproval).toHaveBeenCalledWith(
    { environmentId: "env_1", threadId: "thread_1" },
    "req_1",
    "acceptForSession",
  );
});

test("an approval this account already answered stops offering buttons", () => {
  renderOperate({
    liveThread: liveWithApproval(),
    providerApprovalDecisions: {
      req_1: {
        requestId: "req_1",
        decision: "accept",
        status: "dispatched",
        actorType: "user",
        commandId: "cmd_9",
        error: null,
        decidedAt: "2026-08-24T12:00:05.000Z",
      },
    },
  });

  // The answer is on its way to the provider. Offering the buttons again would invite a second,
  // conflicting decision the gateway would refuse with a 409.
  expect(screen.queryByText("Agent is waiting")).toBeNull();
});

test("a resolved approval is not shown as waiting", () => {
  const live = applyThreadSnapshot(createLiveThreadState(TARGET), {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: {
      id: "thread_1",
      messages: [],
      activities: [
        approvalRequested("req_1"),
        {
          id: "act_resolved",
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: "req_1", decision: "accept" },
          turnId: "turn_1",
          sequence: 2,
          createdAt: "2026-08-24T12:00:02.000Z",
        },
      ],
      session: null,
    },
  });

  renderOperate({ liveThread: live });
  expect(screen.queryByText("Agent is waiting")).toBeNull();
});
