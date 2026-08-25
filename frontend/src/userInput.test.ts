import { describe, expect, test } from "vitest";

import {
  collectUserInputRequests,
  describeDraftGap,
  draftAnswers,
  draftToAnswers,
  foldUserInputActivity,
  isStaleUserInputRequestDetail,
  mergeUserInputAnswers,
  normalizeUserInputQuestion,
  pendingUserInputRequests,
  setDraftChoice,
  setDraftText,
  type UserInputRequest,
} from "./userInput";

const CHOICE = {
  id: "Which database should I migrate?",
  header: "Database",
  question: "Which database should I migrate?",
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
    { label: "build", description: "tsc" },
  ],
  multiSelect: true,
};

const TEXT = { id: "q_text", header: "Branch", question: "Name the branch", options: [] };

function requested(requestId: string, questions: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: `act_${requestId}`,
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: { requestId, questions },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function build(questions: unknown[]): UserInputRequest {
  return collectUserInputRequests(
    { id: "thread_1", activities: [requested("req_1", questions)] },
    "thread_1",
  )[0];
}

describe("the shape of a question is derived, never guessed", () => {
  test("options and multiSelect decide it", () => {
    const request = build([CHOICE, MULTI, TEXT]);
    expect(request.kind).toBe("question");
    expect(request.questions.map((question) => question.shape))
      .toEqual(["single-choice", "multi-choice", "free-text"]);
    expect(request.answerable).toBe(true);
  });

  test("a question with no id falls back to its text, and one with neither is dropped", () => {
    expect(normalizeUserInputQuestion({ header: "h", question: "Pick one", options: [] })?.id)
      .toBe("Pick one");
    expect(normalizeUserInputQuestion({ header: "h", options: [] })).toBeNull();
    expect(normalizeUserInputQuestion(null)).toBeNull();
  });

  test("a request whose questions all fail to normalize is not answerable", () => {
    const request = build([{ header: "h" }]);
    expect(request.answerable).toBe(false);
    expect(request.questions).toHaveLength(0);
  });
});

describe("folding the live stream", () => {
  test("a resolution closes it and a repeat re-opens it", () => {
    let requests = foldUserInputActivity([], requested("req_1", [CHOICE]), "thread_1");
    expect(pendingUserInputRequests(requests as UserInputRequest[])).toHaveLength(1);

    requests = foldUserInputActivity(requests, {
      id: "act_resolved",
      kind: "user-input.resolved",
      payload: { requestId: "req_1", answers: { [CHOICE.id]: "staging" } },
      createdAt: "2026-08-24T12:00:02.000Z",
    }, "thread_1");
    expect(requests[0].status).toBe("resolved");
    expect(pendingUserInputRequests(requests as UserInputRequest[])).toHaveLength(0);

    // The agent asks the same thing again; the old resolution must not silence it.
    requests = foldUserInputActivity(requests, requested("req_1", [CHOICE]), "thread_1");
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("pending");
  });

  test("only a stale respond-failure closes the request", () => {
    const stale = "Stale pending user-input request: req_1. Provider callback state does not "
      + "survive app restarts or recovered sessions. Restart the turn to continue.";
    expect(isStaleUserInputRequestDetail(stale)).toBe(true);
    expect(isStaleUserInputRequestDetail("Unknown pending codex user input request: req_1")).toBe(true);
    // The APPROVAL wording must not match: T3 keeps four distinct user-input spellings.
    expect(isStaleUserInputRequestDetail("Stale pending approval request: req_1.")).toBe(false);

    const failWith = (detail: string) => foldUserInputActivity(
      foldUserInputActivity([], requested("req_1", [CHOICE]), "thread_1"),
      {
        id: "act_fail",
        kind: "provider.user-input.respond.failed",
        payload: { requestId: "req_1", detail },
        createdAt: "2026-08-24T12:00:03.000Z",
      },
      "thread_1",
    )[0];

    expect(failWith(stale).status).toBe("stale");
    expect(failWith("No active provider session is bound to this thread.").status).toBe("pending");
  });

  test("an irrelevant activity returns the same array reference", () => {
    const requests = foldUserInputActivity([], requested("req_1", [CHOICE]), "thread_1");
    const same = foldUserInputActivity(requests, {
      id: "act_tool",
      kind: "tool.started",
      payload: { itemType: "command_execution" },
    }, "thread_1");
    expect(same).toBe(requests);
  });

  test("an approval activity is not folded in here", () => {
    // ProviderRuntimeIngestion.ts:372 keeps `tool_user_input` off the approval path entirely, and
    // this is the mirror of that: the two folds never see each other's rows.
    const requests = foldUserInputActivity([], {
      id: "act_a",
      kind: "approval.requested",
      payload: { requestId: "req_a", requestKind: "command", detail: "npm test" },
    }, "thread_1");
    expect(requests).toEqual([]);
  });

  test("an activity with no requestId is ignored", () => {
    expect(foldUserInputActivity([], {
      kind: "user-input.requested",
      payload: { questions: [CHOICE] },
    }, "thread_1")).toEqual([]);
  });
});

describe("drafts", () => {
  test("nothing is preselected", () => {
    const request = build([CHOICE, MULTI, TEXT]);
    expect(draftAnswers(request)).toEqual({
      [CHOICE.id]: "",
      q_multi: [],
      q_text: "",
    });
    expect(describeDraftGap(request, draftAnswers(request))).toMatch(/Choose an option/u);
  });

  test("a single choice replaces; a multi choice toggles and keeps option order", () => {
    const request = build([CHOICE, MULTI]);
    const [choice, multi] = request.questions;
    let draft = draftAnswers(request);

    draft = setDraftChoice(draft, choice, "production");
    draft = setDraftChoice(draft, choice, "staging");
    expect(draft[choice.id]).toBe("staging");

    draft = setDraftChoice(draft, multi, "build");
    draft = setDraftChoice(draft, multi, "lint");
    // Clicked build then lint; stored in the agent's own option order, so two owners picking the
    // same boxes produce the same answer.
    expect(draft.q_multi).toEqual(["lint", "build"]);

    draft = setDraftChoice(draft, multi, "build");
    expect(draft.q_multi).toEqual(["lint"]);
  });

  test("the gap is described per question until every one is answered", () => {
    const request = build([CHOICE, TEXT]);
    const [choice, text] = request.questions;
    let draft = draftAnswers(request);

    expect(describeDraftGap(request, draft)).toContain("Database");
    draft = setDraftChoice(draft, choice, "staging");
    expect(describeDraftGap(request, draft)).toMatch(/Type an answer for "Branch"/u);
    draft = setDraftText(draft, text, "feat/migrate");
    expect(describeDraftGap(request, draft)).toBeNull();

    draft = setDraftText(draft, text, "x".repeat(4001));
    expect(describeDraftGap(request, draft)).toMatch(/longer than 4000/u);
  });

  test("the wire form is a string for a choice and an array for a multi-select", () => {
    const request = build([CHOICE, MULTI, TEXT]);
    const [choice, multi, text] = request.questions;
    let draft = draftAnswers(request);
    draft = setDraftChoice(draft, choice, "staging");
    draft = setDraftChoice(draft, multi, "test");
    draft = setDraftText(draft, text, "feat/migrate");

    expect(draftToAnswers(request, draft)).toEqual({
      [CHOICE.id]: "staging",
      q_multi: ["test"],
      q_text: "feat/migrate",
    });
  });
});

test("the gateway's answer rows merge onto requests derived from the stream", () => {
  const requests = [build([CHOICE])];
  const merged = mergeUserInputAnswers(requests, [{
    requestId: "req_1",
    answersHash: "a".repeat(64),
    status: "dispatched",
    actorType: "user",
    commandId: "cmd_1",
    error: null,
    answeredAt: "2026-08-24T12:00:05.000Z",
  }]);
  expect(merged[0].localAnswer?.status).toBe("dispatched");
  expect(pendingUserInputRequests(merged).filter((request) => !request.localAnswer)).toHaveLength(0);
});
