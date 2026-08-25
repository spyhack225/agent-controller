/**
 * Structured user input in the console — the questions the AGENT asks.
 *
 * THREE different things can stop a turn in this product, and the console must never let a reader
 * confuse them:
 *
 *   GATEWAY APPROVAL   a `Command` with status `approval_required`. The gateway refused to
 *                      dispatch something *you* asked for — "you tried to run `rm -rf`". Two
 *                      buttons; declining means the command is never sent.
 *
 *   PROVIDER APPROVAL  the agent stopped mid-turn to ask permission — "Claude wants to edit
 *                      src/app.mjs". FOUR answers. See frontend/src/providerApprovals.ts.
 *
 *   QUESTION           the agent needs you to TELL it something — "which database?", "pick a
 *                      branch name". The answer is a VALUE, not a verdict, and the legal values
 *                      come from the agent. This file.
 *
 * The shape of the question decides the control, and that is the whole point of this module: a
 * choice must be rendered as choices. Offering a free-text box for a question with three
 * enumerated options would make the owner guess at values the agent already listed, and the
 * providers do not forgive a near miss — an unrecognised label is silently dropped by OpenCode,
 * silently relabelled as an "Other" note by xAI, and a hard failure on Codex.
 *
 * Mirrored from `src/userInput.mjs`, which carries the full T3 contract evidence:
 *   packages/contracts/src/providerRuntime.ts:444-464   the question schema
 *   packages/contracts/src/orchestration.ts:830-837     `thread.user-input.respond`
 *   src/orchestration/Layers/ProviderRuntimeIngestion.ts:503-537  the two activity kinds
 *   src/orchestration/decider.ts:42-86                  when an abandoned request clears
 */

export type UserInputQuestionShape = "single-choice" | "multi-choice" | "free-text";

export type UserInputRequestStatus = "pending" | "resolved" | "stale";

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  /** The key the answer is filed under. On Claude this is the full question text. */
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  multiSelect: boolean;
  shape: UserInputQuestionShape;
}

/** What the gateway itself did about this question, which is not what T3 reports. */
export interface UserInputLocalAnswer {
  requestId: string;
  /** A digest, not the answer: the gateway never persists what was said. */
  answersHash: string;
  /** claimed | dispatched | held | failed. `held` waits on a gateway policy confirmation. */
  status: string;
  actorType: string;
  commandId: string | null;
  error: string | null;
  answeredAt: string | null;
}

export interface UserInputRequest {
  kind: "question";
  requestId: string;
  threadId: string | null;
  questions: UserInputQuestion[];
  summary: string;
  turnId: string | null;
  requestedAt: string | null;
  status: UserInputRequestStatus;
  /** False when no question on the request survived normalization; there is nothing to answer. */
  answerable: boolean;
  /** T3's own record of what was submitted, once it resolves. Relayed, never stored. */
  answers: Record<string, unknown> | null;
  resolvedAt: string | null;
  /** A `provider.user-input.respond.failed` detail, when one was reported. */
  failure: string | null;
  localAnswer: UserInputLocalAnswer | null;
}

/** An answer value as the gateway accepts it: `string` for a choice or free text, `string[]` for a multi-select. */
export type UserInputAnswerValue = string | string[];

export type UserInputAnswers = Record<string, UserInputAnswerValue>;

export const MAX_FREE_TEXT_ANSWER_CHARS = 4000;

/**
 * Port of T3's user-input `isStaleRequestFailureDetail` (src/orchestration/decider.ts:42-54).
 *
 * FOUR spellings, and none of them is one of the approval spellings — reusing the approval matcher
 * here would never match, and every abandoned question would render as pending forever.
 */
export function isStaleUserInputRequestDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending user-input request")
    || lowered.includes("unknown pending user-input request")
    || lowered.includes("unknown pending user input request")
    || lowered.includes("unknown pending codex user input request");
}

