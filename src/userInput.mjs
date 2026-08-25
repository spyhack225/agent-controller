// Structured user input: the questions an agent asks that are not requests for permission.
//
// THREE THINGS CAN BLOCK A TURN IN THIS PRODUCT, and they are three different questions with
// three different answers. Collapsing any two of them would be a correctness bug:
//
//   GATEWAY APPROVAL   `evaluateIntentPolicy()` refused to dispatch something the owner asked
//                      for — "you tried to run `rm -rf`". A `command` row with status
//                      `approval_required`, answered at POST /v1/commands/:id/approve|reject.
//                      Nothing has left the gateway. Stamped `kind: "gateway"`.
//
//   PROVIDER APPROVAL  a turn is already running inside T3 and the provider stopped mid-turn to
//                      ask permission — "Claude wants to edit src/app.mjs". Four answers
//                      (accept / acceptForSession / decline / cancel). Lives in T3, expires with
//                      the session. Stamped `kind: "provider"`. See src/providerApprovals.mjs.
//
//   QUESTION           the agent needs the owner to TELL it something — "which database should I
//                      migrate?", "pick a branch name". Not "may I?" but "which?". It is answered
//                      with a VALUE, not a verdict, and the set of legal values is supplied by the
//                      agent itself. Stamped `kind: "question"`. This module.
//
// Everything this module produces carries `kind: "question"`, and the routes, the store rows and
// the SSE events are all separate from both approval paths.
//
// ---------------------------------------------------------------------------------------------
// THE CONTRACT, ESTABLISHED FROM T3'S OWN SOURCE
// ---------------------------------------------------------------------------------------------
//
// Verified against the installed T3 Code 0.0.32 (`/opt/homebrew/lib/node_modules/t3/package.json`
// says 0.0.32); its source map at `/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` ships
// `sourcesContent` for every one of its own packages. Line numbers below are into those sources.
//
// WHY THIS IS NOT AN APPROVAL, IN T3'S OWN CODE:
//
//   `tool_user_input` is a member of `CanonicalRequestType`
//   (packages/contracts/src/providerRuntime.ts:135-145), and
//   src/orchestration/Layers/ProviderRuntimeIngestion.ts:372 and :403 return `[]` for it — a
//   `request.opened` / `request.resolved` carrying that type produces NO approval activity at all.
//   It travels on its own event pair instead, `user-input.requested` / `user-input.resolved`
//   (providerRuntime.ts:175-176), which the same file turns into its own activity kinds at
//   :503-537. So an agent asking a question is invisible to anything that only watches approvals,
//   which is exactly the gap this module closes.
//
// THE QUESTION SHAPE — one request carries MANY questions:
//
//   packages/contracts/src/providerRuntime.ts:444-464
//     UserInputQuestionOption = { label: NonEmptyString, description: NonEmptyString }
//     UserInputQuestion = {
//       id: NonEmptyString,
//       header: NonEmptyString,
//       question: NonEmptyString,
//       options: Array<UserInputQuestionOption>,        // REQUIRED array, MAY BE EMPTY
//       multiSelect?: Boolean (constructor default false),
//     }
//     UserInputRequestedPayload = { questions: Array<UserInputQuestion> }
//
//   There is no "supply a file path" shape and no free-form structured value: a question is a
//   prompt plus a list of labelled options, and that is the whole vocabulary. `options` being an
//   ordinary array with no minimum is what makes an unenumerated (free-text) question expressible,
//   and the adapters disagree about it (see FREE TEXT below) — so the three shapes this module
//   derives are the only ones the contract can produce:
//
//     single-choice   options.length > 0 && !multiSelect   answer: one option label
//     multi-choice    options.length > 0 &&  multiSelect   answer: a non-empty subset of labels
//     free-text       options.length === 0                 answer: an arbitrary string
//
// THE ANSWER SHAPE:
//
//   packages/contracts/src/orchestration.ts:141-142
//     ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown)
//
//   `Unknown` is not a licence to send anything. What the adapters actually accept is settled by
//   the code that consumes it, and the INTERSECTION of all five is `string | string[]`:
//
//     src/provider/Layers/CodexSessionRuntime.ts:775-792 (`toCodexUserInputAnswer`)
//       string -> [value]; string[] -> filtered; {answers:string[]} -> passthrough;
//       ANYTHING ELSE FAILS with CodexSessionRuntimeInvalidUserInputAnswersError.
//     src/provider/opencodeRuntime.ts:361-378 (`toOpenCodeQuestionAnswers`)
//       string[] -> filtered; non-empty string -> [value]; anything else -> [] (silently empty).
//     src/provider/acp/XAiAcpExtension.ts:112-122 (`answerValues`)
//       array of strings, or one string; anything else contributes nothing.
//     src/provider/Layers/ClaudeAdapter.ts:3888-3894
//       the record is handed to the Claude SDK VERBATIM as
//       `updatedInput: { questions, answers }` — so an object-shaped value that Codex would
//       accept is not something Claude understands.
//
//   The `{answers: [...]}` object form is therefore Codex-only and this gateway never emits it.
//   Single-select emits a `string`, multi-select emits a `string[]`.
//
// THE ANSWER KEY IS THE QUESTION ID, AND THE ID IS OFTEN THE QUESTION TEXT:
//
//   src/provider/Layers/ClaudeAdapter.ts:3782-3790 — the comment there is load-bearing:
//     "`id` MUST equal the full question text — Claude SDK >= 2.1.121 looks up answers by question
//      text in `mapToolResultToToolResultBlockParam`".
//   The lookups agree: XAiAcpExtension.ts:158-163 reads `answers[question.id ?? question.question]`
//   falling back to `answers[question.question]`, and opencodeRuntime.ts:366-369 tries the derived
//   id, then `question.header`, then `question.question`.
//   So the gateway keys answers by `question.id` verbatim and never invents a key. It also never
//   persists one: a question id is the question text, which is user content.
//
// SUBMITTING AN ANSWER:
//
//   packages/contracts/src/orchestration.ts:830-837
//     ThreadUserInputRespondCommand = { type:"thread.user-input.respond", commandId, threadId,
//                                       requestId, answers, createdAt }
//   It is a member of `DispatchableClientOrchestrationCommand` (:874) and of
//   `ClientOrchestrationCommand` (:901), which is the payload of POST /api/orchestration/dispatch.
//   So this needs no new transport: it is the same dispatch the gateway already speaks for
//   `thread.turn.start` and `thread.approval.respond`.
//
// DISCOVERING A PENDING QUESTION:
//
//   NOT from `GET /api/orchestration/snapshot`. That route serves the lightweight command read
//   model with "thread bodies empty" (src/orchestration/http.ts:31-38), so it has no activities.
//   `hasPendingUserInput` exists but only on `OrchestrationThreadShell`
//   (packages/contracts/src/orchestration.ts:441), which the snapshot route does not return.
//
//   The evidence is `thread.activities[]`, served by `GET /api/orchestration/threads/:threadId`
//   and by the live stream (`thread.activity-appended`, and the subscribeThread snapshot).
//   src/orchestration/Layers/ProviderRuntimeIngestion.ts:503-537 builds them:
//
//     kind "user-input.requested"  tone "info"  summary "User input requested"
//       payload { requestId?, questions }
//     kind "user-input.resolved"   tone "info"  summary "User input submitted"
//       payload { requestId?, answers }
//
//   Note the `tone` is "info", NOT "approval" — another reason an approval-shaped reader never
//   saw these. And note `requestId` is OPTIONAL on the wire (`...(event.requestId ? {…} : {})`).
//   A request with no id cannot be answered by anyone — `thread.user-input.respond` requires one —
//   so this module skips it rather than rendering a form that could never be submitted.
//
//   The `questions` array survives the wire intact. `projectActivityPayload`
//   (src/orchestration/ActivityPayloadProjection.ts:266-271) returns the activity UNCHANGED unless
//   `payload.data` is a record, and a user-input payload has no `data` — so nothing is slimmed.
//
// A REQUEST THAT WAS ABANDONED:
//
//   Same shape as the approval case and the same trap: T3 does NOT reject an answer to a dead
//   request at dispatch time. The decider only checks the thread exists
//   (src/orchestration/decider.ts:1027-1032); the failure happens asynchronously in the reactor,
//   which appends an activity instead:
//
//     src/orchestration/Layers/ProviderCommandReactor.ts:1253-1294
//       kind "provider.user-input.respond.failed", tone "error", payload { detail, requestId }
//
//   and when the provider no longer knows the request, `detail` is the sentence built at :283-287:
//     "Stale pending user-input request: <id>. Provider callback state does not survive app
//      restarts or recovered sessions. Restart the turn to continue."
//
//   T3's own decider treats such a failure as CLEARING the open request (decider.ts:42-86) — but
//   only when the detail marks it stale/unknown; an ordinary failure ("No active provider session
//   is bound to this thread.", ProviderCommandReactor.ts:1262-1270) leaves it open, because
//   something is still waiting. `collectUserInputRequests()` below is a port of that rule with the
//   same clearing conditions, so the gateway and T3 cannot disagree about what is still pending.
//
//   The stale phrases are NOT the same strings as the approval ones — decider.ts:49-52 lists four
//   distinct user-input spellings, and `isUnknownPendingUserInputRequestError`
//   (ProviderCommandReactor.ts:265-281) is where they come from. Reusing the approval matcher here
//   would silently never match, and every abandoned question would look pending forever.

