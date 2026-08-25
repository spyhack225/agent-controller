/**
 * Provider approvals in the console.
 *
 * Two different things in this product are called an approval, and the console must never let a
 * reader confuse them:
 *
 *   GATEWAY APPROVAL   a `Command` with status `approval_required`. The gateway refused to
 *                      dispatch something *you* asked for — "you tried to run `rm -rf`" — and is
 *                      holding it. Answered at POST /v1/commands/:id/approve|reject. Two buttons,
 *                      and declining means the command is never sent.
 *
 *   PROVIDER APPROVAL  a turn is already running inside T3 and the agent has stopped mid-turn to
 *                      ask permission — "Claude wants to edit src/app.mjs". It is not a gateway
 *                      record at all: it is a live callback in T3, it expires with the session,
 *                      and it has FOUR answers, not two. Answered at
 *                      POST /v1/t3/environments/:id/threads/:threadId/approvals/:requestId.
 *
 * They are rendered as separate blocks with different labels for that reason, and everything in
 * this file is stamped `kind: "provider"`.
 *
 * The decision vocabulary is T3's own `ProviderApprovalDecision`
 * (packages/contracts/src/orchestration.ts:134-140 in T3 Code 0.0.32) and is mirrored from
 * `src/providerApprovals.mjs`, which carries the full contract evidence. Offering only
 * approve/reject would be the console lying about the choice T3 gives the owner — in particular
 * about "allow for this session", which writes a standing permission rule rather than answering
 * one question.
 */

export const PROVIDER_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const;

export type ProviderApprovalDecision = typeof PROVIDER_APPROVAL_DECISIONS[number];

export type ProviderApprovalStatus = "pending" | "resolved" | "stale";

export type ProviderRequestKind = "command" | "file-read" | "file-change";

export interface ProviderApprovalDecisionDescriptor {
  decision: ProviderApprovalDecision;
  label: string;
  description: string;
  /** True for the one decision that leaves a standing rule behind rather than answering once. */
  persistent: boolean;
  allows: boolean;
}

export const PROVIDER_APPROVAL_DECISION_CATALOGUE: readonly ProviderApprovalDecisionDescriptor[] = [
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
];

/** What the gateway itself did about this request, which is not what T3 reports. */
export interface ProviderApprovalLocalDecision {
  requestId: string;
  decision: ProviderApprovalDecision | string;
  /** claimed | dispatched | held | failed. `held` waits on a gateway policy confirmation. */
  status: string;
  actorType: string;
  commandId: string | null;
  error: string | null;
  decidedAt: string | null;
}

export interface ProviderApproval {
  kind: "provider";
  requestId: string;
  threadId: string | null;
  requestKind: ProviderRequestKind | null;
  /** The provider's own words about what it wants to do. Code and user content — render as-is. */
  detail: string | null;
  summary: string;
  turnId: string | null;
  requestedAt: string | null;
  status: ProviderApprovalStatus;
  /** The decision T3 recorded, once it resolves. */
  decision: string | null;
  resolvedAt: string | null;
  /** A `provider.approval.respond.failed` detail, when one was reported. */
  failure: string | null;
  localDecision: ProviderApprovalLocalDecision | null;
}

const REQUEST_KIND_LABELS: Record<ProviderRequestKind, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
};

export function providerApprovalTitle(approval: ProviderApproval): string {
  return approval.requestKind
    ? REQUEST_KIND_LABELS[approval.requestKind]
    : approval.summary || "Approval requested";
}

export function isProviderApprovalDecision(value: unknown): value is ProviderApprovalDecision {
  return typeof value === "string"
    && (PROVIDER_APPROVAL_DECISIONS as readonly string[]).includes(value);
}

export function describeProviderApprovalDecision(
  decision: string | null,
): ProviderApprovalDecisionDescriptor | null {
  if (!decision) return null;
  return PROVIDER_APPROVAL_DECISION_CATALOGUE
    .find((entry) => entry.decision === decision) ?? null;
}

/**
 * The decisions to render as buttons.
 *
 * `allowedDecisions` comes from the gateway and already reflects the acting profile's
 * capabilities — notably that `acceptForSession` is a separate capability. An empty list is a
 * real answer, not a loading state: a read-only actor SEES the request and is offered nothing.
 */
export function offeredProviderApprovalDecisions(
  allowedDecisions: readonly string[] | null | undefined,
): ProviderApprovalDecisionDescriptor[] {
  const allowed = new Set(allowedDecisions ?? PROVIDER_APPROVAL_DECISIONS);
  return PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => allowed.has(entry.decision));
}

