/**
 * The name a thread created from a controller answers to.
 *
 * A device has five keys, or a 240x320 touch panel, and no keyboard. It cannot type a thread
 * title, so the gateway has to mint one — and the one thing it must not mint is a name that
 * repeats. `src/mediaNaming.mjs` was written because every controller capture arrived as
 * `controller.wav` and a library of identical rows is a library you cannot use; a picker full of
 * "New thread" is the same failure on a smaller screen, and it is worse there, because the picker
 * is the only way the hardware can reach the thread again.
 *
 * So the name is two things, in the order a truncating list needs them:
 *
 *     24 Aug 19:32 · Hosyond Touch screen
 *     ^ when          ^ which controller
 *
 * Time first, unlike a media name. A media row is one of many kinds from many sources, so the
 * source leads; every thread a given controller creates carries that same controller's label, so
 * putting it first would spend the visible prefix of every row on the one segment that is
 * identical across all of them. The instant is the discriminator, so the instant leads.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE MINTED NAME IS PERMANENT
 * ---------------------------------------------------------------------------------------------
 *
 * T3 retitles a thread from its first user message, but only through a narrow door:
 * `canReplaceThreadTitle` (`src/orchestration/Layers/ProviderCommandReactor.ts:230`, read from the
 * shipped source map) replaces the title only when it is exactly T3's own default `"New thread"`,
 * or exactly equal to the `titleSeed` carried by the `thread.turn.start` that follows. The
 * gateway's device dispatch sends no `titleSeed`, so a thread created here keeps the name minted
 * below for its whole life.
 *
 * That is a deliberate trade and not an oversight. Titling every new thread `"New thread"` so T3
 * could improve it later would hand the device a picker of identical rows in the window that
 * matters most — between creating a thread and prompting into it — which is precisely the dead end
 * this feature exists to remove. A device that can supply its own title (a voice transcript, say)
 * overrides the minted one and gets a better name immediately.
 *
 * ---------------------------------------------------------------------------------------------
 * UNIQUENESS
 * ---------------------------------------------------------------------------------------------
 *
 * Minute resolution is readable but collides on a double tap, so a name that is already taken gets
 * a ` (2)`, ` (3)` … suffix. "Already taken" is the union of two sources:
 *
 *   1. the thread titles in the environment's current T3 snapshot, which the caller has already
 *      fetched, and
 *   2. the titles this gateway minted for that environment in the last few minutes.
 *
 * The second exists because T3's dispatch returns as soon as the event is appended, while the
 * projection the snapshot reads from catches up afterwards — so two creates seconds apart can both
 * see a snapshot that mentions neither. Without the local memory the suffix rule would silently do
 * nothing in exactly the case it was written for.
 */

import { formatShortLocalTime, shortEntityId } from "./mediaNaming.mjs";

const SEPARATOR = " · ";
const ELLIPSIS = "…";
/** T3 trims and rejects empty titles; the cap matches `deriveThreadTitle()` in `t3Client.mjs`. */
export const MAX_THREAD_TITLE = 72;
const MAX_DEVICE_LABEL = 32;
/** Long enough to outlive T3's projection lag, short enough that the map cannot grow unbounded. */
export const MINTED_TITLE_TTL_MS = 10 * 60 * 1000;
/** Past this the suffix has stopped being a disambiguator; fall back to the thread's own id. */
const MAX_SUFFIX = 99;

/** Whitespace and control characters, collapsed to a single space by `normalizeTitle()`. */
const BLANKS = /[\s\u0000-\u001f\u007f]+/gu;

// Keyed by environment id, exactly like the thread-title cache in mediaNaming.mjs, and read only
// after the caller has resolved that environment through the requesting user's own scope.
const minted = new Map();

