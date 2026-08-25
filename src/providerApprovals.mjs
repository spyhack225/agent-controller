// Provider approvals: the questions T3 asks on the agent's behalf.
//
// There are TWO approval concepts in this system and they are not the same question.
//
//   GATEWAY APPROVAL   `evaluateIntentPolicy()` refused to dispatch something the owner asked
//                      for — "you tried to run `rm -rf`". It is a `command` row with status
//                      `approval_required`, answered at POST /v1/commands/:id/approve|reject.
//                      Nothing has left the gateway; declining means the intent is never sent.
//
//   PROVIDER APPROVAL  a turn is ALREADY RUNNING inside T3 and the provider has stopped mid-turn
//                      to ask permission — "Claude wants to edit src/app.mjs". It is not a
//                      gateway record at all: it lives in T3, it is holding a live provider
//                      callback open, and it expires with the session. Declining does not undo a
//                      dispatch, it answers a question the agent is blocked on.
//
// Collapsing those into one list would be a correctness bug, not a cosmetic one: the buttons mean
// different things, the consequences differ, and one of the two has a timeout the gateway does not
// control. Every record this module produces is stamped `kind: "provider"`, and gateway approvals
// are stamped `kind: "gateway"` where the two are surfaced side by side.
//
// ---------------------------------------------------------------------------------------------
// THE CONTRACT, ESTABLISHED FROM T3'S OWN SOURCE
// ---------------------------------------------------------------------------------------------
//
// Verified against the installed T3 Code 0.0.32 (`/opt/homebrew/lib/node_modules/t3/package.json`
// says 0.0.32); its source map at `/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` ships
// `sourcesContent` for every one of its own packages. Line numbers below are into those sources.
//
// THE DECISION SET — four values, not two:
//
//   packages/contracts/src/orchestration.ts:134-140
//     export const ProviderApprovalDecision = Schema.Literals([
//       "accept", "acceptForSession", "decline", "cancel",
//     ]);
//
//   What each one MEANS is settled by the adapters, not guessed:
//     src/provider/acp/AcpAdapterSupport.ts:46-56 maps them to the ACP permission outcomes
//       acceptForSession -> "allow-always"   accept -> "allow-once"   decline -> "reject-once"
//     src/provider/Layers/ClaudeAdapter.ts:4033-4050 maps them to the Claude SDK PermissionResult
//       accept/acceptForSession -> {behavior:"allow"}, and acceptForSession additionally returns
//       `updatedPermissions: [...pendingApproval.suggestions]` — i.e. it WRITES A RULE, which is
//       exactly why it is treated as a distinct capability by the policy engine.
//       decline -> {behavior:"deny", message:"User declined tool execution."}
//       cancel  -> {behavior:"deny", message:"User cancelled tool execution."} and is also what
//                  the adapter resolves a pending decision to when the turn is torn down
//                  (ClaudeAdapter.ts:3604, :3998).
//
// SUBMITTING A DECISION:
//
//   packages/contracts/src/orchestration.ts:821-828
//     ThreadApprovalRespondCommand = {type:"thread.approval.respond", commandId, threadId,
//                                     requestId, decision, createdAt}
//   It is a member of ClientOrchestrationCommand (:898), which is the payload of
//   POST /api/orchestration/dispatch (packages/contracts/src/environmentHttp.ts:495-499). So no
//   new transport: the same dispatch the gateway already speaks.
//
// DISCOVERING A PENDING APPROVAL:
//
//   NOT from `GET /api/orchestration/snapshot`. That route serves the *shell* read model with
//   "thread bodies empty" (src/orchestration/http.ts:35-38) — test/fixtures/t3-snapshot.json
//   confirms no `activities` on any thread. `hasPendingApprovals` exists but only on
//   OrchestrationThreadShell (orchestration.ts:440), which that route does not return either.
//
//   The evidence is `thread.activities[]`, served by `GET /api/orchestration/threads/:threadId`
//   and by the live stream (`thread.activity-appended` events, and the subscribeThread snapshot).
//   src/orchestration/Layers/ProviderRuntimeIngestion.ts:371-415 builds them:
//
//     kind "approval.requested"  tone "approval"
//       payload {requestId, requestKind?, requestType, detail?}
//     kind "approval.resolved"   tone "approval"
//       payload {requestId, requestKind?, requestType, decision?}
//
//   `requestKind` is command | file-read | file-change, derived from the canonical request type
//   at :296-311. `tool_user_input` requests are deliberately excluded there (:372) — those are
//   structured user input, a different feature, and they are excluded here too.
//
//   These payloads survive the wire: `projectActivityPayload`
//   (src/orchestration/ActivityPayloadProjection.ts) slims only payloads that carry a `data`
//   object, and an approval payload has none, so it is returned untouched.
//
// A REQUEST THAT WAS ABANDONED:
//
//   T3 does NOT reject a response to a dead request at dispatch time. The decider only checks the
//   thread exists (src/orchestration/decider.ts:1001-1005); the failure happens asynchronously in
//   the reactor, which appends an activity instead:
//
//     src/orchestration/Layers/ProviderCommandReactor.ts:1210-1249
//       kind "provider.approval.respond.failed", tone "error",
//       payload {detail, requestId}
//
//   and when the provider no longer knows the request, `detail` is the sentence built at :281-287:
//     "Stale pending approval request: <id>. Provider callback state does not survive app
//      restarts or recovered sessions. Restart the turn to continue."
//
//   T3's own decider treats such a failure as CLEARING the open request
//   (decider.ts:42-86, `hasOpenBlockingRequest` + `isStaleRequestFailureDetail`) — but only when
//   the detail marks it stale/unknown; an ordinary failure leaves the request open, because the
//   provider is still waiting. `collectProviderApprovals()` below is a port of that rule, with the
//   same clearing conditions, so the gateway and T3 cannot disagree about what is still pending.