export function normalizeUserInputQuestion(raw: unknown): UserInputQuestion | null {
  const record = asRecord(raw);
  if (!record) return null;
  const question = stringOrNull(record.question);
  const id = stringOrNull(record.id) ?? question;
  if (!id) return null;

  const options: UserInputOption[] = (Array.isArray(record.options) ? record.options : [])
    .map((entry) => {
      const option = asRecord(entry);
      const label = stringOrNull(option?.label);
      return label ? { label, description: stringOrNull(option?.description) ?? label } : null;
    })
    .filter((option): option is UserInputOption => option !== null);

  const multiSelect = record.multiSelect === true;
  return {
    id,
    header: stringOrNull(record.header) ?? "Question",
    question: question ?? id,
    options,
    multiSelect,
    shape: options.length === 0
      ? "free-text"
      : multiSelect ? "multi-choice" : "single-choice",
  };
}

/**
 * Fold one T3 activity into a request list. Returns the SAME array reference when nothing changed,
 * so the live-thread reducer keeps its state identity for the overwhelmingly common irrelevant
 * activity.
 */
export function foldUserInputActivity(
  requests: readonly UserInputRequest[],
  activity: unknown,
  threadId: string | null,
): readonly UserInputRequest[] {
  const record = asRecord(activity);
  const payload = asRecord(record?.payload);
  const requestId = stringOrNull(payload?.requestId);
  // A request with no id cannot be answered by anyone: `thread.user-input.respond` requires one.
  if (!record || !requestId) return requests;
  const kind = stringOrNull(record.kind);

  if (kind === "user-input.requested") {
    const questions = (Array.isArray(payload?.questions) ? payload.questions : [])
      .map(normalizeUserInputQuestion)
      .filter((question): question is UserInputQuestion => question !== null);
    const next: UserInputRequest = {
      kind: "question",
      requestId,
      threadId,
      questions,
      summary: stringOrNull(record.summary) ?? "User input requested",
      turnId: stringOrNull(record.turnId),
      requestedAt: stringOrNull(record.createdAt),
      status: "pending",
      answerable: questions.length > 0,
      answers: null,
      resolvedAt: null,
      failure: null,
      localAnswer: null,
    };
    const index = requests.findIndex((entry) => entry.requestId === requestId);
    if (index === -1) return [...requests, next];
    const copy = [...requests];
    // A repeated request id means the agent is asking again; the previous answer no longer
    // applies to the question on screen.
    copy[index] = next;
    return copy;
  }

  const index = requests.findIndex((entry) => entry.requestId === requestId);
  if (index === -1) return requests;

  if (kind === "user-input.resolved") {
    const copy = [...requests];
    copy[index] = {
      ...copy[index],
      status: "resolved",
      answers: asRecord(payload?.answers),
      resolvedAt: stringOrNull(record.createdAt),
    };
    return copy;
  }

  if (kind === "provider.user-input.respond.failed") {
    const detail = stringOrNull(payload?.detail);
    const copy = [...requests];
    copy[index] = {
      ...copy[index],
      failure: detail,
      ...(isStaleUserInputRequestDetail(detail)
        ? { status: "stale" as const, resolvedAt: stringOrNull(record.createdAt) }
        : {}),
    };
    return copy;
  }

  return requests;
}

/** All user-input requests in a hydrated thread's work log, in request order. */
export function collectUserInputRequests(
  thread: unknown,
  threadId: string | null,
): UserInputRequest[] {
  const record = asRecord(thread);
  const activities = Array.isArray(record?.activities) ? [...record.activities] : [];
  activities.sort((left, right) => {
    const bySequence = (Number(asRecord(left)?.sequence) || 0) - (Number(asRecord(right)?.sequence) || 0);
    if (bySequence !== 0) return bySequence;
    return String(asRecord(left)?.createdAt ?? "").localeCompare(String(asRecord(right)?.createdAt ?? ""));
  });
  let requests: readonly UserInputRequest[] = [];
  for (const activity of activities) {
    requests = foldUserInputActivity(requests, activity, threadId);
  }
  return [...requests];
}

