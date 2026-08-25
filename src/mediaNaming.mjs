/**
 * The name a stored capture answers to.
 *
 * Every clip a controller records arrives as `controller.wav`, because that is the only name a few
 * kilobytes of firmware can invent for it. Two recordings made ten minutes apart therefore listed
 * as two identical rows, separable only by byte count and an opaque id. The fix is not a better
 * name from the device: the gateway already knows which controller sent the bytes, which thread the
 * capture was headed for, and when it landed — and it knows those things for captures that are
 * already stored.
 *
 * So the name is DERIVED ON READ, never stored. A stored name is a copy that goes stale the moment
 * a device is relabelled or a thread retitled, and it would need a migration to reach the clips a
 * user already has. Deriving costs one map lookup per row and is always current — the same reason
 * `withTranscriptChange()` computes the transcript diff on read rather than persisting it.
 *
 * `originalName` is untouched. It is what the client actually uploaded, it is what the agent sees
 * as the attachment filename, and it still identifies a file the owner dragged in from a folder.
 * The derived name lives beside it as `displayName`.
 *
 * The shape is three segments, longest-lived first, joined by a middle dot and dropped when
 * unknown:
 *
 *     Hosyond Touch screen | Verify workspace boo... | 24 Aug 19:32
 *     ^ origin               ^ destination             ^ when
 *
 * The time is absolute and short because it is the only segment that separates two captures from
 * the same microphone pointed at the same thread — which is exactly the case that was reported. It
 * is rendered in the gateway's own timezone: this is a control plane that normally runs on the same
 * machine as the agent it drives, and a name has to be one string in the library, in the composer's
 * picker and on an attachment chip rather than three renderings of one instant.
 */

const SEPARATOR = " · ";
const ELLIPSIS = "…";
const MAX_THREAD_TITLE = 28;
const MAX_UPLOAD_NAME = 32;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Names a client generates for its own captures, which carry no information a row does not already
 * show. `recording-2026-08-24T19:32:11.104Z.webm` is a timestamp spelled badly and `controller.wav`
 * is the firmware saying nothing at all; the derived name says both properly, so repeating them as
 * a descriptor would be noise twice.
 */
const GENERATED_UPLOAD_NAME = /^(?:recording|snapshot|clip|controller|audio|image)[-_]?[\dt:.\-]*z?$/iu;

// ---------------------------------------------------------------------------
// Thread titles
// ---------------------------------------------------------------------------
//
// Thread titles live in T3, and the orchestration snapshot is the only place they are published.
// Fetching one per media listing would put an eight-second timeout in front of a page that is
// otherwise a pure store read, so titles are remembered from the snapshots the gateway already
// fetches — the poller's tick, every device thread route, every console snapshot read — and looked
// up from there. A listing may still refresh a stale environment itself, on a short timeout, so the
// first page load after a restart is not the one that shows a bare thread id.
//
// Module-level on purpose, mirroring `displayCache` in displayState.mjs: the cache is keyed by
// environment id, environment ids are per-user UUIDs, and a title is only ever read after the
// caller has resolved that id through the requesting user's own scope.

export const THREAD_TITLE_TTL_MS = 60_000;

const threadTitles = new Map();
const environmentSeenAt = new Map();

/** Records every thread title an orchestration snapshot carries for one environment. */
export function rememberSnapshotThreadTitles(environmentId, snapshot, now = Date.now()) {
  if (typeof environmentId !== "string" || environmentId.length === 0) return;
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  for (const thread of threads) {
    const id = typeof thread?.id === "string" ? thread.id : null;
    const title = typeof thread?.title === "string" ? thread.title.trim() : "";
    if (!id || title.length === 0) continue;
    threadTitles.set(`${environmentId} ${id}`, title);
  }
  environmentSeenAt.set(environmentId, now);
}

/**
 * Records that this environment could not be read.
 *
 * Cached exactly like a success so an unreachable or unpaired T3 is asked about once per window
 * rather than once per media listing. Titles learned earlier stay usable: a host that went down has
 * not renamed its threads.
 */
export function markThreadTitlesUnavailable(environmentId, now = Date.now()) {
  if (typeof environmentId !== "string" || environmentId.length === 0) return;
  environmentSeenAt.set(environmentId, now);
}

/** Whether this environment is worth a snapshot read before naming. */
export function threadTitlesAreStale(environmentId, { ttlMs = THREAD_TITLE_TTL_MS, now = Date.now() } = {}) {
  if (typeof environmentId !== "string" || environmentId.length === 0) return false;
  const seenAt = environmentSeenAt.get(environmentId);
  return seenAt === undefined || now - seenAt >= ttlMs;
}

