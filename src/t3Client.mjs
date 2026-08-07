import { createId, nowIso } from "./ids.mjs";

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

export async function fetchT3Snapshot(environment) {
  const timeoutMs = Number.isFinite(environment?.timeoutMs) ? environment.timeoutMs : 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(new URL("/api/orchestration/snapshot", environment.baseUrl), {
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
    throw new Error(`T3 dispatch failed with HTTP ${response.status}.`);
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
          text: intent.text,
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
          text: `Run this shell command if it is appropriate, explain the result, and stop if it is unsafe:\n\n${intent.command}`,
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
          text: intent.action === "continue" ? "Continue." : `Perform controller action: ${intent.action}`,
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

export function compressSnapshot(snapshot) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects.length : 0;
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads.length : 0;
  return {
    title: "T3 Code",
    state: "reachable",
    line1: `${projects} projects`,
    line2: `${threads} threads`,
  };
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
