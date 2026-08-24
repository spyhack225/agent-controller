import { createId, nowIso } from "./ids.mjs";
import { appendDeviceFollowUpInstruction } from "./deviceThreadOutput.mjs";

export async function exchangePairingToken({ baseUrl, pairingToken, scopes }) {
  const url = new URL("/oauth/token", baseUrl);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: pairingToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: scopes.join(" "),
    client_label: "Agent Controller Platform",
    client_device_type: "bot",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`T3 token exchange failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function fetchT3EnvironmentInfo(environment, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/.well-known/t3/environment", environment.baseUrl), {
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`T3 environment metadata timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`T3 environment metadata failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function fetchT3Snapshot(environment, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number.isFinite(environment?.timeoutMs) ? environment.timeoutMs : 8000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/api/orchestration/snapshot", environment.baseUrl), {
      headers: authorizationHeaders(environment.accessToken),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`T3 snapshot timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`T3 snapshot failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function dispatchT3Command(environment, command) {
  const response = await fetch(new URL("/api/orchestration/dispatch", environment.baseUrl), {
    method: "POST",
    headers: {
      ...authorizationHeaders(environment.accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const error = new Error(`T3 dispatch failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.responseBody = responseBody;
    throw error;
  }
  return response.json();
}

export function buildT3Command({ intent, threadId, attachments = [] }) {
  const commandId = createId("t3cmd");
  const createdAt = nowIso();

  switch (intent.type) {
    case "agent_prompt":
    case "media_prompt":
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(intent.text, intent.deviceFollowUpInstruction),
          attachments,
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    case "shell_input":
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(
            `Run this shell command if it is appropriate, explain the result, and stop if it is unsafe:\n\n${intent.command}`,
            intent.deviceFollowUpInstruction,
          ),
          attachments,
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    case "session_control":
      if (intent.action === "stop") {
        return { type: "thread.session.stop", commandId, threadId, createdAt };
      }
      if (intent.action === "interrupt") {
        return { type: "thread.turn.interrupt", commandId, threadId, createdAt };
      }
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(
            intent.action === "continue" ? "Continue." : `Perform controller action: ${intent.action}`,
            intent.deviceFollowUpInstruction,
          ),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    case "approval_response":
      return {
        type: "thread.approval.respond",
        commandId,
        threadId,
        requestId: intent.requestId,
        decision: intent.decision === "approve" ? "accept" : "decline",
        createdAt,
      };
    default:
      throw new Error(`Unsupported T3 command intent: ${intent.type}`);
  }
}

export function buildT3ProjectLaunchCommands({
  project,
  text,
  modelSelection = project?.defaultModelSelection,
  runtimeMode = "approval-required",
  interactionMode = "default",
  threadId = createId("thread"),
}) {
  if (!project?.id) throw new Error("T3 project id is required.");
  if (!modelSelection?.instanceId || !modelSelection?.model) {
    throw new Error("T3 project does not have a usable model selection.");
  }

  const createdAt = nowIso();
  const title = deriveThreadTitle(text);
  return {
    threadId,
    createThread: {
      type: "thread.create",
      commandId: createId("t3cmd"),
      threadId,
      projectId: project.id,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: project.branch ?? null,
      worktreePath: null,
      createdAt,
    },
    startTurn: {
      type: "thread.turn.start",
      commandId: createId("t3cmd"),
      threadId,
      message: {
        messageId: createId("msg"),
        role: "user",
        text,
        attachments: [],
      },
      modelSelection,
      titleSeed: title,
      runtimeMode,
      interactionMode,
      createdAt,
    },
  };
}

export function compressSnapshot(snapshot, threadId = null) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects.length : 0;
  const threadList = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const threads = threadList.length;
  const selected = threadId ? threadList.find((thread) => thread?.id === threadId) ?? null : null;
  if (selected) {
    const sessionState = selected.session?.status ?? null;
    const turnState = selected.latestTurn?.state ?? null;
    const state = sessionState === "running" || turnState === "running"
      ? "running"
      : sessionState === "starting"
        ? "starting"
        : turnState ?? sessionState ?? "idle";
    const pending = pendingThreadInteractions(selected);
    return {
      title: "T3 Code",
      state,
      line1: compactDisplayText(selected.title ?? "Selected task", 28),
      line2: pending.approvals > 0
        ? `${pending.approvals} approval${pending.approvals === 1 ? "" : "s"} waiting`
        : pending.userInput > 0
          ? `${pending.userInput} answer${pending.userInput === 1 ? "" : "s"} waiting`
          : sessionState === "error"
            ? "Session error"
            : `Session ${state}`,
      thread: {
        id: selected.id,
        title: selected.title ?? "Selected task",
        sessionStatus: sessionState,
        latestTurnState: turnState,
        runtimeMode: selected.session?.runtimeMode ?? selected.runtimeMode ?? null,
        interactionMode: selected.interactionMode ?? null,
        pendingApprovals: pending.approvals,
        pendingUserInput: pending.userInput,
      },
    };
  }
  return {
    title: "T3 Code",
    state: "reachable",
    line1: `${projects} projects`,
    line2: `${threads} threads`,
  };
}

export function pendingThreadInteractions(thread) {
  const open = new Map();
  const activities = Array.isArray(thread?.activities) ? [...thread.activities] : [];
  activities.sort((left, right) => {
    const sequence = (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0);
    return sequence || String(left?.createdAt ?? "").localeCompare(String(right?.createdAt ?? ""));
  });
  for (const activity of activities) {
    const requestId = typeof activity?.payload?.requestId === "string" ? activity.payload.requestId : null;
    if (!requestId) continue;
    if (activity.kind === "approval.requested") open.set(requestId, "approval");
    else if (activity.kind === "user-input.requested") open.set(requestId, "user-input");
    else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") open.delete(requestId);
  }
  let approvals = 0;
  let userInput = 0;
  for (const kind of open.values()) {
    if (kind === "approval") approvals += 1;
    if (kind === "user-input") userInput += 1;
  }
  return { approvals, userInput };
}

function compactDisplayText(value, maximum) {
  const text = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function isEnvironmentTokenExpired(environment, now = Date.now()) {
  if (!environment?.accessTokenExpiresAt) return false;
  const expiresAt = Date.parse(environment.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function deriveThreadTitle(text) {
  const compact = String(text ?? "").trim().replace(/\s+/gu, " ");
  if (!compact) return "Agent Controller session";
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

function authorizationHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}
