import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { Controller } from "../controller";
import { applyThreadSnapshot, createLiveThreadState } from "../liveThread";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

const DB_KEY = "Which database should I migrate?";

const CHOICE = {
  id: DB_KEY,
  header: "Database",
  question: DB_KEY,
  options: [
    { label: "staging", description: "The shared staging database" },
    { label: "production", description: "The live database" },
  ],
  multiSelect: false,
};

const MULTI = {
  id: "q_multi",
  header: "Checks",
  question: "Which checks should I run?",
  options: [
    { label: "lint", description: "eslint" },
    { label: "test", description: "vitest" },
  ],
  multiSelect: true,
};

const TEXT = { id: "q_text", header: "Branch", question: "Name the branch", options: [] };

function userInputRequested(requestId: string, questions: unknown[]) {
  return {
    id: `act_${requestId}`,
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: { requestId, questions },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

/** A provider approval — a different question entirely. */
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
    sequence: 2,
    createdAt: "2026-08-24T12:00:01.000Z",
  };
}

/** A gateway policy hold — the third kind. */
const gatewayHold = {
  id: "cmd_1",
  status: "approval_required",
  risk: "high",
  threadId: "thread_1",
  environmentId: "env_1",
  intent: { type: "shell_input", command: "sudo rm -rf /" },
  createdAt: "2026-08-24T12:00:00.000Z",
};

function liveWith(activities: unknown[]) {
  return applyThreadSnapshot(createLiveThreadState(TARGET), {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: { id: "thread_1", messages: [], activities, session: null },
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
    providerApprovalDecisions: {},
    answerProviderApproval: vi.fn(async () => ({})),
    userInputAnswers: {},
    answerUserInput: vi.fn(async () => ({})),
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

test("a choice is offered as choices, not as a text box to guess into", () => {
  renderOperate({ liveThread: liveWith([userInputRequested("req_q", [CHOICE])]) });

  expect(screen.getByText("Agent has a question")).toBeTruthy();
  expect(screen.getByText(DB_KEY)).toBeTruthy();
  // The agent's own labels, as radios — never a free-text field the owner has to guess into.
  const staging = screen.getByRole("radio", { name: /staging/u }) as HTMLInputElement;
  const production = screen.getByRole("radio", { name: /production/u }) as HTMLInputElement;
  expect(staging.checked).toBe(false);
  expect(production.checked).toBe(false);
  // No free-text field INSIDE the question card: the composer below is a different control.
  const card = document.querySelector('[data-approval-kind="question"]')!;
  expect(card.querySelector("textarea")).toBeNull();
  expect(card.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  // The descriptions the agent wrote are shown too.
  expect(screen.getByText("The shared staging database")).toBeTruthy();
});

test("a multi-select is offered as checkboxes and a free-text question as a textarea", () => {
  renderOperate({ liveThread: liveWith([userInputRequested("req_q", [MULTI, TEXT])]) });

  const card = document.querySelector('[data-approval-kind="question"]')!;
  expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: /Name the branch/u })).toBeTruthy();
  // No radios: neither of these questions is a single choice.
  expect(card.querySelectorAll('input[type="radio"]')).toHaveLength(0);
});

test("the send button waits until every question is answered", () => {
  const answerUserInput = vi.fn(async () => ({}));
  renderOperate({
    liveThread: liveWith([userInputRequested("req_q", [CHOICE, TEXT])]),
    answerUserInput,
  });

  const send = screen.getByRole("button", { name: /Send answer/u }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(screen.getByText(/Choose an option for "Database"/u)).toBeTruthy();

  fireEvent.click(screen.getByRole("radio", { name: /staging/u }));
  expect((screen.getByRole("button", { name: /Send answer/u }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Type an answer for "Branch"/u)).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: /Name the branch/u }), {
    target: { value: "feat/migrate" },
  });
  const ready = screen.getByRole("button", { name: /Send answer/u }) as HTMLButtonElement;
  expect(ready.disabled).toBe(false);

  fireEvent.click(ready);
  expect(answerUserInput).toHaveBeenCalledWith(
    { environmentId: "env_1", threadId: "thread_1" },
    "req_q",
    { [DB_KEY]: "staging", q_text: "feat/migrate" },
  );
});

test("a multi-select sends an array in the agent's own option order", () => {
  const answerUserInput = vi.fn(async () => ({}));
  renderOperate({ liveThread: liveWith([userInputRequested("req_q", [MULTI])]), answerUserInput });

  // Clicked test first, then lint.
  fireEvent.click(screen.getByRole("checkbox", { name: /vitest/u }));
  fireEvent.click(screen.getByRole("checkbox", { name: /eslint/u }));
  fireEvent.click(screen.getByRole("button", { name: /Send answer/u }));

  expect(answerUserInput).toHaveBeenCalledWith(
    { environmentId: "env_1", threadId: "thread_1" },
    "req_q",
    { q_multi: ["lint", "test"] },
  );
});

test("all three blocking kinds render as three separate cards", () => {
  renderOperate({
    liveThread: liveWith([userInputRequested("req_q", [CHOICE]), approvalRequested("req_a")]),
    pendingApprovals: [gatewayHold],
  });

  // 1. A gateway hold: the gateway refused to send something the OWNER asked for.
  expect(screen.getByText("Approval required")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Approve/u })).toBeTruthy();
  // 2. A provider approval: the agent is asking permission. Four decisions.
  expect(screen.getByText("Agent is waiting")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Allow for this session/u })).toBeTruthy();
  // 3. A question: the agent is asking for a value. No decisions at all.
  expect(screen.getByText("Agent has a question")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Send answer/u })).toBeTruthy();

  const cards = document.querySelectorAll(".thread-approval");
  expect(cards.length).toBe(3);
  expect([...cards].map((card) => card.getAttribute("data-approval-kind")))
    .toEqual([null, "provider", "question"]);
});

test("a question this account already answered stops offering the form", () => {
  renderOperate({
    liveThread: liveWith([userInputRequested("req_q", [CHOICE])]),
    userInputAnswers: {
      req_q: {
        requestId: "req_q",
        answersHash: "a".repeat(64),
        status: "dispatched",
        actorType: "user",
        commandId: "cmd_9",
        error: null,
        answeredAt: "2026-08-24T12:00:05.000Z",
      },
    },
  });

  // The answer is on its way to the provider. Offering the form again would invite a second,
  // conflicting answer the gateway would refuse with a 409.
  expect(screen.queryByText("Agent has a question")).toBeNull();
});

test("a question T3 resolved or abandoned is not shown as waiting", () => {
  const resolved = liveWith([
    userInputRequested("req_q", [CHOICE]),
    {
      id: "act_resolved",
      tone: "info",
      kind: "user-input.resolved",
      summary: "User input submitted",
      payload: { requestId: "req_q", answers: { [DB_KEY]: "staging" } },
      sequence: 2,
      createdAt: "2026-08-24T12:00:02.000Z",
    },
  ]);
  renderOperate({ liveThread: resolved });
  expect(screen.queryByText("Agent has a question")).toBeNull();
});