import { createHash } from "node:crypto";

/** The three shapes a question can take. Derived from `options` and `multiSelect`, never guessed. */
export const USER_INPUT_QUESTION_SHAPES = Object.freeze([
  "single-choice",
  "multi-choice",
  "free-text",
]);

/**
 * An upper bound on a free-text answer.
 *
 * T3's own ceiling for a whole turn is `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`
 * (packages/contracts/src/orchestration.ts:144). An answer to one question is not a turn, and a
 * megabyte pasted into a text box should be refused here rather than by a provider three seconds
 * later — the same lesson as validating a model slug before dispatch.
 */
export const MAX_FREE_TEXT_ANSWER_CHARS = 4000;

// A controller has five keys and no keyboard. These bound what it is honest to render as a
// question it can actually answer; see `deviceUserInputView()`.
const DEVICE_MAX_OPTIONS = 4;
const DEVICE_MAX_OPTION_CHARS = 24;

/**
 * Port of T3's user-input half of `isStaleRequestFailureDetail`
 * (src/orchestration/decider.ts:42-54).
 *
 * Four distinct spellings, none of which is one of the approval spellings. A
 * `provider.user-input.respond.failed` clears the open request ONLY when the provider no longer
 * knows about it; any other failure leaves it open, because the agent is still blocked.
 */
