import {
  Camera,
  FileAudio,
  FileImage,
  FileUp,
  Image,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  UploadCloud,
  VideoOff,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  StatusBadge,
  useConfirm,
} from "../ui";

type MediaSource = "upload" | "audio" | "camera";

export function MediaPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [source, setSource] = useState<MediaSource>("upload");
  const creatorTriggerRef = useRef<HTMLButtonElement>(null);
  const creatorDialogRef = useRef<HTMLElement>(null);
  const creatorCloseRef = useRef<HTMLButtonElement>(null);

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

  const closeCreator = () => {
    if (recorder.recording) {
      c.setNotice({ tone: "info", message: "Stop the recording before closing Add media." });
      return;
    }
    camera.close();
    setCreatorOpen(false);
    setSource("upload");
    setFile(null);
    setUploadTranscript("");
  };

  const selectSource = (next: MediaSource) => {
    if (recorder.recording) return;
    if (source === "camera" && next !== "camera") camera.close();
    setSource(next);
  };

  useEffect(() => {
    if (!creatorOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : creatorTriggerRef.current;
    const frame = window.requestAnimationFrame(() => creatorCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        creatorCloseRef.current?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        creatorDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [creatorOpen]);

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
    <div className="page-stack media-workspace media-library-workspace">
      <header className="media-library-header">
        <div>
          <p className="eyebrow">Library</p>
          <h2>Media context</h2>
          <p>Uploads and captures available to attach from Operations.</p>
        </div>
        <div className="media-library-header__actions">
          <Button size="sm" onClick={() => void c.refreshMedia()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          {c.media.length ? (
            <Button
              ref={creatorTriggerRef}
              size="sm"
              variant="primary"
              onClick={() => setCreatorOpen(true)}
            >
              <Plus className="size-4" /> Add media
            </Button>
          ) : null}
        </div>
      </header>

      <Panel className="media-library overflow-hidden">
        {c.media.length ? (
          <div className="divide-y divide-control">
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
                      Image context is ready to attach from Operations.
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
            description="Add a file, voice recording, or camera frame when you need visual or audio context."
            action={
              <Button variant="primary" onClick={() => setCreatorOpen(true)}>
                <Plus className="size-4" /> Add media
              </Button>
            }
          />
        )}
      </Panel>

      {creatorOpen ? (
        <div
          className="media-creator-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCreator();
          }}
        >
          <section
            ref={creatorDialogRef}
            className="media-creator"
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-creator-title"
            aria-describedby="media-creator-description"
          >
            <header className="media-creator__header">
              <div>
                <p className="eyebrow">New context</p>
                <h2 id="media-creator-title">Add media</h2>
                <p id="media-creator-description">Choose one source. You can attach the result from Operations.</p>
              </div>
              <Button
                ref={creatorCloseRef}
                size="icon"
                variant="ghost"
                disabled={recorder.recording}
                aria-label="Close Add media"
                title={recorder.recording ? "Stop recording before closing" : "Close Add media"}
                onClick={closeCreator}
              >
                <X className="size-4" />
              </Button>
            </header>

            <div className="media-source-tabs" role="tablist" aria-label="Media source">
              <button
                id="media-tab-upload"
                type="button"
                role="tab"
                aria-selected={source === "upload"}
                aria-controls="media-panel-upload"
                data-active={source === "upload" || undefined}
                disabled={recorder.recording}
                onClick={() => selectSource("upload")}
              >
                <UploadCloud className="size-4" /> Upload file
              </button>
              <button
                id="media-tab-audio"
                type="button"
                role="tab"
                aria-selected={source === "audio"}
                aria-controls="media-panel-audio"
                data-active={source === "audio" || undefined}
                onClick={() => selectSource("audio")}
              >
                <Mic className="size-4" /> Record audio
              </button>
              <button
                id="media-tab-camera"
                type="button"
                role="tab"
                aria-selected={source === "camera"}
                aria-controls="media-panel-camera"
                data-active={source === "camera" || undefined}
                disabled={recorder.recording}
                onClick={() => selectSource("camera")}
              >
                <Camera className="size-4" /> Use camera
              </button>
            </div>

            <div className="media-creator__body">
              {source === "upload" ? (
                <div
                  id="media-panel-upload"
                  className="media-creator-panel"
                  role="tabpanel"
                  aria-labelledby="media-tab-upload"
                >
                  <label className="upload-drop">
                    <input
                      type="file"
                      className="sr-only"
                      accept="image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg"
                      onChange={(event) => {
                        setFile(event.target.files?.[0] ?? null);
                        setUploadTranscript("");
                      }}
                    />
                    <UploadCloud className="size-6 text-primary" />
                    <span className="font-display text-sm font-semibold">{file?.name ?? "Choose an image or audio file"}</span>
                    <span className="text-xs text-ink-muted">PNG, JPEG, WebP, WAV, MP3, MP4, WebM, or OGG</span>
                  </label>
                  {file?.type.startsWith("audio/") ? (
                    <Field label="Audio transcript" htmlFor="upload-transcript" hint="Optional. You can also add or generate it later.">
                      <textarea
                        id="upload-transcript"
                        rows={3}
                        value={uploadTranscript}
                        onChange={(event) => setUploadTranscript(event.target.value)}
                        placeholder="Paste or enter a transcript"
                      />
                    </Field>
                  ) : null}
                  <Button
                    className="w-full"
                    variant="primary"
                    disabled={!file}
                    busy={c.busyAction === "upload-media"}
                    onClick={() => void uploadFile()}
                  >
                    <FileUp className="size-4" /> Upload file
                  </Button>
                </div>
              ) : null}

              {source === "audio" ? (
                <div
                  id="media-panel-audio"
                  className="media-creator-panel media-capture-panel"
                  role="tabpanel"
                  aria-labelledby="media-tab-audio"
                >
                  <div className="media-capture-panel__icon" data-live={recorder.recording || undefined}>
                    <Mic className="size-7" />
                  </div>
                  <div className="media-capture-panel__copy">
                    <div className="flex items-center justify-center gap-2">
                      <h3>{recorder.recording ? "Recording…" : "Record a voice clip"}</h3>
                      {recorder.status !== "idle" ? (
                        <StatusBadge
                          tone={recorder.recording ? "danger" : recorder.status === "uploaded" ? "success" : "neutral"}
                          label={CAPTURE_STATUS_LABEL[recorder.status]}
                        />
                      ) : null}
                    </div>
                    <p>
                      {recorder.supported
                        ? "The recording uploads when you stop it."
                        : "Microphone recording is unavailable in this browser."}
                    </p>
                  </div>
                  {!recorder.recording ? (
                    <details className="media-creator-optional">
                      <summary>Add transcript (optional)</summary>
                      <Field label="Transcript" htmlFor="recording-transcript" hint="You can also generate it from the library later.">
                        <textarea
                          id="recording-transcript"
                          rows={3}
                          value={uploadTranscript}
                          onChange={(event) => setUploadTranscript(event.target.value)}
                          placeholder="Paste or enter a transcript"
                        />
                      </Field>
                    </details>
                  ) : null}
                  <Button
                    className="w-full"
                    variant={recorder.recording ? "danger" : "primary"}
                    disabled={!recorder.supported || recorder.status === "saving" || c.busyAction === "upload-recording"}
                    onClick={recorder.recording ? recorder.stop : () => void recorder.start()}
                  >
                    {recorder.recording ? <Square className="size-4" /> : <Mic className="size-4" />}
                    {recorder.recording ? "Stop recording" : "Start recording"}
                  </Button>
                </div>
              ) : null}

              {source === "camera" ? (
                <div
                  id="media-panel-camera"
                  className="media-creator-panel"
                  role="tabpanel"
                  aria-labelledby="media-tab-camera"
                >
                  {camera.active ? (
                    <>
                      <div className="media-camera-preview relative overflow-hidden rounded-lg border border-white/10 bg-black">
                        <video ref={camera.videoRef} className="size-full object-cover" playsInline muted />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button onClick={camera.close}>
                          <VideoOff className="size-4" /> Close camera
                        </Button>
                        <Button
                          variant="primary"
                          busy={c.busyAction === "capture-camera"}
                          onClick={() => void captureCamera()}
                        >
                          <Image className="size-4" /> Capture image
                        </Button>
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      compact
                      icon={VideoOff}
                      title="Camera is off"
                      description={camera.supported
                        ? "Open it only when you are ready to capture a frame."
                        : "Camera capture is unavailable in this browser."}
                      action={
                        <Button variant="primary" disabled={!camera.supported} onClick={() => void camera.open()}>
                          <Camera className="size-4" /> Open camera
                        </Button>
                      }
                    />
                  )}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
