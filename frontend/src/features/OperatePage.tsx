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
  Image,
  LoaderCircle,
  Mic,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Controller } from "../controller";
import { commandSummary, commandType, formatRelativeTime, renderEventResult } from "../format";
import type { Command, JsonRecord } from "../types";
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

const intentOptions = [
  { value: "agent_prompt", label: "Prompt", icon: Bot },
  { value: "camera_prompt", label: "Image", icon: Image },
  { value: "audio_prompt", label: "Audio", icon: Mic },
  { value: "shell_input", label: "Shell", icon: Terminal },
] as const;

function statusTone(status?: string) {
  if (status === "approval_required") return "warning" as const;
  if (status === "failed" || status === "rejected") return "danger" as const;
  if (status === "completed" || status === "approved") return "success" as const;
  if (status === "dispatched" || status === "running") return "live" as const;
  return "neutral" as const;
}

function intentFromForm(type: string, text: string, mediaUploadId: string): JsonRecord {
  const trimmed = text.trim();
  if (type === "shell_input") return { type, command: trimmed };
  if (type === "camera_prompt") {
    return {
      type,
      prompt: trimmed || "Use the selected image as context.",
      ...(mediaUploadId ? { mediaUploadId } : {}),
    };
  }
  if (type === "audio_prompt") {
    return {
      type,
      transcript: trimmed,
      ...(mediaUploadId ? { mediaUploadId } : {}),
    };
  }
  return { type: "agent_prompt", text: trimmed };
}