export function isStaleUserInputRequestDetail(detail) {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending user-input request")
    || lowered.includes("unknown pending user-input request")
    || lowered.includes("unknown pending user input request")
    || lowered.includes("unknown pending codex user input request");
}

/**
 * One question, normalized and classified.
 *
 * @returns {object|null} null when the question carries neither an id nor prompt text, which
 *   makes it unanswerable: there would be no key to file the answer under.
 */
export function normalizeUserInputQuestion(raw) {
  const record = asRecord(raw);
  if (!record) return null;
  const question = stringOrNull(record.question);
  // `id` is required by the contract, but every consumer falls back to the question text when it
  // is missing (XAiAcpExtension.ts:158-163, opencodeRuntime.ts:366-369) so the gateway does too —
  // falling back to something else would file the answer under a key nothing reads.
  const id = stringOrNull(record.id) ?? question;
  if (!id) return null;

  const options = (Array.isArray(record.options) ? record.options : [])
    .map((entry) => {
      const option = asRecord(entry);
      const label = stringOrNull(option?.label);
      return label ? { label, description: stringOrNull(option?.description) ?? label } : null;
    })
    .filter((option) => option !== null);

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
 * Every user-input request this thread's work log knows about, oldest first.
 *
 * Ordering is not the array order: activities carry an optional per-turn `sequence`
 * (packages/contracts/src/orchestration.ts:323) and a `createdAt`, and a resolution must be
 * applied after the request it resolves. Sorted on (sequence, createdAt), exactly as
 * `collectProviderApprovals()` and `pendingThreadInteractions()` already do.
 *
 * @param {object|null} thread a hydrated thread from GET /api/orchestration/threads/:threadId, or
 *   the `thread` of a live-stream snapshot. A thread with no `activities` yields nothing — the
 *   correct answer for the bodiless shell snapshot, not an error.
 */
export function collectUserInputRequests(thread, { threadId = null } = {}) {
  const activities = Array.isArray(thread?.activities) ? [...thread.activities] : [];
  activities.sort((left, right) => {
    const bySequence = (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0);
    if (bySequence !== 0) return bySequence;
    return String(left?.createdAt ?? "").localeCompare(String(right?.createdAt ?? ""));
  });

  const resolvedThreadId = stringOrNull(threadId) ?? stringOrNull(thread?.id);
  /** @type {Map<string, object>} */
  const byRequestId = new Map();

  for (const activity of activities) {
    const payload = asRecord(activity?.payload);
    const requestId = stringOrNull(payload?.requestId);
    // No request id means no `thread.user-input.respond` can name it. Not renderable, not
    // answerable, and not this module's business to pretend otherwise.
    if (!requestId) continue;
    const kind = stringOrNull(activity?.kind);

    if (kind === "user-input.requested") {
      const questions = (Array.isArray(payload?.questions) ? payload.questions : [])
        .map(normalizeUserInputQuestion)
        .filter((question) => question !== null);
      // A repeated request id restarts the record: the agent is asking again.
      byRequestId.set(requestId, {
        kind: "question",
        requestId,
        threadId: resolvedThreadId,
        activityId: stringOrNull(activity?.id),
        // The agent's own words, and the labels it authored. User content: relayed live, never
        // persisted by the gateway.
        questions,
        summary: stringOrNull(activity?.summary) ?? "User input requested",
        turnId: stringOrNull(activity?.turnId),
        requestedAt: stringOrNull(activity?.createdAt),
        status: "pending",
        // A request whose questions all failed to normalize cannot be answered from anywhere; the
        // console must say so rather than render an empty form.
        answerable: questions.length > 0,
        answers: null,
        resolvedAt: null,
        failure: null,
      });
      continue;
    }

    const existing = byRequestId.get(requestId);
    if (!existing) continue;

    if (kind === "user-input.resolved") {
      existing.status = "resolved";
      // Relayed so a transcript can show what was answered. Never written to the store.
      existing.answers = asRecord(payload?.answers);
      existing.resolvedAt = stringOrNull(activity?.createdAt);
      continue;
    }

    if (kind === "provider.user-input.respond.failed") {
      const detail = stringOrNull(payload?.detail);
      existing.failure = detail;
      // T3's own rule: only a stale/unknown failure closes the request.
      if (isStaleUserInputRequestDetail(detail)) {
        existing.status = "stale";
        existing.resolvedAt = stringOrNull(activity?.createdAt);
      }
    }
  }

  return [...byRequestId.values()];
}

/** Just the ones still blocking the agent. */
export function pendingUserInputRequests(thread, options = {}) {
  return collectUserInputRequests(thread, options)
    .filter((request) => request.status === "pending");
}

export function findUserInputRequest(thread, requestId, options = {}) {
  const wanted = stringOrNull(requestId);
  if (!wanted) return null;
  return collectUserInputRequests(thread, options)
    .find((request) => request.requestId === wanted) ?? null;
}

/**
 * Validate an answer set against the request's OWN questions, before anything is dispatched.
 *
 * This is the model-slug lesson from CLAUDE.md applied to a second surface: T3 accepts a dispatch
 * and only then has the provider reject it, which produces a command stuck at `dispatched` forever
 * with no reply. Worse here than for a model slug, because the failure mode is silent in three
 * different ways depending on which provider is behind the thread:
 *
 *   - Codex FAILS the whole response (CodexSessionRuntime.ts:792) if any value is not a string,
 *     a string array, or `{answers: string[]}`.
 *   - OpenCode SILENTLY answers `[]` for a value it does not understand
 *     (opencodeRuntime.ts:376), so the agent receives an empty answer and carries on.
 *   - xAI SILENTLY relabels an unrecognised value as an "Other" note
 *     (XAiAcpExtension.ts:133-155), so free text sent to an enumerated question becomes an
 *     annotation the agent may or may not read.
 *
 * A gateway that let any of those through would be guessing on the owner's behalf. So:
 *
 *   - every question must be answered, and nothing but the questions may be answered. An extra key
 *     is a mistyped question id, and accepting it would drop the real answer silently.
 *   - a choice must be an EXACT option label. Labels are the only values the consumers match on
 *     (`optionByLabel` in XAiAcpExtension.ts:130), so a near-miss is not a near-miss, it is a
 *     different answer.
 *   - a multi-select must be a non-empty array of distinct labels; an empty array is the same as
 *     not answering, and a duplicate is a client bug that would reach the provider as one.
 *
 * @returns {{valid: true, answers: object} | {valid: false, reason: string, questionId?: string}}
 */
export function validateUserInputAnswers(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) {
    return { valid: false, reason: "This request has no answerable questions." };
  }
  const record = asRecord(answers);
  if (!record) {
    return { valid: false, reason: "answers must be an object keyed by question id." };
  }

  const byId = new Map(list.map((question) => [question.id, question]));
  for (const key of Object.keys(record)) {
    if (!byId.has(key)) {
      return {
        valid: false,
        reason: `answers contains ${JSON.stringify(key)}, which is not a question on this request.`,
      };
    }
  }

  const output = {};
  for (const question of list) {
    if (!Object.hasOwn(record, question.id)) {
      return {
        valid: false,
        reason: `No answer supplied for question ${JSON.stringify(question.id)}.`,
        questionId: question.id,
      };
    }
    const value = record[question.id];
    const labels = question.options.map((option) => option.label);

    if (question.shape === "free-text") {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          valid: false,
          reason: "This question takes free text; the answer must be a non-empty string.",
          questionId: question.id,
        };
      }
      if (value.length > MAX_FREE_TEXT_ANSWER_CHARS) {
        return {
          valid: false,
          reason: `A free-text answer may be at most ${MAX_FREE_TEXT_ANSWER_CHARS} characters.`,
          questionId: question.id,
        };
      }
      output[question.id] = value;
      continue;
    }

    if (question.shape === "single-choice") {
      if (typeof value !== "string" || !labels.includes(value)) {
        return {
          valid: false,
          reason: `This question expects exactly one of: ${labels.map((label) => JSON.stringify(label)).join(", ")}.`,
          questionId: question.id,
        };
      }
      output[question.id] = value;
      continue;
    }

    // multi-choice
    if (!Array.isArray(value) || value.length === 0) {
      return {
        valid: false,
        reason: "This question allows several answers; supply a non-empty array of option labels.",
        questionId: question.id,
      };
    }
    const seen = new Set();
    for (const entry of value) {
      if (typeof entry !== "string" || !labels.includes(entry)) {
        return {
          valid: false,
          reason: `Every answer must be one of: ${labels.map((label) => JSON.stringify(label)).join(", ")}.`,
          questionId: question.id,
        };
      }
      if (seen.has(entry)) {
        return {
          valid: false,
          reason: `Option ${JSON.stringify(entry)} was selected twice.`,
          questionId: question.id,
        };
      }
      seen.add(entry);
    }
    // Emitted in the question's own option order, not the client's click order: the value is a
    // SET, and two clients picking the same two options must produce the same fingerprint.
    output[question.id] = labels.filter((label) => seen.has(label));
  }

  return { valid: true, answers: output };
}

