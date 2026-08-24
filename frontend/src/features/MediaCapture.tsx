/**
 * Media creation surfaces shared by the Media library and the Operate composer.
 *
 * `MediaCaptureDialog` owns the three ways to make a new upload (file, microphone, camera); the
 * capture mechanics themselves stay in `useAudioRecorder`/`useCameraCapture` so there is exactly
 * one implementation of permission handling and teardown. `MediaPicker` is the read-only list of
 * existing uploads, used by the composer to attach something already stored.
 */

import {
  Camera,
  FileAudio,
  FileImage,
  FileUp,
  Image,
  Mic,
  Square,
  UploadCloud,
  VideoOff,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { recordingActivity } from "../activity";
import type { Controller } from "../controller";
import { fileToBase64 } from "../format";
import { CAPTURE_STATUS_LABEL, useAudioRecorder, useCameraCapture } from "../mediaCapture";
import { ActivityOrb } from "../motion";
import type { MediaItem } from "../types";
import { Button, EmptyState, Field, StatusBadge } from "../ui";

export type MediaSource = "upload" | "audio" | "camera";

export const MEDIA_FILE_ACCEPT =
  "image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg";

/** Only images and audio can become agent context, whatever the OS lets the user drop. */
export function isAttachableFile(file: { type?: string }): boolean {
  const type = file.type ?? "";
  return type.startsWith("image/") || type.startsWith("audio/");
}

export function mediaLabel(item: MediaItem): string {
  return item.originalName ?? item.id;
}

export function mediaState(item: MediaItem): string {
  const processing = item.processing ?? {};
  const status = item.kind === "image"
    ? processing.visionStatus ?? (item.description ? "described" : "stored")
    : processing.transcriptionStatus ?? (item.transcript ? "transcribed" : "stored");
  return status === "not_applicable" ? "stored" : status;
}

export function MediaPicker({
  media,
  onSelect,
  emptyMessage = "No stored media yet.",
  label = "Media library",
}: {
  media: MediaItem[];
  onSelect: (item: MediaItem) => void;
  emptyMessage?: string;
  label?: string;
}) {
  if (media.length === 0) {
    return <p className="media-picker__empty">{emptyMessage}</p>;
  }
  return (
    <ul className="media-picker" aria-label={label}>
      {media.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-label={`Attach ${mediaLabel(item)}`}
            onClick={() => onSelect(item)}
          >
            {item.kind === "audio" ? <FileAudio className="size-4" /> : <FileImage className="size-4" />}
            <span className="media-picker__name">{mediaLabel(item)}</span>
            <small>{item.kind} · {mediaState(item)}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface MediaCaptureDialogProps {
  controller: Controller;
  /** Render this component only while the dialog is open — unmounting is what releases devices. */
  onClose: () => void;
  initialSource?: MediaSource;
  /** Called after every successful upload, with the stored record. */
  onUploaded?: (media: MediaItem) => void;
  title?: string;
  description?: string;
}

export function MediaCaptureDialog({
  controller: c,
  onClose,
  initialSource = "upload",
  onUploaded,
  title = "Add media",
  description = "Choose one source. You can attach the result from Operations.",
}: MediaCaptureDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [source, setSource] = useState<MediaSource>(initialSource);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const notifyError = (message: string) => c.setNotice({ tone: "danger", message });

  const store = async (payload: Record<string, unknown>) => {
    const media = await c.uploadMedia(payload);
    onUploaded?.(media);
    return media;
  };

  const uploadFile = async () => {
    if (!file) {
      c.setNotice({ tone: "danger", message: "Choose an image or audio file first." });
      return;
    }
    await c.run("upload-media", "Media uploaded.", async () => {
      const kind = file.type.startsWith("audio/") ? "audio" : "image";
      const result = await store({
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

  const recorder = useAudioRecorder({
    onError: notifyError,
    onComplete: async (blob, contentType) => {
      await c.run("upload-recording", "Recording uploaded.", async () => store({
        kind: "audio",
        contentType,
        dataBase64: await fileToBase64(blob),
        transcript: uploadTranscript.trim() || undefined,
        originalName: `recording-${new Date().toISOString()}.webm`,
      }));
    },
  });

  const camera = useCameraCapture({ onError: notifyError });

  const requestClose = () => {
    if (recorder.recording) {
      c.setNotice({ tone: "info", message: `Stop the recording before closing ${title}.` });
      return;
    }
    camera.close();
    onClose();
  };

  const selectSource = (next: MediaSource) => {
    if (recorder.recording) return;
    if (source === "camera" && next !== "camera") camera.close();
    setSource(next);
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
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
  }, []);

  const captureCamera = async () => {
    const blob = await camera.capture().catch((error: unknown) => {
      notifyError(error instanceof Error ? error.message : "Camera capture failed.");
      return null;
    });
    if (!blob) return;
    await c.run("capture-camera", "Camera frame uploaded.", async () => {
      camera.setStatus("saving");
      const result = await store({
        kind: "image",
        contentType: "image/png",
        dataBase64: await fileToBase64(blob),
        originalName: `snapshot-${new Date().toISOString()}.png`,
      });
      camera.setStatus("uploaded");
      return result;
    });
  };

  return (
    <div
      className="media-creator-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="media-creator"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-creator-title"
        aria-describedby="media-creator-description"
      >
        <header className="media-creator__header">
          <div>
            <p className="eyebrow">New context</p>
            <h2 id="media-creator-title">{title}</h2>
            <p id="media-creator-description">{description}</p>
          </div>
          <Button
            ref={closeRef}
            size="icon"
            variant="ghost"
            disabled={recorder.recording}
            aria-label={`Close ${title}`}
            title={recorder.recording ? "Stop recording before closing" : `Close ${title}`}
            onClick={requestClose}
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
                  accept={MEDIA_FILE_ACCEPT}
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
                {recorder.recording
                  ? <ActivityOrb activity={recordingActivity(true)} size={64} />
                  : <Mic className="size-7" aria-hidden="true" />}
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
  );
}
