import type { DeviceControlItem, DeviceControls, DeviceFirmwarePolicy, T3Thread } from "./types";

/**
 * Dashboard representation of the navigation contract implemented by the CrowPanel firmware.
 * Reusable controls are deliberately scoped to an opened thread and never mixed into the root.
 */
export const CONTROLLER_ACTION_ROWS_PER_PAGE = 3;
export const CONTROLLER_ROOT_ITEM_COUNT = 3;
export const CONTROLLER_RESPONSE_LINE_LENGTH = 31;

export type ControllerActionIcon = "agent" | "thread" | "gateway" | "action" | "status" | "stop" | "firmware";

export interface ControllerActionDisplayRow {
  id: string;
  label: string;
  meta: string;
  icon: ControllerActionIcon;
  disabled: boolean;
  selected: boolean;
  source: "system" | "assigned" | "thread";
}

export interface ControllerActionsDisplay {
  title: string;
  state: "READY" | "SELECT" | "EMPTY";
  rows: ControllerActionDisplayRow[];
  allRows: ControllerActionDisplayRow[];
  selectedIndex: number;
  page: number;
  pageCount: number;
  assignedCount: number;
  totalCount: number;
}

interface ControllerActionsDisplayInput {
  controls: DeviceControls;
  selectedIndex?: number;
  threadId?: string | null;
}

interface ControllerRootDisplayInput {
  selectedIndex?: number;
  threadCount?: number | null;
  firmware?: DeviceFirmwarePolicy | null;
}

export interface ControllerThreadDisplayItem {
  id: string;
  label: string;
  status?: string | null;
  active?: boolean;
}

export interface ControllerResponseDisplay {
  title: string;
  state: "COMPLETE" | "STREAMING" | "EMPTY";
  lines: string[];
  allLines: string[];
  page: number;
  pageCount: number;
  suggestions: ControllerActionDisplayRow[];
}

function clampSelection(index: number, count: number) {
  if (!count) return 0;
  return Math.max(0, Math.min(Math.trunc(index), count - 1));
}

function firmwareRow(firmware?: DeviceFirmwarePolicy | null): Omit<ControllerActionDisplayRow, "selected"> {
  const currentVersion = firmware?.currentVersion ?? null;
  const candidateVersion = firmware?.targetVersion ?? firmware?.latestVersion ?? null;
  const updateReady = firmware?.status === "available"
    || Boolean(candidateVersion && currentVersion && candidateVersion !== currentVersion);
  return {
    id: "system_firmware",
    label: updateReady && candidateVersion ? `Update ${candidateVersion}` : "Firmware",
    meta: updateReady ? "READY" : "CHECK",
    icon: "firmware",
    disabled: false,
    source: "system",
  };
}

function assignedRow(item: DeviceControlItem, index: number, threadId?: string | null): Omit<ControllerActionDisplayRow, "selected"> {
  const missingThread = Boolean(item.requiresThread && !threadId);
  const available = item.enabled !== false && !missingThread;
  let meta = missingThread ? "THREAD" : item.enabled === false ? "LOCK" : item.requiresConfirmation ? "CONFIRM" : "RUN";
  let icon: ControllerActionIcon = "action";
  if (item.kind === "status" || item.id === "system_status") {
    icon = "status";
    if (available) meta = "VIEW";
  } else if (item.kind === "stop" || item.id === "system_stop") {
    icon = "stop";
    if (available) meta = "CONFIRM";
  }
  return {
    id: item.id ?? item.actionId ?? `assigned_${index}`,
    label: item.label ?? "Unavailable action",
    meta,
    icon,
    disabled: !available,
    source: "assigned",
  };
}

export function buildControllerActionsDisplay({
  controls,
  selectedIndex = 0,
  threadId,
}: ControllerActionsDisplayInput): ControllerActionsDisplay {
  const baseRows: Array<Omit<ControllerActionDisplayRow, "selected">> = [
    {
      id: "system_latest_response",
      label: "Latest response",
      meta: "VIEW",
      icon: "agent",
      disabled: !threadId,
      source: "thread",
    },
    ...controls.items.map((item, index) => assignedRow(item, index, threadId)),
  ];
  return finishDisplay("T//ACTIONS", baseRows, selectedIndex, controls.items.length, "READY");
}