/**
 * A stable fingerprint of an answer set, used as the idempotency key.
 *
 * The store never holds the answers themselves — question ids are question text and free text is
 * whatever the owner typed, so both are user content and neither belongs in a row that support
 * diagnostics can reach. A hash gives the claim everything it needs: two clients sending the SAME
 * answer are a duplicate, two clients sending DIFFERENT answers are a conflict, and the row
 * carries nothing readable either way.
 *
 * Keys are sorted so object insertion order cannot make one answer look like two. Array values
 * arrive already sorted into option order by `validateUserInputAnswers()`.
 */
export function userInputAnswersFingerprint(answers) {
  const record = asRecord(answers) ?? {};
  const canonical = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * Whether a controller can honestly answer this request.
 *
 * The hardware is a 240x320 panel with five keys and no keyboard. What it can do is offer a short
 * list and let someone press one. What it cannot do is take dictation, or hold a multi-part form,
 * or let someone build a subset out of eight options with two arrow keys.
 *
 * So exactly one shape is answerable from the device realm: ONE single-choice question, with two
 * to four options, each short enough to render on one line. Everything else is shown — an owner
 * walking past the desk must be able to see the agent is blocked — and refused, with the answer
 * pointed at the console. A box that guesses is worse than a box that says "not here".
 */
export function isDeviceAnswerableUserInput(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  if (questions.length !== 1) return false;
  const [question] = questions;
  if (question.shape !== "single-choice") return false;
  if (question.options.length < 2 || question.options.length > DEVICE_MAX_OPTIONS) return false;
  return question.options.every((option) => compact(option.label).length <= DEVICE_MAX_OPTION_CHARS);
}

/**
 * What a controller needs, and nothing else.
 *
 * Deliberately smaller than the console record: no activity id, no turn id, no resolved answers,
 * no per-option descriptions. `prompt` is clipped because an agent can ask a question in a
 * paragraph and a 240x320 panel cannot render one.
 *
 * `answerable` is false far more often than true, and that is the point: the view still carries
 * the question so the device can say "the agent is asking you something", plus `hint` — the exact
 * sentence to put on screen when there is nothing to press.
 */
export function deviceUserInputView(request, { promptLimit = 120, headerLimit = 32 } = {}) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const first = questions[0] ?? null;
  const answerable = isDeviceAnswerableUserInput(request);
  return {
    kind: "question",
    requestId: request.requestId,
    threadId: request.threadId,
    title: clip(first?.header, headerLimit) ?? "The agent has a question",
    prompt: clip(first?.question, promptLimit),
    questionCount: questions.length,
    shape: first?.shape ?? null,
    // Present only when they are the thing to press. A list the device cannot act on is a list
    // that invites a press it would have to refuse.
    options: answerable ? first.options.map((option) => compact(option.label)) : null,
    // The key the answer must be filed under. The device echoes it back verbatim; it never
    // constructs one, because on Claude the id is the full question text.
    questionId: answerable ? first.id : null,
    answerable,
    hint: answerable ? null : "Answer this in the console.",
    requestedAt: request.requestedAt,
  };
}

function clip(value, limit) {
  const text = compact(value);
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function compact(value) {
  const text = stringOrNull(value);
  return text ? text.replace(/\s+/gu, " ").trim() : "";
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