/** The four decisions T3 accepts. Order is the order a UI should offer them. */
export const PROVIDER_APPROVAL_DECISIONS = Object.freeze([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

/**
 * Decisions that leave a standing rule behind rather than answering one question.
 *
 * Only `acceptForSession` does: ClaudeAdapter.ts:4036-4042 returns `updatedPermissions` with it
 * and nothing else, and the ACP mapping calls it "allow-always". A durable grant is a different
 * decision from a one-off yes, so the policy engine gates it as its own capability.
 */
export const PERSISTENT_PROVIDER_APPROVAL_DECISIONS = Object.freeze(["acceptForSession"]);

/**
 * The binary vocabulary that existed before the full set was established.
 *
 * Firmware in the field posts `approve` / `reject` and cannot be changed from here, so both keep
 * working — as ALIASES onto the canonical values, never as a separate wire vocabulary.
 */
export const LEGACY_PROVIDER_APPROVAL_DECISIONS = Object.freeze({
  approve: "accept",
  reject: "decline",
});

const DECISION_SET = new Set(PROVIDER_APPROVAL_DECISIONS);
const PERSISTENT_SET = new Set(PERSISTENT_PROVIDER_APPROVAL_DECISIONS);

/** Human-facing description of each decision, for a console that must not lie about the choice. */
export const PROVIDER_APPROVAL_DECISION_CATALOGUE = Object.freeze([
  {
    decision: "accept",
    label: "Allow once",
    description: "Run this one request. The agent asks again next time.",
    persistent: false,
    allows: true,
  },
  {
    decision: "acceptForSession",
    label: "Allow for this session",
    description: "Run it, and stop asking for the same thing until the session ends.",
    persistent: true,
    allows: true,
  },
  {
    decision: "decline",
    label: "Decline",
    description: "Refuse this request. The agent is told and keeps working.",
    persistent: false,
    allows: false,
  },
  {
    decision: "cancel",
    label: "Cancel the turn",
    description: "Refuse and stop what the agent was doing.",
    persistent: false,
    allows: false,
  },
]);

export function isProviderApprovalDecision(value) {
  return typeof value === "string" && DECISION_SET.has(value);
}

export function isPersistentProviderApprovalDecision(value) {
  return typeof value === "string" && PERSISTENT_SET.has(value);
}

/**
 * Canonicalize a decision from any accepted spelling.
 *
 * @returns {string|null} one of PROVIDER_APPROVAL_DECISIONS, or null when unrecognised.
 */
export function normalizeProviderApprovalDecision(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (DECISION_SET.has(trimmed)) return trimmed;
  return LEGACY_PROVIDER_APPROVAL_DECISIONS[trimmed] ?? null;
}

/** The three request kinds T3 classifies an approval into, plus null for anything else. */
export const PROVIDER_REQUEST_KINDS = Object.freeze(["command", "file-read", "file-change"]);

const REQUEST_KIND_LABELS = Object.freeze({
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
});

/**
 * Port of T3's `isStaleRequestFailureDetail` (src/orchestration/decider.ts:42-54).
 *
 * A `provider.approval.respond.failed` clears the open request ONLY when the provider no longer
 * knows about it. Any other failure — a transport error, a dead session — leaves it open, because
 * something is still blocked on an answer.
 */
export function isStaleProviderRequestDetail(detail) {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending approval request")
    || lowered.includes("unknown pending approval request")
    || lowered.includes("unknown pending permission request");
}

/**
 * Every provider approval this thread's work log knows about, newest activity last.
 *
 * Ordering matters and is not the array order: activities carry an optional per-turn `sequence`
 * (orchestration.ts:323) and a `createdAt`, and a resolution must be applied after the request it
 * resolves. Sorted on (sequence, createdAt) exactly like `pendingThreadInteractions()` already
 * does in src/t3Client.mjs.
 *
 * @param {object|null} thread a hydrated thread from GET /api/orchestration/threads/:threadId,
 *   or the `thread` of a live-stream snapshot. A thread with no `activities` yields nothing —
 *   which is the correct answer for the bodiless shell snapshot, not an error.
 * @returns {Array<object>} one record per requestId, in request order.
 */
export function collectProviderApprovals(thread, { threadId = null } = {}) {
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
    if (!requestId) continue;
    const kind = stringOrNull(activity?.kind);

    if (kind === "approval.requested") {
      // A repeated request id restarts the record: the provider is asking again.
      byRequestId.set(requestId, {
        kind: "provider",
        requestId,
        threadId: resolvedThreadId,
        activityId: stringOrNull(activity?.id),
        requestKind: normalizeRequestKind(payload?.requestKind),
        requestType: stringOrNull(payload?.requestType),
        // The provider's own words about what it wants to do. User content and code: never
        // persisted by the gateway, only relayed live.
        detail: stringOrNull(payload?.detail),
        summary: stringOrNull(activity?.summary) ?? "Approval requested",
        turnId: stringOrNull(activity?.turnId),
        requestedAt: stringOrNull(activity?.createdAt),
        status: "pending",
        decision: null,
        resolvedAt: null,
        failure: null,
      });
      continue;
    }

    const existing = byRequestId.get(requestId);
    if (!existing) continue;

    if (kind === "approval.resolved") {
      existing.status = "resolved";
      existing.decision = normalizeProviderApprovalDecision(payload?.decision)
        ?? stringOrNull(payload?.decision);
      existing.resolvedAt = stringOrNull(activity?.createdAt);
      continue;
    }

    if (kind === "provider.approval.respond.failed") {
      const detail = stringOrNull(payload?.detail);
      existing.failure = detail;
      // T3's own rule: only a stale/unknown failure closes the request.
      if (isStaleProviderRequestDetail(detail)) {
        existing.status = "stale";
        existing.resolvedAt = stringOrNull(activity?.createdAt);
      }
    }
  }

  return [...byRequestId.values()];
}

/** Just the ones still blocking the agent. */
export function pendingProviderApprovals(thread, options = {}) {
  return collectProviderApprovals(thread, options).filter((approval) => approval.status === "pending");
}

export function findProviderApproval(thread, requestId, options = {}) {
  const wanted = stringOrNull(requestId);
  if (!wanted) return null;
  return collectProviderApprovals(thread, options)
    .find((approval) => approval.requestId === wanted) ?? null;
}

/**
 * The decisions this actor may actually give, in catalogue order.
 *
 * `acceptForSession` is separated out because it is a durable grant: see the capability note in
 * src/profiles.mjs. An actor without `approval_response` at all gets an empty list — it may still
 * SEE the approval, which is a read, but every button is refused.
 */
export function allowedProviderApprovalDecisions(capabilities) {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities ?? []);
  if (!set.has("approval_response")) return [];
  return PROVIDER_APPROVAL_DECISIONS.filter((decision) =>
    !isPersistentProviderApprovalDecision(decision) || set.has("approval_response_persistent"));
}

/**
 * What a controller with a few square centimetres of screen needs, and nothing else.
 *
 * Deliberately smaller than the console record: no activity id, no request type, no failure text.
 * `detail` is clipped because a provider can describe a file change in a paragraph and a 240x320
 * panel cannot render one.
 */
export function deviceProviderApprovalView(approval, { detailLimit = 160 } = {}) {
  return {
    kind: "provider",
    requestId: approval.requestId,
    threadId: approval.threadId,
    requestKind: approval.requestKind,
    title: REQUEST_KIND_LABELS[approval.requestKind] ?? approval.summary,
    detail: clip(approval.detail, detailLimit),
    requestedAt: approval.requestedAt,
  };
}

function normalizeRequestKind(value) {
  const kind = stringOrNull(value);
  return kind && PROVIDER_REQUEST_KINDS.includes(kind) ? kind : null;
}

function clip(value, limit) {
  const text = stringOrNull(value);
  if (!text) return null;
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
