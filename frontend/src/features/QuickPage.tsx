import {
  BellRing,
  Boxes,
  Cable,
  Camera,
  Check,
  Mic,
  Play,
  Square,
  VideoOff,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";

import type { Controller } from "../controller";
import { commandSummary, commandType, fileToBase64, formatRelativeTime } from "../format";
import { useAudioRecorder, useCameraCapture } from "../mediaCapture";
import type { Command, JsonRecord, MediaItem, PageId } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";

interface QuickPageProps {
  controller: Controller;
  onNavigate: (page: PageId) => void;
}

/**
 * Phone-first control surface: the five workflows the roadmap wants on a handset —
 * push-to-talk, camera prompt, approvals, quick macros, and device setup — in one
 * single-column stack that stays usable at a 375px viewport.
 */
export function QuickPage({ controller: c, onNavigate }: QuickPageProps) {
  const confirm = useConfirm();
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [cameraPrompt, setCameraPrompt] = useState("");
  const [notificationHint, setNotificationHint] = useState<string | null>(null);

  const targeted = Boolean(c.selectedEnvironmentId);
  const notifyError = (message: string) => c.setNotice({ tone: "danger", message });

  const uploadMedia = async (payload: JsonRecord) => {
    const result = await c.api<{ media: MediaItem }>("/v1/media", {
      method: "POST",
      body: payload,
    });
    return result.media;
  };

  const dispatchIntent = async (intent: JsonRecord) => {
    const body: JsonRecord = { environmentId: c.selectedEnvironmentId, intent };
    if (intent.type !== "status") body.threadId = c.selectedThreadId;
    return c.api("/v1/intents", { method: "POST", body });
  };

  const recorder = useAudioRecorder({
    onError: notifyError,
    onComplete: async (blob, contentType) => {
      const shouldDispatch = autoDispatch && targeted;
      await c.run(
        "quick-audio",
        shouldDispatch ? "Voice prompt dispatched." : "Recording uploaded.",
        async () => {
          const media = await uploadMedia({
            kind: "audio",
            contentType,
            dataBase64: await fileToBase64(blob),
            originalName: `push-to-talk-${new Date().toISOString()}.webm`,
          });
          const result = shouldDispatch
            ? await dispatchIntent({ type: "audio_prompt", mediaUploadId: media.id })
            : media;
          await c.refreshAll();
          return result;
        },
      );
    },
  });

  const camera = useCameraCapture({ onError: notifyError });

  const captureAndSend = async () => {
    const blob = await camera.capture().catch((error: unknown) => {
      notifyError(error instanceof Error ? error.message : "Camera capture failed.");
      return null;
    });
    if (!blob) {
      notifyError("Open the camera before capturing a frame.");
      return;
    }
    const shouldDispatch = autoDispatch && targeted;
    await c.run(
      "quick-camera",
      shouldDispatch ? "Camera prompt dispatched." : "Snapshot uploaded.",
      async () => {
        const media = await uploadMedia({
          kind: "image",
          contentType: "image/png",
          dataBase64: await fileToBase64(blob),
          originalName: `snapshot-${new Date().toISOString()}.png`,
        });
        const result = shouldDispatch
          ? await dispatchIntent({
            type: "camera_prompt",
            mediaUploadId: media.id,
            ...(cameraPrompt.trim() ? { prompt: cameraPrompt.trim() } : {}),
          })
          : media;
        await c.refreshAll();
        return result;
      },
    );
  };

  const decide = async (command: Command, decision: "approve" | "reject") => {
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

  const enableNotifications = async () => {
    const result = await c.enableApprovalNotifications();
    if (result === "granted") {
      setNotificationHint(null);
      c.setNotice({ tone: "success", message: "Approval notifications enabled." });
      return;
    }
    setNotificationHint(
      result === "unsupported"
        ? "This browser cannot raise notifications. Install the app to the home screen or use the desktop console."
        : result === "denied"
          ? "Notifications are blocked for this site. Re-enable them in your browser's site settings."
          : "Notification permission was dismissed. Try again to allow approval alerts.",
    );
  };

  const startTalking = () => {
    if (recorder.recording) return;
    void recorder.start();
  };

  return (
    <div className="quick-stack">
      <Panel elevated className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Target"
          title="Where commands go"
          action={
            <StatusBadge
              tone={targeted ? "success" : "warning"}
              label={targeted ? "ready" : "no environment"}
            />
          }
        />
        <div className="grid gap-3 border-t border-control p-4">
          {c.environments.length ? (
            <>
              <Field label="Environment" htmlFor="quick-environment">
                <select
                  id="quick-environment"
                  value={c.selectedEnvironmentId}
                  onChange={(event) => c.setSelectedEnvironmentId(event.target.value)}
                >
                  {c.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>{environment.label}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Thread"
                htmlFor="quick-thread"
                hint={c.threads.length ? undefined : "Load the workspace from Operate to list threads."}
              >
                <select
                  id="quick-thread"
                  value={c.selectedThreadId}
                  disabled={!c.threads.length}
                  onChange={(event) => c.setSelectedThreadId(event.target.value)}
                >
                  {c.threads.length
                    ? c.threads.map((thread) => (
                      <option key={thread.id} value={thread.id}>{thread.label}</option>
                    ))
                    : <option value="">No threads loaded</option>}
                </select>
              </Field>
            </>
          ) : (
            <EmptyState
              compact
              icon={Cable}
              title="No environment paired"
              description="Pair a T3 Code workstation before sending prompts from your phone."
              action={<Button onClick={() => onNavigate("environments")}>Pair an environment</Button>}
            />
          )}
          <label className="quick-toggle">
            <input
              type="checkbox"
              checked={autoDispatch}
              onChange={(event) => setAutoDispatch(event.target.checked)}
            />
            <span>
              <span className="text-sm font-semibold">Send captures straight to the agent</span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                Off stores the capture in the media library without dispatching a command.
              </span>
            </span>
          </label>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Approvals"
          title={c.pendingApprovals.length
            ? `${c.pendingApprovals.length} waiting on you`
            : "Nothing waiting"}
          action={
            <StatusBadge
              tone={c.pendingApprovals.length ? "warning" : "neutral"}
              label={c.pendingApprovals.length ? "action required" : "clear"}
            />
          }
        />
        {!c.approvalNotificationsEnabled ? (
          <div className="border-t border-control bg-surface-inset/45 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <BellRing className="size-4 text-primary" aria-hidden="true" /> Alert me when approvals arrive
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Raises a system notification while the console is in the background. Permission is only
              requested when you tap this button.
            </p>
            {notificationHint ? (
              <p className="mt-2 text-xs text-danger" role="alert">{notificationHint}</p>
            ) : null}
            <Button
              className="mt-3 w-full"
              disabled={c.notificationSupport === "unsupported"}
              onClick={() => void enableNotifications()}
            >
              <BellRing className="size-4" /> Enable approval notifications
            </Button>
          </div>
        ) : null}
        {c.pendingApprovals.length ? (
          <div className="divide-y divide-control border-t border-control">
            {c.pendingApprovals.map((command) => (
              <article key={command.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="warning" label={command.risk ?? "review"} />
                  <span className="text-sm font-semibold capitalize">{commandType(command)}</span>
                  <time className="ml-auto text-xs text-ink-faint">
                    {formatRelativeTime(command.createdAt)}
                  </time>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-md border border-control bg-console p-3 font-mono text-xs text-console-ink">
                  {commandSummary(command)}
                </pre>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button
                    variant="primary"
                    size="lg"
                    busy={c.busyAction === `approve-${command.id}`}
                    onClick={() => void decide(command, "approve")}
                  >
                    <Check className="size-4" /> Approve
                  </Button>
                  <Button size="lg" variant="danger-ghost" onClick={() => void decide(command, "reject")}>
                    <X className="size-4" /> Reject
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="border-t border-control p-4 text-sm text-ink-muted">
            Commands that trip a policy rule appear here for a decision.
          </p>
        )}
      </Panel>

      <Panel elevated className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Push to talk"
          title="Speak a prompt"
          action={<StatusBadge tone={recorder.recording ? "danger" : "neutral"} label={recorder.status} />}
        />
        <div className="grid justify-items-center gap-3 border-t border-control p-5 text-center">
          <button
            type="button"
            className="push-to-talk"
            data-recording={recorder.recording || undefined}
            aria-pressed={recorder.recording}
            aria-label={recorder.recording ? "Release to send voice prompt" : "Hold to record a voice prompt"}
            disabled={!recorder.supported || c.busyAction === "quick-audio"}
            onPointerDown={startTalking}
            onPointerUp={recorder.stop}
            onPointerCancel={recorder.stop}
            onPointerLeave={recorder.stop}
            onKeyDown={(event) => {
              if (event.key !== " " && event.key !== "Enter") return;
              event.preventDefault();
              if (!event.repeat) startTalking();
            }}
            onKeyUp={(event) => {
              if (event.key !== " " && event.key !== "Enter") return;
              event.preventDefault();
              recorder.stop();
            }}
          >
            <Mic className="size-9" aria-hidden="true" />
          </button>
          <p className="text-sm font-semibold">
            {recorder.recording ? "Listening — release to send" : "Hold the mic to talk"}
          </p>
          <p className="text-xs leading-relaxed text-ink-muted">
            {recorder.supported
              ? "Audio uploads on release. The gateway transcribes it, or forwards it as media context when no transcriber is configured."
              : "This browser does not expose microphone recording."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!recorder.supported || recorder.recording} onClick={startTalking}>
              <Play className="size-3.5" /> Record
            </Button>
            <Button size="sm" variant="danger-ghost" disabled={!recorder.recording} onClick={recorder.stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Camera prompt"
          title="Show the agent something"
          action={<StatusBadge tone={camera.active ? "live" : "neutral"} label={camera.status} />}
        />
        <div className="space-y-3 border-t border-control p-4">
          <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-control bg-black">
            <video ref={camera.videoRef} className="size-full object-cover" playsInline muted />
            {!camera.active ? (
              <div className="absolute inset-0 grid place-items-center text-console-muted">
                <div className="text-center">
                  <VideoOff className="mx-auto size-6" aria-hidden="true" />
                  <p className="mt-2 text-xs">Camera closed</p>
                </div>
              </div>
            ) : null}
          </div>
          <Field label="Question about the frame" htmlFor="quick-camera-prompt">
            <input
              id="quick-camera-prompt"
              value={cameraPrompt}
              onChange={(event) => setCameraPrompt(event.target.value)}
              placeholder="What is wrong with this wiring?"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" disabled={!camera.supported} onClick={() => void camera.toggle()}>
              <Camera className="size-4" /> {camera.active ? "Close" : "Open"}
            </Button>
            <Button
              size="lg"
              variant="primary"
              disabled={!camera.active}
              busy={c.busyAction === "quick-camera"}
              onClick={() => void captureAndSend()}
            >
              <Zap className="size-4" /> Capture
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Quick macros"
          title="Saved actions"
          description="One tap re-runs a saved intent against the selected environment and thread."
        />
        {c.macros.length ? (
          <div className="grid gap-2 border-t border-control p-4">
            {c.macros.map((macro) => (
              <Button
                key={macro.id}
                size="lg"
                className="justify-start"
                busy={c.busyAction === `macro-${macro.id}`}
                disabled={!targeted}
                onClick={() => void runMacro(macro.id)}
              >
                <Zap className="size-4 shrink-0" />
                <span className="truncate">{macro.label}</span>
              </Button>
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={Zap}
            title="No saved actions"
            description="Save a macro from the Operate composer to get one-tap phone controls."
            action={<Button onClick={() => onNavigate("operate")}>Open Operate</Button>}
          />
        )}
      </Panel>

      <Panel className="overflow-hidden">
        <SectionHeader
          compact
          eyebrow="Device setup"
          title={c.devices.length
            ? `${c.devices.length} claimed ${c.devices.length === 1 ? "controller" : "controllers"}`
            : "No controllers claimed"}
        />
        <div className="grid gap-2 border-t border-control p-4">
          <Button size="lg" className="justify-start" onClick={() => onNavigate("devices")}>
            <Boxes className="size-4" /> Claim or configure a controller
          </Button>
          <Button size="lg" className="justify-start" onClick={() => onNavigate("environments")}>
            <Cable className="size-4" /> Pair a T3 environment
          </Button>
        </div>
      </Panel>
    </div>
  );
}
