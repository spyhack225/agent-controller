import {
  Camera,
  FileAudio,
  FileImage,
  FileUp,
  Image,
  Mic,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
  UploadCloud,
  VideoOff,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Controller } from "../controller";
import {
  fileToBase64,
  formatMediaProcessing,
  formatRelativeTime,
} from "../format";
import { CAPTURE_STATUS_LABEL, useAudioRecorder, useCameraCapture } from "../mediaCapture";
import type { MediaItem } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";

export function MediaPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setTranscriptDrafts((current) => {
      const next = { ...current };
      for (const item of c.media) {
        if (!(item.id in next)) next[item.id] = item.transcript ?? "";
      }
      return next;
    });
  }, [c.media]);

  const uploadMedia = async (payload: Record<string, unknown>) => {
    const result = await c.api<{ media: MediaItem }>("/v1/media", {
      method: "POST",
      body: payload,
    });
    await c.refreshAll();
    return result;
  };

  const uploadFile = async () => {
    if (!file) {
      c.setNotice({ tone: "danger", message: "Choose an image or audio file first." });
      return;
    }
    await c.run("upload-media", "Media uploaded.", async () => {
      const kind = file.type.startsWith("audio/") ? "audio" : "image";
      const result = await uploadMedia({
        kind,
        contentType: file.type,
        dataBase64: await fileToBase64(file),
        originalName: file.name,
        ...(kind === "audio" && uploadTranscript.trim()
          ? { transcript: uploadTranscript.trim() }
          : {}),
      });
      setFile(null);
      setUploadTranscript("");
      return result;
    });
  };

  const notifyError = (message: string) => c.setNotice({ tone: "danger", message });

  const recorder = useAudioRecorder({
    onError: notifyError,
    onComplete: async (blob, contentType) => {
      await c.run("upload-recording", "Recording uploaded.", async () => uploadMedia({
        kind: "audio",
        contentType,
        dataBase64: await fileToBase64(blob),
        transcript: uploadTranscript.trim() || undefined,
        originalName: `recording-${new Date().toISOString()}.webm`,
      }));
    },
  });

  const camera = useCameraCapture({ onError: notifyError });

  const captureCamera = async () => {
    const blob = await camera.capture().catch((error: unknown) => {
      notifyError(error instanceof Error ? error.message : "Camera capture failed.");
      return null;
    });
    if (!blob) return;
    await c.run("capture-camera", "Camera frame uploaded.", async () => {
      camera.setStatus("saving");
      const result = await uploadMedia({
        kind: "image",
        contentType: "image/png",
        dataBase64: await fileToBase64(blob),
        originalName: `snapshot-${new Date().toISOString()}.png`,
      });
      camera.setStatus("uploaded");
      return result;
    });
  };

  const saveTranscript = async (item: MediaItem) => {
    const transcript = transcriptDrafts[item.id]?.trim();
    if (!transcript) {
      c.setNotice({ tone: "danger", message: "Enter a transcript before saving." });
      return;
    }
    await c.run(`transcript-${item.id}`, "Transcript saved.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}/transcript`, {
        method: "PUT",
        body: { transcript },
      });
      await c.refreshMedia();
      return result;
    });
  };

  const transcribe = async (item: MediaItem) => {
    await c.run(`transcribe-${item.id}`, "Transcription requested.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}/transcribe`, {
        method: "POST",
        body: {},
      });
      await c.refreshMedia();
      return result;
    });
  };

  const deleteMedia = async (item: MediaItem) => {
    const accepted = await confirm({
      title: `Delete ${item.originalName ?? item.id}?`,
      description: "The stored capture and its transcript will be permanently removed.",
      confirmLabel: "Delete media",
    });
    if (!accepted) return;
    await c.run(`delete-media-${item.id}`, "Media deleted.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
  };

  return (
    <div className="page-stack">
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel elevated className="overflow-hidden xl:col-span-1">
          <SectionHeader
            eyebrow="Upload"
            title="Add media context"
            description="Images and audio can be attached to agent prompts."
          />
          <div className="space-y-4 border-t border-control p-5">
            <label className="upload-drop">
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <UploadCloud className="size-6 text-primary" />
              <span className="font-display text-sm font-semibold">{file?.name ?? "Choose image or audio"}</span>
              <span className="text-xs text-ink-muted">PNG, JPEG, WebP, WAV, MP3, MP4, WebM, or OGG</span>
            </label>
            <Field label="Audio transcript" htmlFor="upload-transcript" hint="Optional for audio uploads.">
              <textarea
                id="upload-transcript"
                rows={3}
                value={uploadTranscript}
                onChange={(event) => setUploadTranscript(event.target.value)}
                placeholder="Paste or enter a transcript"
              />
            </Field>
            <Button
              className="w-full"
              variant="primary"
              busy={c.busyAction === "upload-media"}
              onClick={() => void uploadFile()}
            >
              <FileUp className="size-4" /> Upload media
            </Button>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Microphone"
            title="Record audio"
            action={
              <StatusBadge
                tone={recorder.recording ? "danger" : recorder.status === "uploaded" ? "success" : "neutral"}
                label={CAPTURE_STATUS_LABEL[recorder.status]}
              />
            }
          />
          <div className="grid min-h-52 place-items-center border-t border-control bg-surface-inset/40 p-5 text-center">
            <div>
              <div className="mx-auto grid size-16 place-items-center rounded-full border border-control bg-surface-raised shadow-sm">
                <Mic className="size-7 text-primary" />
              </div>
              <p className="mt-4 text-sm font-semibold">
                {recorder.recording ? "Recording in progress" : "Capture a voice prompt"}
              </p>
              <p className="mt-1 text-xs text-ink-muted">Recording uploads automatically when stopped.</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  disabled={!recorder.supported || recorder.recording || c.busyAction === "upload-recording"}
                  onClick={() => void recorder.start()}
                >
                  <Play className="size-4" /> Record
                </Button>
                <Button
                  variant="danger-ghost"
                  disabled={!recorder.recording}
                  onClick={recorder.stop}
                >
                  <Square className="size-4" /> Stop
                </Button>
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Camera"
            title="Capture an image"
            action={
              <StatusBadge
                tone={camera.status === "ready" ? "live" : camera.status === "uploaded" ? "success" : "neutral"}
                label={CAPTURE_STATUS_LABEL[camera.status]}
              />
            }
          />
          <div className="border-t border-control bg-console p-3">
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-white/10 bg-black">
              <video ref={camera.videoRef} className="size-full object-cover" playsInline muted />
              {!camera.active ? (
                <div className="absolute inset-0 grid place-items-center text-console-muted">
                  <div className="text-center">
                    <VideoOff className="mx-auto size-7" />
                    <p className="mt-2 text-xs">Camera closed</p>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mt-3 flex gap-2">
              <Button className="flex-1" disabled={!camera.supported} onClick={() => void camera.toggle()}>
                <Camera className="size-4" /> {camera.active ? "Close" : "Open"}
              </Button>
              <Button
                className="flex-1"
                variant="primary"
                disabled={!camera.active}
                busy={c.busyAction === "capture-camera"}
                onClick={() => void captureCamera()}
              >
                <Image className="size-4" /> Capture
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <Panel elevated className="overflow-hidden">
        <SectionHeader
          eyebrow="Library"
          title="Stored media"
          description="Processing, transcripts, and retention state for user-scoped captures."
          action={
            <Button size="sm" onClick={() => void c.refreshMedia()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          }
        />
        {c.media.length ? (
          <div className="divide-y divide-control border-t border-control">
            {c.media.map((item) => (
              <article key={item.id} className="grid gap-4 p-4 lg:grid-cols-[auto_minmax(180px,0.55fr)_minmax(260px,1fr)_auto] lg:items-center">
                <div className="grid size-10 place-items-center rounded-lg border border-control bg-surface-inset text-primary">
                  {item.kind === "audio" ? <FileAudio className="size-5" /> : <FileImage className="size-5" />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{item.originalName ?? item.id}</p>
                    <StatusBadge
                      tone={item.processing?.lastError ? "danger" : item.processing?.transcriptionStatus === "processing" ? "warning" : "success"}
                      label={formatMediaProcessing(item)}
                    />
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{item.id}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {item.contentType} · {item.sizeBytes ?? 0} B · {formatRelativeTime(item.createdAt)}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    Expires {item.expiresAt ? formatRelativeTime(item.expiresAt) : "only when manually deleted"}
                  </p>
                </div>
                <div>
                  {item.kind === "audio" ? (
                    <Field label="Transcript" htmlFor={`transcript-${item.id}`}>
                      <textarea
                        id={`transcript-${item.id}`}
                        rows={3}
                        value={transcriptDrafts[item.id] ?? ""}
                        onChange={(event) => setTranscriptDrafts((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))}
                        placeholder="No transcript"
                      />
                    </Field>
                  ) : (
                    <div className="rounded-lg border border-dashed border-control p-4 text-center text-xs text-ink-muted">
                      Image context is ready to attach from Operate.
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 lg:flex-col">
                  {item.kind === "audio" ? (
                    <>
                      <Button size="sm" onClick={() => void transcribe(item)}>
                        <WandSparkles className="size-3.5" /> Transcribe
                      </Button>
                      <Button size="sm" onClick={() => void saveTranscript(item)}>
                        <Save className="size-3.5" /> Save
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteMedia(item)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={UploadCloud}
            title="No stored media"
            description="Upload a file, record audio, or capture a camera frame to add context."
          />
        )}
      </Panel>
    </div>
  );
}
