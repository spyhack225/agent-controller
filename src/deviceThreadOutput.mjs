import { buildT3WorkSummary } from "./t3Work.mjs";

const FOLLOW_UP_MARKER = /<!--\s*AC_FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->/giu;

export const DEVICE_RESPONSE_LINE_LENGTH = 31;
export const DEVICE_RESPONSE_LINES_PER_PAGE = 3;
export const DEVICE_RESPONSE_MAX_PAGES = 12;
export const DEVICE_FOLLOW_UP_LIMIT = 2;

/**
 * Adds a hidden, bounded instruction to turns started by a physical controller.
 * The model may only name opaque ids; the gateway validates those ids against
 * the device's current layout before returning anything executable.
 */
export function buildDeviceFollowUpInstruction(controls, currentActionId = null) {
  const actions = eligibleFollowUpActions(controls, currentActionId);
  if (!actions.length) return null;
  const catalogue = actions.map(({ actionId, label }) => ({ id: actionId, label }));
  return [
    "<!--AC_DEVICE_FOLLOWUP_REQUEST",
    "At the end of your response, optionally recommend up to two relevant next actions from this exact JSON catalogue:",
    JSON.stringify(catalogue),
    'Append one machine-readable marker exactly like <!--AC_FOLLOWUPS:["action_id"]-->.',
    "Use only ids from the catalogue, never invent an id, and omit the marker when no listed action is useful.",
    "-->\n",
  ].join("\n");
}

export function appendDeviceFollowUpInstruction(text, instruction) {
  const prompt = String(text ?? "").trim();
  const hidden = typeof instruction === "string" ? instruction.trim() : "";
  return hidden ? `${prompt}\n\n${hidden}` : prompt;
}

export function buildDeviceThreadOutput({
  thread,
  controls = [],
  page = 0,
  after = null,
} = {}) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message?.role === "assistant")
    .filter(({ message }) => isAtOrAfter(message?.createdAt, after))
    .sort(compareMessages);
  const selected = candidates.at(-1)?.message ?? null;
  const projectedWork = buildT3WorkSummary(thread?.activities);
  const explicitLiveness = ["working", "monitoring"].includes(thread?.backgroundLiveness)
    ? thread.backgroundLiveness
    : null;
  const work = {
    ...projectedWork,
    backgroundLiveness: explicitLiveness ?? projectedWork.backgroundLiveness,
  };
  const active = deviceThreadIsActive(thread) || work.active > 0 || Boolean(work.backgroundLiveness);

  if (!selected) {
    return {
      thread: compactThread(thread),
      work,
      response: {
        messageId: null,
        state: active || after ? "waiting" : "empty",
        page: 0,
        pageCount: 1,
        lines: active || after
          ? work.total > 0
            ? [
                `${work.active} active ${work.active === 1 ? "task" : "tasks"}`,
                `${work.completed} done · ${work.failed} failed`,
                "EXIT returns to actions",
              ]
            : ["Waiting for agent response", "The display will refresh", "EXIT returns to actions"]
          : ["No agent response yet", "Run a thread action first", "EXIT returns to actions"],
        truncated: false,
        updatedAt: null,
      },
      suggestions: [],
    };
  }

  const rawText = String(selected.text ?? "");
  const markerIds = extractFollowUpIds(rawText);
  const visibleText = normalizeResponseText(stripFollowUpMarkers(rawText));
  const allLines = wrapResponseText(visibleText || (selected.streaming ? "Agent is responding" : "Response contained no displayable text"));
  const maximumLines = DEVICE_RESPONSE_LINES_PER_PAGE * DEVICE_RESPONSE_MAX_PAGES;
  const truncated = allLines.length > maximumLines;
  const boundedLines = allLines.slice(0, maximumLines);
  const pageCount = Math.max(1, Math.ceil(boundedLines.length / DEVICE_RESPONSE_LINES_PER_PAGE));
  const safePage = clampInteger(page, 0, pageCount - 1);
  const start = safePage * DEVICE_RESPONSE_LINES_PER_PAGE;
  const lines = boundedLines.slice(start, start + DEVICE_RESPONSE_LINES_PER_PAGE);

  return {
    thread: compactThread(thread),
    work,
    response: {
      messageId: stringOrNull(selected.id ?? selected.messageId),
      state: selected.streaming ? "streaming" : "complete",
      page: safePage,
      pageCount,
      lines,
      truncated,
      updatedAt: stringOrNull(selected.createdAt),
    },
    suggestions: validateFollowUpIds(markerIds, controls),
  };
}