export function lookupThreadTitle(environmentId, threadId) {
  if (typeof environmentId !== "string" || typeof threadId !== "string") return null;
  return threadTitles.get(`${environmentId} ${threadId}`) ?? null;
}

/** Tests only: the cache outlives a single `createApp()`, so a test that seeds it must clear it. */
export function resetThreadTitleCache() {
  threadTitles.clear();
  environmentSeenAt.clear();
}

// ---------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------

/**
 * Builds the display name and the structured origin for one media record.
 *
 * Returns only derived fields, so a caller spreads them over the record it already holds. Nothing
 * here throws: a name is decoration, and a listing must not fail because a device was deleted.
 */
export function buildMediaName({
  media,
  device = null,
  environmentId = null,
  threadId = null,
  threadTitle = null,
  now = new Date(),
} = {}) {
  const source = media?.deviceId ? "device" : "console";
  const deviceLabel = trimmed(device?.label);
  const title = trimmed(threadTitle);
  const boundThreadId = trimmed(threadId);
  const segments = [
    originSegment(media, deviceLabel),
    destinationSegment({ media, source, threadId: boundThreadId, threadTitle: title }),
    formatCapturedAt(media?.createdAt, now),
  ].filter((segment) => typeof segment === "string" && segment.length > 0);

  return {
    displayName: segments.join(SEPARATOR),
    origin: {
      source,
      deviceId: media?.deviceId ?? null,
      deviceLabel: media?.deviceId ? deviceLabel : null,
      environmentId: boundThreadId ? trimmed(environmentId) : null,
      threadId: boundThreadId,
      threadTitle: boundThreadId ? title : null,
      capturedAt: media?.createdAt ?? null,
    },
  };
}

/** Who produced the bytes. A device that was never labelled still beats a bare uuid. */
function originSegment(media, deviceLabel) {
  if (!media?.deviceId) return "Console";
  return deviceLabel ?? `Controller ${shortId(media.deviceId)}`;
}

/**
 * Where the capture was going.
 *
 * A device capture is pinned to a thread, so that thread names it. A console upload has no thread
 * at all — the owner is looking at the screen they uploaded it from — so the file they chose names
 * it instead, which is the one case where `originalName` is genuinely the best answer.
 */
function destinationSegment({ media, source, threadId, threadTitle }) {
  if (threadId) {
    return threadTitle ? truncate(threadTitle, MAX_THREAD_TITLE) : `Thread ${shortId(threadId)}`;
  }
  if (source === "console") {
    const uploaded = meaningfulUploadName(media?.originalName);
    if (uploaded) return truncate(uploaded, MAX_UPLOAD_NAME);
  }
  return null;
}

/** The uploaded filename, when it says anything a row does not already say. */
function meaningfulUploadName(originalName) {
  const name = trimmed(originalName);
  if (!name) return null;
  const stem = name.replace(/\.[a-z0-9]{1,8}$/iu, "");
  if (stem.length === 0 || GENERATED_UPLOAD_NAME.test(stem)) return null;
  return name;
}

/** `24 Aug 19:32`, or `3 Feb 2025 08:05` once the year stops being obvious. */
const formatCapturedAt = formatShortLocalTime;

/**
 * `24 Aug 19:32`, or `3 Feb 2025 08:05` once the year stops being obvious.
 *
 * Exported because a name minted for a *thread* has to read as the same kind of string as a name
 * derived for a capture — one gateway, one way of writing an instant. See `src/threadNaming.mjs`.
 */
export function formatShortLocalTime(createdAt, now = new Date()) {
  const at = new Date(createdAt ?? "");
  if (!Number.isFinite(at.getTime())) return null;
  const reference = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const year = at.getFullYear() === reference.getFullYear() ? "" : ` ${at.getFullYear()}`;
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${at.getDate()} ${MONTHS[at.getMonth()]}${year} ${hours}:${minutes}`;
}

/** Enough of an id to tell two of them apart, without spending a row on a uuid. */
export function shortEntityId(id) {
  return shortId(id);
}

/** Enough of an id to tell two of them apart, without spending a row on a uuid. */
function shortId(id) {
  const text = String(id ?? "");
  const body = text.includes("_") ? text.slice(text.indexOf("_") + 1) : text;
  return (body.replace(/-/gu, "").slice(0, 6) || text).toLowerCase();
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}${ELLIPSIS}`;
}

function trimmed(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}