export function buildControllerResponseDisplay(
  thread: T3Thread | null | undefined,
  controls: DeviceControls,
  page = 0,
): ControllerResponseDisplay {
  const assistant = [...(thread?.messages ?? [])]
    .filter((message) => message.role === "assistant")
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .at(-1);
  const marker = assistant?.text.match(/<!--\s*AC_FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->/iu);
  let suggestedIds: string[] = [];
  try {
    const parsed = marker ? JSON.parse(marker[1]) : [];
    if (Array.isArray(parsed)) suggestedIds = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    suggestedIds = [];
  }
  const text = (assistant?.text ?? "No agent response yet. Run a thread action first.")
    .replace(/<!--\s*AC_FOLLOWUPS\s*:\s*\[[\s\S]*?\]\s*-->/giu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+] |> )\s?/gmu, "")
    .trim();
  const allLines = wrapControllerResponse(text);
  const pageCount = Math.max(1, Math.ceil(allLines.length / CONTROLLER_ACTION_ROWS_PER_PAGE));
  const safePage = Math.max(0, Math.min(Math.trunc(page), pageCount - 1));
  const allowed = new Map(controls.items
    .filter((item) => item.enabled !== false && item.actionId && !["status", "stop", "reset"].includes(item.kind ?? ""))
    .map((item, index) => [item.actionId!, assignedRow(item, index, thread?.id)]));
  const seen = new Set<string>();
  const suggestions = suggestedIds.flatMap((id) => {
    if (seen.has(id) || !allowed.has(id)) return [];
    seen.add(id);
    return [{ ...allowed.get(id)!, selected: seen.size === 1 }];
  }).slice(0, 2);
  return {
    title: `AGENT//RESPONSE ${safePage + 1}/${pageCount}`,
    state: assistant?.streaming ? "STREAMING" : assistant ? "COMPLETE" : "EMPTY",
    lines: allLines.slice(safePage * 3, safePage * 3 + 3),
    allLines,
    page: safePage + 1,
    pageCount,
    suggestions,
  };
}

export function wrapControllerResponse(value: string) {
  const lines: string[] = [];
  for (const paragraph of value.replace(/[\t\r]+/gu, " ").split(/\n+/u)) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/u).filter(Boolean)) {
      const chunks = word.length > CONTROLLER_RESPONSE_LINE_LENGTH
        ? Array.from({ length: Math.ceil(word.length / CONTROLLER_RESPONSE_LINE_LENGTH) }, (_, index) => word.slice(index * CONTROLLER_RESPONSE_LINE_LENGTH, (index + 1) * CONTROLLER_RESPONSE_LINE_LENGTH))
        : [word];
      for (const chunk of chunks) {
        if (!line) line = chunk;
        else if (line.length + chunk.length + 1 <= CONTROLLER_RESPONSE_LINE_LENGTH) line += ` ${chunk}`;
        else { lines.push(line); line = chunk; }
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines.slice(0, 36) : ["No displayable response"];
}

export function buildControllerRootDisplay({
  selectedIndex = 0,
  threadCount,
  firmware,
}: ControllerRootDisplayInput): ControllerActionsDisplay {
  const baseRows: Array<Omit<ControllerActionDisplayRow, "selected">> = [
    {
      id: "system_threads",
      label: "Threads",
      meta: threadCount && threadCount > 0 ? String(threadCount) : "LIST",
      icon: "thread",
      disabled: false,
      source: "system",
    },
    {
      id: "system_gateway",
      label: "Gateway",
      meta: "NET",
      icon: "gateway",
      disabled: false,
      source: "system",
    },
    firmwareRow(firmware),
  ];
  return finishDisplay("AC//MENU", baseRows, selectedIndex, 0, "READY");
}

export function buildControllerThreadsDisplay(
  threads: ControllerThreadDisplayItem[],
  selectedIndex = 0,
): ControllerActionsDisplay {
  const baseRows: Array<Omit<ControllerActionDisplayRow, "selected">> = threads.map((thread) => ({
    id: thread.id,
    label: thread.label,
    meta: thread.active ? "ACTIVE" : thread.status?.toUpperCase() || "IDLE",
    icon: "thread",
    disabled: false,
    source: "thread",
  }));
  return finishDisplay("AC//THREADS", baseRows, selectedIndex, 0, threads.length ? "SELECT" : "EMPTY");
}

function finishDisplay(
  title: string,
  baseRows: Array<Omit<ControllerActionDisplayRow, "selected">>,
  selectedIndex: number,
  assignedCount: number,
  state: ControllerActionsDisplay["state"],
): ControllerActionsDisplay {
  const safeSelectedIndex = clampSelection(selectedIndex, baseRows.length);
  const allRows = baseRows.map((row, index) => ({ ...row, selected: index === safeSelectedIndex }));
  const pageStart = Math.floor(safeSelectedIndex / CONTROLLER_ACTION_ROWS_PER_PAGE) * CONTROLLER_ACTION_ROWS_PER_PAGE;
  const totalCount = allRows.length;
  return {
    title: totalCount ? `${title} ${safeSelectedIndex + 1}/${totalCount}` : title,
    state: totalCount ? state : "EMPTY",
    rows: allRows.slice(pageStart, pageStart + CONTROLLER_ACTION_ROWS_PER_PAGE),
    allRows,
    selectedIndex: safeSelectedIndex,
    page: Math.floor(pageStart / CONTROLLER_ACTION_ROWS_PER_PAGE) + 1,
    pageCount: Math.ceil(totalCount / CONTROLLER_ACTION_ROWS_PER_PAGE),
    assignedCount,
    totalCount,
  };
}
