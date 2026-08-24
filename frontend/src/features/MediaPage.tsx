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

import { mediaJobActivity } from "../activity";
import type { Controller } from "../controller";
import {
  formatMediaExpiry,
  formatMediaJob,
  formatMediaProcessing,
  mediaJobTone,
} from "../format";
import { ActivityOrb } from "../motion";
import type { MediaItem, MediaJob } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Panel,
  StatusBadge,
  useConfirm,
} from "../ui";
import { MediaCaptureDialog, mediaLabel } from "./MediaCapture";

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

  // The gateway answers 202 with a job: the transcription itself runs on its worker, survives a
  // restart, and reports back over the event stream.
  const transcribe = async (item: MediaItem) => {
    await c.run(`transcribe-${item.id}`, "Transcription queued.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}/transcribe`, {
        method: "POST",
        body: {},
      });
      await c.refreshMedia();
      return result;
    });
  };

  // Accepting or correcting a transcript records a new version; the raw ASR output is untouched.
  const submitReview = async (item: MediaItem, job: MediaJob) => {
    const transcript = transcriptDrafts[item.id]?.trim();
    if (!transcript) {
      c.setNotice({ tone: "danger", message: "Enter a transcript before approving." });
      return;
    }
    await c.run(`review-${job.id}`, "Transcript approved.", async () => {
      const result = await c.api(`/v1/media/jobs/${encodeURIComponent(job.id)}/transcript`, {
        method: "POST",
        body: { transcript },
      });
      await c.refreshMedia();
      return result;
    });
  };

  // The newest job wins: re-transcribing an old clip should not be described by the first attempt.
  const latestJobFor = (mediaId: string): MediaJob | null => c.mediaJobs
    .filter((job) => job.mediaId === mediaId)
    .reduce<MediaJob | null>(
      (latest, job) => (!latest || (job.createdAt ?? "") >= (latest.createdAt ?? "") ? job : latest),
      null,
    );

  const deleteMedia = async (item: MediaItem) => {
    const accepted = await confirm({
      title: `Delete ${mediaLabel(item)}?`,
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
            {c.media.map((item) => {
              const job = latestJobFor(item.id);
              return (
              <article key={item.id} className="grid gap-4 p-4 lg:grid-cols-[auto_minmax(180px,0.55fr)_minmax(260px,1fr)_auto] lg:items-center">
                <div className="grid size-10 place-items-center rounded-lg border border-control bg-surface-inset text-primary">
                  {item.kind === "audio" ? <FileAudio className="size-5" /> : <FileImage className="size-5" />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{mediaLabel(item)}</p>
                    <StatusBadge
                      tone={item.processing?.lastError ? "danger" : item.processing?.transcriptionStatus === "processing" ? "warning" : "success"}
                      label={formatMediaProcessing(item)}
                    />
                    {job ? <StatusBadge tone={mediaJobTone(job)} label={formatMediaJob(job)} /> : null}
                    <ActivityOrb activity={job ? mediaJobActivity(job.stage) : null} />
                  </div>
                  {/*
                    The derived name is the heading; what the client actually uploaded is still
                    here, next to the id, because it is the record of the file and a name that is
                    derived must never be mistaken for the one that was given.
                  */}
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
                    {item.originalName ? `${item.originalName} · ${item.id}` : item.id}
                  </p>
                  {/*
                    No relative time here any more: the derived name already carries the moment the
                    capture was taken, and "24 Aug 19:32" plus "16m ago" is one fact printed twice.
                    What is left is what the name cannot say — the container and how big it is.
                  */}
                  <p className="mt-1 text-xs text-ink-muted">
                    {item.contentType} · {item.sizeBytes ?? 0} B
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {formatMediaExpiry(item.expiresAt)}
                  </p>
                </div>
                <div>
                  {item.kind === "audio" ? (
                    <>
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
                      {/*
                        Cleanup may only move spacing, punctuation and case. When it moved letters
                        instead, nothing is applied — the speaker sees both versions and picks.
                      */}
                      {job?.transcriptChange?.contentPreserved === false ? (
                        <div className="mt-2 rounded-lg border border-control bg-surface-inset p-2 text-xs">
                          <p className="font-semibold text-ink">Cleanup changed the wording</p>
                          <p className="mt-1 text-ink-muted">
                            Heard: <span className="font-mono">{job.rawTranscript}</span>
                          </p>
                          <p className="mt-1 text-ink-muted">
                            Cleaned: <span className="font-mono">{job.normalizedTranscript}</span>
                          </p>
                          <p className="mt-1 text-ink-muted">
                            Nothing was applied. Approve the version you meant.
                          </p>
                        </div>
                      ) : null}
                    </>
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
                      {job?.stage === "review_required" ? (
                        <Button size="sm" variant="primary" onClick={() => void submitReview(item, job)}>
                          <Save className="size-3.5" /> Approve transcript
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteMedia(item)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              </article>
              );
            })}
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