export function extractFollowUpIds(text) {
  const matches = [...String(text ?? "").matchAll(FOLLOW_UP_MARKER)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index][1]);
      if (!Array.isArray(parsed)) continue;
      return parsed.filter((value) => typeof value === "string");
    } catch {
      // Ignore malformed model output. It never becomes an executable action.
    }
  }
  return [];
}

export function stripFollowUpMarkers(text) {
  return String(text ?? "").replace(FOLLOW_UP_MARKER, "").trim();
}

export function wrapResponseText(text, lineLength = DEVICE_RESPONSE_LINE_LENGTH) {
  const width = clampInteger(lineLength, 8, DEVICE_RESPONSE_LINE_LENGTH);
  const normalized = normalizeResponseText(text);
  if (!normalized) return [];
  const output = [];
  for (const paragraph of normalized.split("\n")) {
    if (!paragraph) continue;
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const chunks = splitToken(word, width);
      for (const chunk of chunks) {
        if (!line) {
          line = chunk;
        } else if (line.length + 1 + chunk.length <= width) {
          line += ` ${chunk}`;
        } else {
          output.push(line);
          line = chunk;
        }
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function eligibleFollowUpActions(controls, currentActionId) {
  const seen = new Set();
  return (Array.isArray(controls) ? controls : [])
    .filter((control) => control?.enabled !== false && typeof control?.actionId === "string")
    .filter((control) => control.actionId && control.actionId !== currentActionId)
    .filter((control) => !["status", "stop", "reset"].includes(control.kind))
    .filter((control) => {
      if (seen.has(control.actionId)) return false;
      seen.add(control.actionId);
      return true;
    })
    .slice(0, 8)
    .map((control) => ({
      actionId: control.actionId,
      label: String(control.label ?? "Action").slice(0, 80),
      kind: control.kind ?? "remote_action",
      requiresConfirmation: control.requiresConfirmation !== false,
    }));
}

function validateFollowUpIds(ids, controls) {
  const allowed = new Map(eligibleFollowUpActions(controls, null).map((action) => [action.actionId, action]));
  const output = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    output.push(allowed.get(id));
    if (output.length === DEVICE_FOLLOW_UP_LIMIT) break;
  }
  return output;
}

function normalizeResponseText(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+] |> )\s?/gmu, "")
    .replace(/[\t\r]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

function splitToken(token, width) {
  if (token.length <= width) return [token];
  const chunks = [];
  for (let offset = 0; offset < token.length; offset += width) chunks.push(token.slice(offset, offset + width));
  return chunks;
}

function compareMessages(left, right) {
  const leftAt = Date.parse(left.message?.createdAt ?? "");
  const rightAt = Date.parse(right.message?.createdAt ?? "");
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
  if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 1;
  if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return -1;
  return left.index - right.index;
}

function isAtOrAfter(createdAt, after) {
  if (!after) return true;
  const boundary = Date.parse(after);
  if (!Number.isFinite(boundary)) return true;
  const created = Date.parse(createdAt ?? "");
  return Number.isFinite(created) && created >= boundary;
}

function deviceThreadIsActive(thread) {
  return [thread?.session?.status, thread?.latestTurn?.state, thread?.status]
    .some((state) => ["starting", "running", "streaming", "working"].includes(String(state ?? "").toLowerCase()));
}

function compactThread(thread) {
  return {
    id: stringOrNull(thread?.id),
    title: String(thread?.title ?? thread?.name ?? thread?.label ?? "Untitled thread"),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function clampInteger(value, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? minimum), 10);
  return Math.max(minimum, Math.min(Number.isFinite(parsed) ? parsed : minimum, maximum));
}
