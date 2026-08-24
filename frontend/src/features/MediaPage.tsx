import {
  FileAudio,
  FileImage,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UploadCloud,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Controller } from "../controller";
import {
  formatMediaProcessing,
  formatRelativeTime,
} from "../format";
import type { MediaItem } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Panel,
  StatusBadge,
  useConfirm,
} from "../ui";
import { MediaCaptureDialog } from "./MediaCapture";

export function MediaPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});
  const [creatorOpen, setCreatorOpen] = useState(false);
  const creatorTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTranscriptDrafts((current) => {
      const next = { ...current };
      for (const item of c.media) {
        if (!(item.id in next)) next[item.id] = item.transcript ?? "";
      }
      return next;
    });
  }, [c.media]);

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
        <MediaCaptureDialog controller={c} onClose={() => setCreatorOpen(false)} />
      ) : null}
    </div>
  );
}