export function pendingUserInputRequests(
  requests: readonly UserInputRequest[],
): UserInputRequest[] {
  return requests.filter((request) => request.status === "pending");
}

/** Merges the gateway's answer rows onto requests derived from the stream. */
export function mergeUserInputAnswers(
  requests: readonly UserInputRequest[],
  answers: readonly UserInputLocalAnswer[],
): UserInputRequest[] {
  if (answers.length === 0) return [...requests];
  const byRequestId = new Map(answers.map((entry) => [entry.requestId, entry]));
  return requests.map((request) => {
    const localAnswer = byRequestId.get(request.requestId);
    return localAnswer ? { ...request, localAnswer } : request;
  });
}

// ---------------------------------------------------------------------------------------------
// Draft answers
// ---------------------------------------------------------------------------------------------
//
// The draft is what the form holds while it is being filled in; the submitted answer is what the
// gateway validates. `draftAnswers()` seeds one that is legal to *hold* but not necessarily legal
// to *send* — nothing is preselected, because a preselected choice is the console answering on the
// owner's behalf, and a question whose whole point is that the agent could not decide is exactly
// where that would be worst.

export type UserInputDraft = Record<string, string | string[]>;

export function draftAnswers(request: UserInputRequest): UserInputDraft {
  const draft: UserInputDraft = {};
  for (const question of request.questions) {
    draft[question.id] = question.shape === "multi-choice" ? [] : "";
  }
  return draft;
}

export function setDraftChoice(
  draft: UserInputDraft,
  question: UserInputQuestion,
  label: string,
): UserInputDraft {
  if (question.shape !== "multi-choice") return { ...draft, [question.id]: label };
  const current = Array.isArray(draft[question.id]) ? draft[question.id] as string[] : [];
  const next = current.includes(label)
    ? current.filter((entry) => entry !== label)
    // Kept in the question's own option order, so two owners picking the same two boxes in a
    // different order produce the same answer — and the same fingerprint at the gateway.
    : question.options.map((option) => option.label)
      .filter((entry) => entry === label || current.includes(entry));
  return { ...draft, [question.id]: next };
}

export function setDraftText(
  draft: UserInputDraft,
  question: UserInputQuestion,
  text: string,
): UserInputDraft {
  return { ...draft, [question.id]: text };
}

/**
 * Whether the draft is complete enough to send, and why not when it is not.
 *
 * A mirror of the gateway's `validateUserInputAnswers()`, run here only so the submit button can
 * be disabled with a reason rather than producing a 422. The gateway's copy is the authority: this
 * one is a courtesy and is never trusted.
 */
export function describeDraftGap(
  request: UserInputRequest,
  draft: UserInputDraft,
): string | null {
  for (const question of request.questions) {
    const value = draft[question.id];
    if (question.shape === "multi-choice") {
      if (!Array.isArray(value) || value.length === 0) return `Pick at least one option for "${question.header}".`;
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return question.shape === "free-text"
        ? `Type an answer for "${question.header}".`
        : `Choose an option for "${question.header}".`;
    }
    if (question.shape === "free-text" && value.length > MAX_FREE_TEXT_ANSWER_CHARS) {
      return `The answer to "${question.header}" is longer than ${MAX_FREE_TEXT_ANSWER_CHARS} characters.`;
    }
  }
  return null;
}

/** The draft as the wire wants it: `string` for a choice or free text, `string[]` for a multi-select. */
export function draftToAnswers(request: UserInputRequest, draft: UserInputDraft): UserInputAnswers {
  const answers: UserInputAnswers = {};
  for (const question of request.questions) {
    const value = draft[question.id];
    answers[question.id] = question.shape === "multi-choice"
      ? (Array.isArray(value) ? [...value] : [])
      : String(value ?? "");
  }
  return answers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