export function OperatePage({ controller }: { controller: Controller }) {
  const c = controller;
  const confirm = useConfirm();
  const [intentType, setIntentType] = useState("agent_prompt");
  const [prompt, setPrompt] = useState("");
  const [mediaId, setMediaId] = useState("");
  const [providerInstance, setProviderInstance] = useState("");
  const [model, setModel] = useState("");
  const [macroLabel, setMacroLabel] = useState("");

  const usableHarnesses = c.harnesses.filter((harness) => harness.available !== false);
  const activeHarness = c.harnesses.find((harness) => harness.instanceId === providerInstance) ?? null;
  const availableModels = activeHarness?.models ?? [];

  // Prefer the project's own default, but only when T3 still offers it. Otherwise fall back to
  // what the gateway resolved from the live catalogue, so the fields are never left holding a
  // model that would be rejected at dispatch.
  useEffect(() => {
    const projectDefault = c.selectedProject?.defaultModelSelection ?? null;
    const suggested = c.suggestedModelSelection;
    const isOffered = (instanceId?: string, slug?: string) =>
      Boolean(instanceId && slug && c.harnesses
        .find((harness) => harness.instanceId === instanceId && harness.available !== false)
        ?.models.some((entry) => entry.slug === slug));

    if (isOffered(projectDefault?.instanceId, projectDefault?.model)) {
      setProviderInstance(projectDefault!.instanceId);
      setModel(projectDefault!.model);
      return;
    }
    if (suggested) {
      setProviderInstance(suggested.instanceId);
      setModel(suggested.model);
      return;
    }
    setProviderInstance(projectDefault?.instanceId ?? "");
    setModel(projectDefault?.model ?? "");
  }, [c.selectedProject, c.harnesses, c.suggestedModelSelection]);

  const selectHarness = (instanceId: string) => {
    setProviderInstance(instanceId);
    const harness = c.harnesses.find((entry) => entry.instanceId === instanceId);
    const models = harness?.models ?? [];
    setModel(models.some((entry) => entry.slug === model) ? model : models[0]?.slug ?? "");
  };

  const selectedIntent = intentOptions.find((option) => option.value === intentType)
    ?? intentOptions[0];
  const SelectedIntentIcon = selectedIntent.icon;
  const canSend = Boolean(c.selectedEnvironmentId)
    && (intentType === "camera_prompt" || intentType === "audio_prompt"
      ? Boolean(prompt.trim() || mediaId)
      : Boolean(prompt.trim()));

  const sendIntent = async (intent: JsonRecord, successMessage: string) => {
    if (!c.selectedEnvironmentId) {
      c.setNotice({ tone: "danger", message: "Pair and select a T3 environment first." });
      return;
    }
    await c.run("send-intent", successMessage, async () => {
      const body: JsonRecord = {
        environmentId: c.selectedEnvironmentId,
        intent,
      };
      if (intent.type !== "status") body.threadId = c.selectedThreadId;
      const result = await c.api("/v1/intents", { method: "POST", body });
      await c.refreshAll();
      return result;
    });
  };

  const createMacro = async () => {
    const intent = intentFromForm(intentType, prompt, mediaId);
    await c.run("create-macro", "Macro saved.", async () => {
      const result = await c.api("/v1/macros", {
        method: "POST",
        body: {
          label: macroLabel.trim() || prompt.trim() || selectedIntent.label,
          environmentId: c.selectedEnvironmentId || null,
          threadId: c.selectedThreadId || null,
          intent,
        },
      });
      setMacroLabel("");
      await c.refreshAll();
      return result;
    });
  };

  const runMacro = async (macroId: string) => {
    await c.run(`macro-${macroId}`, "Macro dispatched.", async () => {
      const result = await c.api(`/v1/macros/${encodeURIComponent(macroId)}/run`, {
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

  const deleteMacro = async (macroId: string, label: string) => {
    const accepted = await confirm({
      title: `Delete “${label}”?`,
      description: "The saved macro will be removed from the web dashboard and claimed controllers.",
      confirmLabel: "Delete macro",
    });
    if (!accepted) return;
    await c.run(`delete-macro-${macroId}`, "Macro deleted.", async () => {
      const result = await c.api(`/v1/macros/${encodeURIComponent(macroId)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
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
    await c.run("launch-project", "Project session launched.", async () =>
      c.launchProject({
        projectId: c.selectedProjectId,
        text: prompt.trim() || "Open this project and report that the remote session is ready.",
        ...(providerInstance && model
          ? { modelSelection: { instanceId: providerInstance, model } }
          : {}),
      })
    );
  };

  const counts = c.display?.counts ?? {};

  if (!c.selectedEnvironmentId || (!c.selectedThreadId && c.threads.length === 0 && c.projects.length === 0)) {
    return (
      <div className="thread-empty-shell">
        <div className="thread-empty-state">
          <h2>
            {c.selectedEnvironmentId ? "Pick a thread to continue" : "Connect an environment to begin"}
          </h2>
          <p>
            {c.selectedEnvironmentId
              ? "Load the selected T3 workspace, then choose an existing thread or launch a new one."
              : "Pair a T3 Code environment from the sidebar to start operating an agent."}
          </p>
          {c.selectedEnvironmentId ? (
            <Button
              busy={c.busyAction === "load-snapshot"}
              onClick={() => void c.run("load-snapshot", "T3 sessions loaded.", () => c.loadSnapshot())}
            >
              <RefreshCw className="size-4" /> Load workspace
            </Button>
          ) : null}
        </div>
        <div className="thread-empty-footer">
          <span className="connection-dot" data-live={c.connection === "live" || undefined} />
          <span>{c.connectionDetail}</span>
          <span className="thread-empty-footer__hint">
            {c.environments.length
              ? `${c.environments.length} ${c.environments.length === 1 ? "environment" : "environments"} available`
              : "No environments paired"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="thread-workspace">
      <div className="thread-feed">
        <div className="thread-feed__inner">
          {c.pendingApprovals.map((command) => (
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

          {c.recentCommands.length ? (
            <div className="thread-command-list">
              {c.recentCommands.slice(0, 16).reverse().map((command) => (
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
              <p>This thread is ready</p>
              <span>Send the first instruction from the composer below.</span>
            </div>
          )}
        </div>
      </div>

      <div className="thread-composer-dock">
        <div className="thread-context-toolbar" aria-label="Command context">
          <select
            aria-label="Environment"
            value={c.selectedEnvironmentId}
            onChange={(event) => c.setSelectedEnvironmentId(event.target.value)}
          >
            {c.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>{environment.label}</option>
            ))}
          </select>
          <select
            aria-label="Thread"
            value={c.selectedThreadId}
            onChange={(event) => c.setSelectedThreadId(event.target.value)}
          >
            {c.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>{thread.label}</option>
            ))}
          </select>
          {c.projects.length ? (
            <>
              <select
                aria-label="Project"
                value={c.selectedProjectId}
                onChange={(event) => c.setSelectedProjectId(event.target.value)}
              >
                {c.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title ?? project.name ?? project.workspaceRoot ?? project.id}
                  </option>
                ))}
              </select>
              <select
                aria-label="Agent harness"
                value={providerInstance}
                onChange={(event) => selectHarness(event.target.value)}
                disabled={c.harnesses.length === 0}
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
              <select
                aria-label="Model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={availableModels.length === 0}
              >
                {availableModels.length === 0 ? <option value="">No models reported</option> : null}
                {availableModels.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name}
                    {entry.observed ? " (in use, not in catalogue)" : ""}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                busy={c.busyAction === "launch-project"}
                disabled={!model || activeHarness?.available === false}
                onClick={() => void launchProject()}
              >
                <Play className="size-3.5" /> Launch
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            busy={c.busyAction === "load-snapshot"}
            onClick={() => void c.run("load-snapshot", "T3 sessions loaded.", () => c.loadSnapshot())}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>

        {/* T3 accepts a dispatch and only then has the provider reject it, so a stopped session is
            the only place that failure shows up. */}
        {c.sessionFailures.length > 0 ? (
          <div className="thread-session-failures" role="status">
            {c.sessionFailures.map((failure) => (
              <p key={`${failure.threadId}-${failure.updatedAt}`}>
                <strong>{failure.title ?? failure.threadId}</strong>
                {" stopped"}
                {failure.model ? ` on ${failure.instanceId}/${failure.model}` : ""}
                {": "}
                {failure.message}
              </p>
            ))}
          </div>
        ) : null}

        {c.harnessCatalogueSource === "snapshot-only" && c.projects.length ? (
          <p className="thread-catalogue-hint">
            Only harnesses already in use are listed. Run <code>npm run setup:t3</code> on the T3 host
            to register its full harness and model catalogue.
          </p>
        ) : null}

        {(intentType === "camera_prompt" || intentType === "audio_prompt") ? (
          <select
            className="thread-media-select"
            aria-label="Attached media"
            value={mediaId}
            onChange={(event) => setMediaId(event.target.value)}
          >
            <option value="">No media selected</option>
            {c.media.map((item) => (
              <option key={item.id} value={item.id}>{item.originalName ?? `${item.kind} · ${item.id}`}</option>
            ))}
          </select>
        ) : null}

        <div className="composer-shell">
          <label htmlFor="operate-prompt" className="sr-only">Command or prompt</label>
          <textarea
            id="operate-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder={intentType === "shell_input"
              ? "Enter a shell command, for example: npm test"
              : "Ask for follow-up changes or attach context…"}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSend) {
                event.preventDefault();
                void sendIntent(intentFromForm(intentType, prompt, mediaId), "Command dispatched.");
              }
            }}
          />
          <div className="composer-footer">
            <div className="intent-switcher" aria-label="Prompt type">
              {intentOptions.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className="intent-switcher__item"
                  data-active={intentType === value || undefined}
                  aria-pressed={intentType === value}
                  onClick={() => setIntentType(value)}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden font-mono text-[10px] text-ink-faint sm:inline">⌘↵</span>
              <Button
                variant="primary"
                size="icon"
                busy={c.busyAction === "send-intent"}
                disabled={!canSend}
                aria-label="Send command"
                onClick={() => void sendIntent(intentFromForm(intentType, prompt, mediaId), "Command dispatched.")}
              >
                <Send className="size-4" />
              </Button>
            </div>
          </div>
        </div>

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
            <summary><Braces className="size-3.5" /> Saved actions ({c.macros.length})</summary>
            <div className="thread-tools__panel">
              <div className="grid grid-cols-[1fr_auto] gap-2 p-3">
                <input
                  aria-label="Macro label"
                  value={macroLabel}
                  onChange={(event) => setMacroLabel(event.target.value)}
                  placeholder="Action label"
                />
                <Button size="sm" onClick={() => void createMacro()}><Save className="size-3.5" /> Save</Button>
              </div>
              {c.macros.length ? c.macros.slice(0, 8).map((macro) => (
                <div key={macro.id} className="thread-tool-row">
                  <span>{macro.label}</span>
                  <Button size="sm" variant="ghost" onClick={() => void runMacro(macro.id)}>Run</Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteMacro(macro.id, macro.label)}>Delete</Button>
                </div>
              )) : <p className="p-4 text-xs text-ink-muted">No saved actions yet.</p>}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