/**
 * Mints a unique title for a thread about to be created in `environmentId`, and remembers it.
 *
 * @param {object}   options
 * @param {string}   options.environmentId
 * @param {object}   [options.device]         the creating device record (`label`, `id`).
 * @param {object}   [options.snapshot]       the environment's orchestration snapshot.
 * @param {string}   [options.requestedTitle] a title the firmware supplied; wins over the minted one.
 * @param {string}   [options.threadId]       used only as the last-resort disambiguator.
 * @param {Date}     [options.now]
 * @returns {string}
 */
export function mintDeviceThreadTitle({
  environmentId,
  device = null,
  snapshot = null,
  requestedTitle = null,
  threadId = null,
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const taken = takenTitles(environmentId, snapshot, nowMs);
  const base = normalizeTitle(requestedTitle) ?? defaultTitle(device, now);
  const title = disambiguate(base, taken, threadId);
  noteMintedThreadTitle(environmentId, title, nowMs);
  return title;
}

/** `24 Aug 19:32 · Hosyond Touch screen`, with either half dropped when there is nothing to say. */
function defaultTitle(device, now) {
  const segments = [formatShortLocalTime(now, now), controllerLabel(device)]
    .filter((segment) => typeof segment === "string" && segment.length > 0);
  // A clock that cannot be read is not a reason to fail a create; the suffix rule still separates.
  return segments.length > 0 ? segments.join(SEPARATOR) : "Controller thread";
}

/** A device that was never labelled still beats a bare uuid. */
function controllerLabel(device) {
  const label = trimmed(device?.label);
  if (label) return truncate(label, MAX_DEVICE_LABEL);
  const id = trimmed(device?.id);
  return id ? `Controller ${shortEntityId(id)}` : null;
}

/**
 * A firmware-supplied title, cleaned up the way T3 would see it.
 *
 * Whitespace is collapsed because a title is one line on both screens that render it, and control
 * characters go with it because a controller sending a stray carriage return must not produce a
 * title no picker can draw. `null` when nothing usable is left.
 */
export function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(BLANKS, " ").trim();
  if (compact.length === 0) return null;
  return truncate(compact, MAX_THREAD_TITLE);
}

/** `base`, or the first ` (n)` variant of it that nothing else already answers to. */
function disambiguate(base, taken, threadId) {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_SUFFIX; suffix += 1) {
    const candidate = withSuffix(base, ` (${suffix})`);
    if (!taken.has(candidate)) return candidate;
  }
  const id = trimmed(threadId);
  return withSuffix(base, ` (${id ? shortEntityId(id) : Date.now().toString(36)})`);
}

/** Keeps the whole title inside T3's length cap, trimming the base rather than the suffix. */
function withSuffix(base, suffix) {
  const room = MAX_THREAD_TITLE - suffix.length;
  return `${base.length <= room ? base : truncate(base, room)}${suffix}`;
}

function takenTitles(environmentId, snapshot, nowMs) {
  const titles = new Set();
  for (const thread of Array.isArray(snapshot?.threads) ? snapshot.threads : []) {
    const title = trimmed(thread?.title);
    if (title) titles.add(title);
  }
  for (const title of mintedTitles(environmentId, nowMs)) titles.add(title);
  return titles;
}

/** Exported for the same reason `resetThreadTitleCache()` is: the map outlives one `createApp()`. */
export function resetMintedThreadTitles() {
  minted.clear();
}

function mintedTitles(environmentId, nowMs) {
  const entries = minted.get(environmentId);
  if (!entries) return [];
  for (const [title, expiresAt] of entries) {
    if (expiresAt <= nowMs) entries.delete(title);
  }
  if (entries.size === 0) {
    minted.delete(environmentId);
    return [];
  }
  return [...entries.keys()];
}

function noteMintedThreadTitle(environmentId, title, nowMs) {
  if (typeof environmentId !== "string" || environmentId.length === 0) return;
  const entries = minted.get(environmentId) ?? new Map();
  entries.set(title, nowMs + MINTED_TITLE_TTL_MS);
  minted.set(environmentId, entries);
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}${ELLIPSIS}`;
}

function trimmed(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}