// ---------------------------------------------------------------------------------------------
// Deriving pending approvals from the live thread stream
// ---------------------------------------------------------------------------------------------
//
// Port of `collectProviderApprovals()` in src/providerApprovals.mjs, which is itself a port of
// T3's own `hasOpenBlockingRequest` (src/orchestration/decider.ts:64-86). The clearing rules have
// to match on all three or the console will show a card for a request nothing is waiting on:
//
//   approval.requested                 opens (or re-opens) the request
//   approval.resolved                  closes it
//   provider.approval.respond.failed   closes it ONLY when the detail says the provider no longer
//                                      knows the request. Any other failure leaves it open,
//                                      because something is still blocked on an answer.

export function isStaleProviderRequestDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending approval request")
    || lowered.includes("unknown pending approval request")
    || lowered.includes("unknown pending permission request");
}

/**
 * Fold one T3 activity into an approval map. Returns a NEW map only when something changed, so a
 * reducer can keep its previous state identity for the overwhelmingly common irrelevant activity.
 */
export function foldApprovalActivity(
  approvals: readonly ProviderApproval[],
  activity: unknown,
  threadId: string | null,
): readonly ProviderApproval[] {
  const record = asRecord(activity);
  const payload = asRecord(record?.payload);
  const requestId = stringOrNull(payload?.requestId);
  if (!record || !requestId) return approvals;
  const kind = stringOrNull(record.kind);

  if (kind === "approval.requested") {
    const next: ProviderApproval = {
      kind: "provider",
      requestId,
      threadId,
      requestKind: normalizeRequestKind(payload?.requestKind),
      detail: stringOrNull(payload?.detail),
      summary: stringOrNull(record.summary) ?? "Approval requested",
      turnId: stringOrNull(record.turnId),
      requestedAt: stringOrNull(record.createdAt),
      status: "pending",
      decision: null,
      resolvedAt: null,
      failure: null,
      localDecision: null,
    };
    const index = approvals.findIndex((entry) => entry.requestId === requestId);
    if (index === -1) return [...approvals, next];
    const copy = [...approvals];
    // A repeated request id means the provider is asking again; the local decision no longer
    // applies to the question on screen.
    copy[index] = next;
    return copy;
  }

  const index = approvals.findIndex((entry) => entry.requestId === requestId);
  if (index === -1) return approvals;

  if (kind === "approval.resolved") {
    const copy = [...approvals];
    copy[index] = {
      ...copy[index],
      status: "resolved",
      decision: stringOrNull(payload?.decision),
      resolvedAt: stringOrNull(record.createdAt),
    };
    return copy;
  }

  if (kind === "provider.approval.respond.failed") {
    const detail = stringOrNull(payload?.detail);
    const copy = [...approvals];
    copy[index] = {
      ...copy[index],
      failure: detail,
      ...(isStaleProviderRequestDetail(detail)
        ? { status: "stale" as const, resolvedAt: stringOrNull(record.createdAt) }
        : {}),
    };
    return copy;
  }

  return approvals;
}

/** All approvals in a hydrated thread's work log, in request order. */
export function collectProviderApprovals(
  thread: unknown,
  threadId: string | null,
): ProviderApproval[] {
  const record = asRecord(thread);
  const activities = Array.isArray(record?.activities) ? [...record.activities] : [];
  activities.sort((left, right) => {
    const bySequence = (Number(asRecord(left)?.sequence) || 0) - (Number(asRecord(right)?.sequence) || 0);
    if (bySequence !== 0) return bySequence;
    return String(asRecord(left)?.createdAt ?? "").localeCompare(String(asRecord(right)?.createdAt ?? ""));
  });
  let approvals: readonly ProviderApproval[] = [];
  for (const activity of activities) {
    approvals = foldApprovalActivity(approvals, activity, threadId);
  }
  return [...approvals];
}

export function pendingProviderApprovals(
  approvals: readonly ProviderApproval[],
): ProviderApproval[] {
  return approvals.filter((approval) => approval.status === "pending");
}

/** Merges the gateway's decision rows onto approvals derived from the stream. */
export function mergeProviderApprovalDecisions(
  approvals: readonly ProviderApproval[],
  decisions: readonly ProviderApprovalLocalDecision[],
): ProviderApproval[] {
  if (decisions.length === 0) return [...approvals];
  const byRequestId = new Map(decisions.map((entry) => [entry.requestId, entry]));
  return approvals.map((approval) => {
    const localDecision = byRequestId.get(approval.requestId);
    return localDecision ? { ...approval, localDecision } : approval;
  });
}

function normalizeRequestKind(value: unknown): ProviderRequestKind | null {
  const kind = stringOrNull(value);
  return kind === "command" || kind === "file-read" || kind === "file-change" ? kind : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
