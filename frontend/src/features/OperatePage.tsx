import {
  Activity,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleStop,
  FolderKanban,
  Gauge,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Controller } from "../controller";
import { commandSummary, commandType, formatRelativeTime, renderEventResult } from "../format";
import type { Command, JsonRecord, SavedAction, T3SessionFailure } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";
import {
  AttachmentChips,
  AttachmentSourceMenu,
  ComposerShell,
  ShellModeToggle,
  buildComposerIntent,
  sendComposerIntent,
  useComposerDraft,
  useFileAttachment,
  type ComposerMode,
} from "./Composer";

function statusTone(status?: string) {
  if (status === "approval_required") return "warning" as const;
  if (status === "failed" || status === "rejected") return "danger" as const;
  if (status === "completed" || status === "approved") return "success" as const;
  if (status === "dispatched" || status === "running") return "live" as const;
  return "neutral" as const;
}

function isRecoverableModelFailure(failure: T3SessionFailure) {
  return failure.code === "invalid_request_error"
    && /(model.+not supported|unknown model)/iu.test(failure.message);
}

export function OperatePage({ controller }: { controller: Controller }) {
  const c = controller;
  const confirm = useConfirm();
  const autoLoadEnvironmentRef = useRef<string | null>(null);
  const [workspaceLoadState, setWorkspaceLoadState] = useState<{
    environmentId: string;
    status: "loading" | "loaded" | "failed";
  } | null>(null);
  // Shell stays an explicit secondary mode: its policy screening and approval path differ, so it
  // must never be something a request falls into by accident.
  const [composerMode, setComposerMode] = useState<ComposerMode>("prompt");
  const draft = useComposerDraft(c.media);
  const { prompt, attachmentIds } = draft;
  const attachFiles = useFileAttachment({ controller: c, draft });
  const [providerInstance, setProviderInstance] = useState("");
  const [model, setModel] = useState("");
  const [modelSelectionMode, setModelSelectionMode] = useState<"automatic" | "manual">("automatic");
  const [actionLabel, setActionLabel] = useState("");
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const savedActions = c.actions ?? [];

  const usableHarnesses = c.harnesses.filter((harness) => harness.available !== false);
  const activeHarness = c.harnesses.find((harness) => harness.instanceId === providerInstance) ?? null;
  const availableModels = activeHarness?.models ?? [];
  const selectedThread = c.threads.find((thread) => thread.id === c.selectedThreadId) ?? null;
  const projectThreads = useMemo(
    () => c.selectedProjectId
      ? c.threads.filter((thread) => thread.projectId === c.selectedProjectId)
      : c.threads,
    [c.selectedProjectId, c.threads],
  );
  const threadMessages = selectedThread?.messages ?? [];
  const threadPendingApprovals = useMemo(
    () => c.pendingApprovals.filter((command) =>
      command.threadId === c.selectedThreadId
      && (!command.environmentId || command.environmentId === c.selectedEnvironmentId)
    ),
    [c.pendingApprovals, c.selectedEnvironmentId, c.selectedThreadId],
  );
  const threadCommands = useMemo(
    () => c.recentCommands.filter((command) =>
      command.threadId === c.selectedThreadId
      && (!command.environmentId || command.environmentId === c.selectedEnvironmentId)
    ),
    [c.recentCommands, c.selectedEnvironmentId, c.selectedThreadId],
  );
  const threadFailures = useMemo(
    () => c.sessionFailures.filter((failure) => failure.threadId === c.selectedThreadId),
    [c.sessionFailures, c.selectedThreadId],
  );
  const latestModelSelection = useMemo(() => {
    const preferredInstanceId = c.selectedProject?.defaultModelSelection?.instanceId
      ?? c.suggestedModelSelection?.instanceId
      ?? null;
    const launchable = c.harnesses.filter((harness) =>
      harness.available !== false && harness.models.length > 0
    );
    const harness = launchable.find((entry) => entry.instanceId === preferredInstanceId)
      ?? launchable[0];
    const latestModel = harness?.models[0];
    return harness && latestModel
      ? { instanceId: harness.instanceId, model: latestModel.slug }
      : null;
  }, [c.harnesses, c.selectedProject, c.suggestedModelSelection]);
  const recoveryModelSelection = latestModelSelection;

  // Existing threads keep a valid provider/model pair. New threads use the first model in T3's
  // ordered live catalogue for the project's provider, which is T3's current preferred model.
  useEffect(() => {
    const threadSelection = selectedThread?.modelSelection ?? null;
    const isOffered = (instanceId?: string, slug?: string) =>
      Boolean(instanceId && slug && c.harnesses
        .find((harness) => harness.instanceId === instanceId && harness.available !== false)
        ?.models.some((entry) => entry.slug === slug));

    if (threadSelection && isOffered(threadSelection.instanceId, threadSelection.model)) {
      setProviderInstance(threadSelection.instanceId);
      setModel(threadSelection.model);
      setModelSelectionMode("automatic");
      return;
    }
    if (modelSelectionMode === "manual" && isOffered(providerInstance, model)) return;
    if (latestModelSelection) {
      setProviderInstance(latestModelSelection.instanceId);
      setModel(latestModelSelection.model);
      return;
    }
    setProviderInstance("");
    setModel("");
  }, [
    c.harnesses,
    latestModelSelection,
    model,
    modelSelectionMode,
    providerInstance,
    selectedThread,
  ]);

  const loadWorkspace = useCallback(async (environmentId: string) => {
    if (!environmentId) return;
    autoLoadEnvironmentRef.current = environmentId;
    setWorkspaceLoadState({ environmentId, status: "loading" });
    try {
      await c.loadSnapshot(environmentId);
      if (autoLoadEnvironmentRef.current === environmentId) {
        setWorkspaceLoadState({ environmentId, status: "loaded" });
      }
    } catch {
      if (autoLoadEnvironmentRef.current === environmentId) {
        setWorkspaceLoadState({ environmentId, status: "failed" });
      }
    }
  }, [c.loadSnapshot]);

  useEffect(() => {
    const environmentId = c.selectedEnvironmentId;
    if (!environmentId) {
      autoLoadEnvironmentRef.current = null;
      setWorkspaceLoadState(null);
      return;
    }
    if (c.threads.length > 0 || c.projects.length > 0) {
      setWorkspaceLoadState({ environmentId, status: "loaded" });
      return;
    }
    if (autoLoadEnvironmentRef.current === environmentId) return;

    void loadWorkspace(environmentId);
  }, [
    c.projects.length,
    c.selectedEnvironmentId,
    c.threads.length,
    loadWorkspace,
  ]);

  const selectHarness = (instanceId: string) => {
    setModelSelectionMode("manual");
    if (c.selectedThreadId) c.setSelectedThreadId("");
    setProviderInstance(instanceId);
    const harness = c.harnesses.find((entry) => entry.instanceId === instanceId);
    const models = harness?.models ?? [];
    setModel(models.some((entry) => entry.slug === model) ? model : models[0]?.slug ?? "");
  };

  const selectModel = (slug: string) => {
    setModelSelectionMode("manual");
    if (c.selectedThreadId) c.setSelectedThreadId("");
    setModel(slug);
  };

  const selectEnvironment = (environmentId: string) => {
    setModelSelectionMode("automatic");
    setProviderInstance("");
    setModel("");
    setComposerMode("prompt");
    draft.clearAttachments();
    c.setSelectedEnvironmentId(environmentId);
    void loadWorkspace(environmentId);
  };

  const selectProject = (projectId: string) => {
    setModelSelectionMode("automatic");
    const nextThread = c.threads.find((thread) => thread.projectId === projectId) ?? null;
    c.setSelectedProjectId(projectId);
    c.setSelectedThreadId(nextThread?.id ?? "");
    setComposerMode("prompt");
    draft.clearAttachments();
  };

  const selectThread = (threadId: string) => {
    setModelSelectionMode("automatic");
    const nextThread = c.threads.find((thread) => thread.id === threadId) ?? null;
    if (nextThread?.projectId && nextThread.projectId !== c.selectedProjectId) {
      c.setSelectedProjectId(nextThread.projectId);
    }
    c.setSelectedThreadId(threadId);
    if (!threadId) {
      setComposerMode("prompt");
      draft.clearAttachments();
    }
  };

  const composerIntent = () => buildComposerIntent({
    mode: composerMode,
    text: prompt,
    attachments: draft.attachments,
  });

  // Shell input is never dispatched with attachments, so switching modes drops them rather than
  // silently discarding them at dispatch time.
  const selectComposerMode = (mode: ComposerMode) => {
    setComposerMode(mode);
    if (mode === "shell") draft.clearAttachments();
  };

  const hasRequest = Boolean(prompt.trim())
    || (composerMode === "prompt" && attachmentIds.length > 0);
  const canSendFollowUp = Boolean(c.selectedEnvironmentId && c.selectedThreadId) && hasRequest;
  const canStartThread = Boolean(
    c.selectedEnvironmentId
    && c.selectedProjectId
    && composerMode === "prompt"
    && hasRequest
    && model
    && activeHarness?.available !== false,
  );
  const canSend = c.selectedThreadId ? canSendFollowUp : canStartThread;

  const sendIntent = async (intent: JsonRecord, successMessage: string) =>
    sendComposerIntent(c, intent, successMessage);

  const saveAction = async () => {
    const intent = composerIntent();
    const actionType = composerMode === "shell"
      ? "shell"
      : attachmentIds.length > 0 ? "media" : "prompt";
    const payload = actionType === "shell"
      ? { command: prompt.trim() }
      : actionType === "media"
        ? { mediaKind: intent.type === "audio_prompt" ? "audio" : "image", prompt: prompt.trim() }
        : { text: prompt.trim() };
    await c.run(editingActionId ? `update-action-${editingActionId}` : "create-action", editingActionId ? "Action updated." : "Action saved.", async () => {
      const result = await c.api(editingActionId ? `/v1/actions/${encodeURIComponent(editingActionId)}` : "/v1/actions", {
        method: editingActionId ? "PUT" : "POST",
        body: {
          label: actionLabel.trim() || prompt.trim().slice(0, 32)
            || (composerMode === "shell" ? "Shell" : "Prompt"),
          type: actionType,
          payload,
          targetMode: c.selectedEnvironmentId ? "fixed" : "device-current",
          environmentId: c.selectedEnvironmentId || null,
          threadId: c.selectedThreadId || null,
          intent,
        },
      });
      setActionLabel("");
      setEditingActionId(null);
      await c.refreshAll();
      return result;
    });
  };

  const runSavedAction = async (action: SavedAction) => {
    if (action.type === "media") {
      c.setNotice({ tone: "info", message: "Choose a compatible upload from the Actions library to run this media action." });
      return;
    }
    const actionId = action.id;
    await c.run(`action-${actionId}`, "Action dispatched.", async () => {
      const result = await c.api(`/v1/actions/${encodeURIComponent(actionId)}/run`, {
        method: "POST",
        body: {
          environmentId: c.selectedEnvironmentId || undefined,
          threadId: c.selectedThreadId || undefined,
        },
      });
      await c.refreshAll();
      return result;
    });
  };

  const deleteSavedAction = async (actionId: string, label: string) => {
    const accepted = await confirm({
      title: `Delete “${label}”?`,
      description: "The saved action will be removed from the library and claimed controllers.",
      confirmLabel: "Delete action",
    });
    if (!accepted) return;
    await c.run(`delete-action-${actionId}`, "Action deleted.", async () => {
      const result = await c.api(`/v1/actions/${encodeURIComponent(actionId)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
  };

  const editSavedAction = (action: SavedAction) => {
    const content = action.payload?.text ?? action.payload?.prompt ?? action.payload?.command
      ?? action.intent?.text ?? action.intent?.prompt ?? action.intent?.transcript ?? action.intent?.command;
    // A saved media action carries only the kind it expects, not the uploads themselves, so the
    // draft comes back as text and the user re-attaches from the source menu.
    const isShell = action.type === "shell" || action.intent?.type === "shell_input";
    setComposerMode(isShell ? "shell" : "prompt");
    draft.clearAttachments();
    draft.setPrompt(typeof content === "string" ? content : "");
    setActionLabel(action.label);
    setEditingActionId(action.id);
  };

  const decideCommand = async (command: Command, decision: "approve" | "reject") => {
    if (decision === "reject") {
      const accepted = await confirm({
        title: "Reject this command?",
        description: commandSummary(command),
        confirmLabel: "Reject command",
      });
      if (!accepted) return;
    }
    await c.run(`${decision}-${command.id}`, `Command ${decision}d.`, async () => {
      const result = await c.api(`/v1/commands/${encodeURIComponent(command.id)}/${decision}`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const launchProject = async () => {
    if (!c.selectedProjectId) {
      c.setNotice({ tone: "danger", message: "Load sessions and select a project first." });
      return;
    }
    if ((providerInstance && !model) || (!providerInstance && model)) {
      c.setNotice({
        tone: "danger",
        message: "Provider instance and model must either both be set or both be empty.",
      });
      return;
    }
    const result = await c.run("launch-project", "Project session launched.", async () =>
      c.launchProject({
        projectId: c.selectedProjectId,
        text: prompt.trim()
          || (attachmentIds.length > 0
            ? "Use the attached context."
            : "Open this project and report that the remote session is ready."),
        ...(attachmentIds.length > 0 ? { mediaUploadIds: attachmentIds } : {}),
        ...(providerInstance && model
          ? { modelSelection: { instanceId: providerInstance, model } }
          : {}),
      })
    );
    if (result?.modelRecovery) {
      const { requested, selected } = result.modelRecovery;
      const unavailable = requested
        ? `${requested.instanceId}/${requested.model}`
        : "The selected model";
      c.setNotice({
        tone: "info",
        message: `${unavailable} is unavailable. Started this thread with ${selected.instanceId}/${selected.model} instead.`,
      });
    }
    return result;
  };

  const prepareFailureRecovery = (failure: T3SessionFailure) => {
    if (!recoveryModelSelection) return;
    setModelSelectionMode("manual");
    setProviderInstance(recoveryModelSelection.instanceId);
    setModel(recoveryModelSelection.model);
    setComposerMode("prompt");
    draft.clearAttachments();
    draft.setPrompt(failure.title ?? selectedThread?.label ?? "Continue this task.");
    c.setSelectedThreadId("");
    c.setNotice({
      tone: "info",
      message: `A replacement is ready with ${recoveryModelSelection.instanceId}/${recoveryModelSelection.model}. Review the prompt, then start the new thread.`,
    });
  };

  const submitComposer = async () => {
    const result = c.selectedThreadId
      ? await sendIntent(composerIntent(), "Message sent.")
      : await launchProject();
    if (result !== undefined) draft.reset();
  };

  const counts = c.display?.counts ?? {};
  const selectedEnvironmentLabel = c.environments.find(
    (environment) => environment.id === c.selectedEnvironmentId,
  )?.label ?? "the selected T3 environment";
  const selectedWorkspaceLoadState = workspaceLoadState?.environmentId === c.selectedEnvironmentId
    ? workspaceLoadState.status
    : "loading";
  const contextToolbar = (
    <div className="thread-context-toolbar" aria-label="Command context">
      <label className="thread-context-control">
        <span>Environment</span>
        <select
          aria-label="Environment"
          value={c.selectedEnvironmentId}
          onChange={(event) => selectEnvironment(event.target.value)}
        >
          {c.environments.length === 0 ? <option value="">No environments paired</option> : null}
          {c.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>{environment.label}</option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span>Project</span>
        <select
          aria-label="Project"
          value={c.selectedProjectId}
          onChange={(event) => selectProject(event.target.value)}
          disabled={c.projects.length === 0}
        >
          {c.projects.length === 0 ? <option value="">No projects loaded</option> : null}
          {c.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title ?? project.name ?? project.workspaceRoot ?? project.id}
            </option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span>Thread</span>
        <select
          aria-label="Thread"
          value={c.selectedThreadId}
          onChange={(event) => selectThread(event.target.value)}
          disabled={!c.selectedProjectId}
        >
          <option value="">New thread…</option>
          {projectThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>{thread.label}</option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span>Harness</span>
        <select
          aria-label="Agent harness"
          value={providerInstance}
          onChange={(event) => selectHarness(event.target.value)}
          disabled={!c.selectedProjectId || c.harnesses.length === 0}
        >
          {c.harnesses.length === 0 ? <option value="">No harnesses reported</option> : null}
          {usableHarnesses.map((harness) => (
            <option key={harness.instanceId} value={harness.instanceId}>
              {harness.label}
              {harness.models.length ? ` (${harness.models.length})` : ""}
            </option>
          ))}
          {c.harnesses
            .filter((harness) => harness.available === false)
            .map((harness) => (
              <option key={harness.instanceId} value={harness.instanceId} disabled>
                {harness.label} — {harness.unavailableReason ?? "unavailable"}
              </option>
            ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span>Model</span>
        <select
          aria-label="Model"
          value={model}
          onChange={(event) => selectModel(event.target.value)}
          disabled={!c.selectedProjectId || availableModels.length === 0}
        >
          {availableModels.length === 0 ? <option value="">No models reported</option> : null}
          {availableModels.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <div className="thread-context-actions">
        {selectedWorkspaceLoadState === "loading" ? (
          <span className="thread-context-sync" aria-live="polite">
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> Syncing…
          </span>
        ) : selectedWorkspaceLoadState === "failed" ? (
          <span className="thread-context-sync" data-error="true" aria-live="polite">Sync failed</span>
        ) : null}
        {c.selectedThreadId && c.projects.length ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setModelSelectionMode("automatic");
              c.setSelectedThreadId("");
              setComposerMode("prompt");
              draft.clearAttachments();
            }}
          >
            <Plus className="size-3.5" /> New thread
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          busy={selectedWorkspaceLoadState === "loading"}
          disabled={!c.selectedEnvironmentId}
          onClick={() => void loadWorkspace(c.selectedEnvironmentId)}
        >
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>
    </div>
  );

  if (!c.selectedEnvironmentId || (!c.selectedThreadId && c.threads.length === 0 && c.projects.length === 0)) {
    const workspaceFailed = c.selectedEnvironmentId && selectedWorkspaceLoadState === "failed";
    const workspaceLoaded = c.selectedEnvironmentId && selectedWorkspaceLoadState === "loaded";
    return (
      <div className="thread-workspace">
        <div className="thread-feed">
          <div className="thread-empty-state">
          <h2>
            {!c.selectedEnvironmentId
              ? "Connect an environment to begin"
              : workspaceFailed
                ? "Workspace unavailable"
                : workspaceLoaded
                  ? "Workspace is empty"
                  : "Loading workspace"}
          </h2>
          <p>
            {!c.selectedEnvironmentId
              ? "Pair a T3 Code environment from the sidebar to start operating an agent."
              : workspaceFailed
                ? `Could not fetch projects and threads from ${selectedEnvironmentLabel}.`
                : workspaceLoaded
                  ? `${selectedEnvironmentLabel} did not report any projects or threads.`
                  : `Fetching projects and threads from ${selectedEnvironmentLabel}.`}
          </p>
          {c.selectedEnvironmentId && !workspaceFailed && !workspaceLoaded ? (
            <div className="thread-empty-loading" role="status" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              <span>Loading workspace…</span>
            </div>
          ) : null}
          {c.selectedEnvironmentId && (workspaceFailed || workspaceLoaded) ? (
            <Button
              variant="secondary"
              onClick={() => void loadWorkspace(c.selectedEnvironmentId)}
            >
              <RefreshCw className="size-4" /> {workspaceFailed ? "Retry" : "Refresh workspace"}
            </Button>
          ) : null}
          </div>
        </div>
        <div className="thread-composer-dock">{contextToolbar}</div>
      </div>
    );
  }

  return (
    <div className="thread-workspace">
      <div className="thread-feed">
        <div className="thread-feed__inner">
          {threadFailures.length > 0 ? (
            <section className="thread-failure-notice" role="status" aria-label="Session failures">
              <header>
                <span className="thread-failure-notice__icon" aria-hidden="true">
                  <ShieldAlert className="size-4" />
                </span>
                <span>
                  <strong>Session issues</strong>
                  <small>Provider errors from recent launches</small>
                </span>
                <StatusBadge
                  tone="danger"
                  label={`${threadFailures.length} failed`}
                />
              </header>
              <div className="thread-failure-notice__list">
                {threadFailures.map((failure) => (
                  <article key={`${failure.threadId}-${failure.updatedAt}`}>
                    <p>
                      <strong>{failure.title ?? failure.threadId}</strong>
                      <span>
                        Stopped{failure.model ? ` on ${failure.instanceId}/${failure.model}` : ""}
                      </span>
                    </p>
                    <div className="thread-failure-notice__detail">
                      <small>{failure.message}</small>
                      {recoveryModelSelection
                        && isRecoverableModelFailure(failure)
                        && (failure.instanceId !== recoveryModelSelection.instanceId
                          || failure.model !== recoveryModelSelection.model) ? (
                          <div className="thread-failure-notice__recovery">
                            <span>
                              Available: {recoveryModelSelection.instanceId}/{recoveryModelSelection.model}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => prepareFailureRecovery(failure)}
                            >
                              <Play className="size-3.5" /> Prepare replacement
                            </Button>
                          </div>
                        ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {c.harnessCatalogueSource === "snapshot-only" && c.projects.length ? (
            <div className="thread-catalogue-notice" role="note">
              <Braces className="size-4" aria-hidden="true" />
              <p>
                Only harnesses already in use are listed. Run <code>npm run setup:t3</code> on the T3 host
                to register its full harness and model catalogue.
              </p>
            </div>
          ) : null}

          {threadPendingApprovals.map((command) => (
            <section key={command.id} className="thread-approval">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="warning" label="Approval required" />
                  <span className="font-mono text-[10px] text-ink-faint">{command.id}</span>
                </div>
                <p className="mt-3 text-sm font-semibold capitalize">{commandType(command)}</p>
                <pre>{commandSummary(command)}</pre>
                <p className="mt-2 text-xs text-ink-muted">
                  Risk: <span className="capitalize text-warning-strong">{command.risk ?? "unknown"}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  busy={c.busyAction === `approve-${command.id}`}
                  onClick={() => void decideCommand(command, "approve")}
                >
                  <Check className="size-4" /> Approve
                </Button>
                <Button variant="danger-ghost" size="sm" onClick={() => void decideCommand(command, "reject")}>
                  <X className="size-4" /> Reject
                </Button>
              </div>
            </section>
          ))}

          {threadMessages.length ? (
            <div className="thread-message-list" aria-label="Thread messages">
              {threadMessages.map((message) => (
                <article key={message.id} className="thread-message" data-role={message.role}>
                  <header>
                    <span>{message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : message.role}</span>
                    <span>
                      {message.streaming ? "Responding" : null}
                      {message.createdAt ? <time>{formatRelativeTime(message.createdAt)}</time> : null}
                    </span>
                  </header>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
          ) : threadCommands.length ? (
            <div className="thread-command-list">
              {threadCommands.slice(0, 16).reverse().map((command) => (
                <article key={command.id} className="thread-command">
                  <div className="thread-command__meta">
                    <span className="capitalize">{commandType(command)}</span>
                    <time>{formatRelativeTime(command.createdAt)}</time>
                  </div>
                  <button
                    type="button"
                    onClick={() => void c.run(`timeline-${command.id}`, "Timeline loaded.", () => c.loadCommandTimeline(command))}
                  >
                    <p>{commandSummary(command)}</p>
                    <StatusBadge tone={statusTone(command.status)} label={command.status.replaceAll("_", " ")} />
                    <ChevronRight className="size-4 text-ink-faint" />
                  </button>
                  {c.timelineCommand?.id === command.id && c.commandEvents.length ? (
                    <div className="thread-events">
                      {c.commandEvents.map((event) => (
                        <div key={event.id}>
                          <span className="thread-events__dot" />
                          <p>
                            <strong>{event.status.replaceAll("_", " ")}</strong>
                            <span>{renderEventResult(event.result)}</span>
                          </p>
                          <time>{formatRelativeTime(event.createdAt)}</time>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="thread-feed__empty">
              <Bot className="size-5" />
              <p>{c.selectedThreadId ? "This thread is ready" : "Start a new thread"}</p>
              <span>
                {c.selectedThreadId
                  ? "Send the next instruction from the composer below."
                  : "Write the first message below. Future messages will stay in this thread."}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="thread-composer-dock">
        {contextToolbar}

        <ComposerShell
          textareaId="operate-prompt"
          label="Command or prompt"
          value={prompt}
          onChange={draft.setPrompt}
          placeholder={composerMode === "shell"
            ? "Enter a shell command, for example: npm test"
            : c.selectedThreadId
              ? "Ask for follow-up changes, or paste, drop, and attach context…"
              : "Describe the first task for this new thread…"}
          canSend={canSend}
          onSubmit={() => void submitComposer()}
          onFiles={composerMode === "shell" ? undefined : (files) => void attachFiles(files)}
          attachments={
            <AttachmentChips
              attachments={draft.attachments}
              onRemove={draft.removeAttachment}
              onMove={draft.moveAttachment}
            />
          }
          actions={
            <>
              <AttachmentSourceMenu
                controller={c}
                draft={draft}
                disabled={composerMode === "shell"}
                disabledReason="Shell commands cannot carry attachments."
              />
              <ShellModeToggle mode={composerMode} onChange={selectComposerMode} />
            </>
          }
          send={
            <>
              <span className="hidden font-mono text-[10px] text-ink-faint sm:inline">⌘↵</span>
              <Button
                variant="primary"
                size="icon"
                busy={c.busyAction === (c.selectedThreadId ? "send-intent" : "launch-project")}
                disabled={!canSend}
                aria-label={c.selectedThreadId ? "Send message" : "Start new thread"}
                onClick={() => void submitComposer()}
              >
                {c.selectedThreadId ? <Send className="size-4" /> : <Play className="size-4" />}
              </Button>
            </>
          }
        />

        <div className="thread-composer-meta">
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void sendIntent({ type: "status" }, "Status requested.")}>
              <Gauge className="size-3.5" /> Status
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => void sendIntent({ type: "session_control", action: "stop" }, "Stop requested.")}
            >
              <CircleStop className="size-3.5" /> Stop
            </Button>
          </div>
          <details className="thread-tools">
            <summary><Braces className="size-3.5" /> Saved actions ({savedActions.length})</summary>
            <div className="thread-tools__panel">
              <div className="grid grid-cols-[1fr_auto] gap-2 p-3">
                <input
                  aria-label="Action label"
                  value={actionLabel}
                  onChange={(event) => setActionLabel(event.target.value)}
                  placeholder="Action label"
                />
                <Button size="sm" disabled={!prompt.trim()} onClick={() => void saveAction()}><Save className="size-3.5" /> {editingActionId ? "Update" : "Save"}</Button>
              </div>
              {editingActionId ? (
                <button type="button" className="thread-tools__cancel-edit" onClick={() => { setEditingActionId(null); setActionLabel(""); }}>
                  <X className="size-3" /> Editing saved action — cancel
                </button>
              ) : null}
              {savedActions.length ? savedActions.slice(0, 8).map((action) => (
                <div key={action.id} className="thread-tool-row">
                  <span className="thread-tool-row__copy">
                    <span>{action.label}</span>
                    {action.type === "media" ? <small>Choose media in Actions</small> : null}
                  </span>
                  <Button size="icon" variant="ghost" aria-label={`Edit ${action.label}`} onClick={() => editSavedAction(action)}><Pencil className="size-3.5" /></Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.type === "media"}
                    title={action.type === "media" ? "Choose a compatible upload from the Actions library" : undefined}
                    onClick={() => void runSavedAction(action)}
                  >Run</Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteSavedAction(action.id, action.label)}>Delete</Button>
                </div>
              )) : <p className="p-4 text-xs text-ink-muted">No saved actions yet.</p>}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
