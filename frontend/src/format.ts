import type { Command, JsonRecord, MediaItem, MediaJob } from "./types";

/**
 * A timestamp relative to now, in either direction.
 *
 * The clamp this used to carry (`Math.max(0, now - timestamp)`) silently assumed every timestamp
 * was in the past, so anything in the future collapsed to "0s ago": a clip uploaded a minute ago
 * under a 30-day retention read "Expires 0s ago", and a credential good for another three months
 * read as already gone. Deadlines are as common as ages in this UI — media expiry, token expiry —
 * so the direction is part of the answer, not an assumption.
 */
export function formatRelativeTime(value?: string | null): string {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const deltaMs = timestamp - Date.now();
  const amount = formatDuration(Math.abs(deltaMs));
  return deltaMs > 0 ? `in ${amount}` : `${amount} ago`;
}

/** Coarsest unit that still reads as a number: seconds, then minutes, hours, days. */
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatUptime(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  const seconds = Math.floor(Number(value) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatMetric(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  return `${Number(value)} ${unit}`;
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

export function commandSummary(command: Command): string {
  const intent = command.intent ?? {};
  const candidates = [intent.command, intent.text, intent.prompt, intent.transcript];
  const summary = candidates.find((candidate) => typeof candidate === "string");
  if (typeof summary === "string" && summary.trim()) return summary;
  if (typeof command.result === "string") return command.result;
  if (command.result && typeof command.result === "object") {
    const result = command.result as JsonRecord;
    const detail = [result.response, result.reason, result.message]
      .find((candidate) => typeof candidate === "string");
    if (typeof detail === "string") return detail;
  }
  return "No command detail";
}

export function commandType(command: Command): string {
  const type = command.intent?.type;
  return typeof type === "string" ? type.replaceAll("_", " ") : "command";
}

export function renderEventResult(result: unknown): string {
  if (!result) return "No result";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const record = result as JsonRecord;
    const detail = [record.response, record.reason, record.message, record.output]
      .find((candidate) => typeof candidate === "string");
    if (typeof detail === "string" && detail.trim()) return detail;
    if (isT3DispatchReceipt(record)) return "Sent to T3 Code";
    if (typeof record.status === "string") return record.status;
  }
  return "Result received";
}

function isT3DispatchReceipt(record: JsonRecord): boolean {
  const isSequenceReceipt = (value: unknown) => Boolean(
    value
    && typeof value === "object"
    && typeof (value as JsonRecord).sequence === "number",
  );
  return isSequenceReceipt(record)
    || isSequenceReceipt(record.createThread)
    || isSequenceReceipt(record.startTurn);
}

/**
 * Retention, said the way a person would read it.
 *
 * Split from the raw relative time so the tense matches the fact: a clip with time left "expires
 * in 29d", one past its retention "expired 2d ago", and one the owner has to delete by hand never
 * expires at all. Rendering all three through a single "Expires …" prefix produced the nonsense
 * this screen used to show.
 */
export function formatMediaExpiry(expiresAt?: string | null): string {
  if (!expiresAt) return "Expires only when manually deleted";
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return `Expires ${expiresAt}`;
  return timestamp > Date.now()
    ? `Expires ${formatRelativeTime(expiresAt)}`
    : `Expired ${formatRelativeTime(expiresAt)}`;
}

export function formatMediaProcessing(media: MediaItem): string {
  const parts = [media.processing?.transcriptionStatus ?? "ready"];
  if (media.processing?.transcriptSource) parts.push(`via ${media.processing.transcriptSource}`);
  if (media.processing?.lastError) parts.push(media.processing.lastError);
  return parts.join(" · ");
}

const MEDIA_JOB_STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  normalizing: "Cleaning up",
  review_required: "Needs review",
  ready: "Ready to apply",
  dispatching: "Applying",
  dispatched: "Applied",
  failed: "Failed",
};

/**
 * The job's own progress, which is finer than the media record's coarse processing status: a
 * transcript can be finished and still be waiting on a person.
 */
export function formatMediaJob(job: MediaJob): string {
  const parts = [MEDIA_JOB_STAGE_LABELS[job.stage] ?? job.stage];
  if (job.provider) parts.push(`via ${job.provider}`);
  if ((job.attempts ?? 0) > 1) parts.push(`attempt ${job.attempts}/${job.maxAttempts ?? job.attempts}`);
  if (job.lastError) parts.push(job.lastError);
  return parts.join(" · ");
}

/**
 * Why a failed job failed, said so an owner knows whether to act or to let it go.
 *
 * "Failed" on its own sent people to the logs for both halves of the same word: a clip that failed
 * because TRANSCRIPTION_PROVIDER was unset is one setting away from working, and a clip in a
 * container nothing decodes is not. The label states which, and whether retrying is worth anything.
 */
const MEDIA_JOB_FAILURE_CAUSE_LABELS: Record<string, string> = {
  configuration: "Gateway configuration — fix the deployment, then retry",
  input: "This recording — retrying will not change the answer",
  provider: "The transcription provider — worth trying again later",
  unknown: "Unclassified failure",
};

export function mediaJobFailureLabel(job: MediaJob): string | null {
  if (job.stage !== "failed") return null;
  return MEDIA_JOB_FAILURE_CAUSE_LABELS[job.failureCause ?? "unknown"] ?? MEDIA_JOB_FAILURE_CAUSE_LABELS.unknown;
}

/**
 * Whether the explicit retry path applies to this job.
 *
 * Only a configuration failure. Offering the button on anything else would spend an inference to
 * reproduce the same refusal, and the gateway refuses it anyway.
 */
export function mediaJobRetryable(job: MediaJob): boolean {
  return job.stage === "failed" && job.failureCause === "configuration";
}

export function mediaJobTone(job: MediaJob): "danger" | "warning" | "success" {
  if (job.stage === "failed") return "danger";
  if (job.stage === "dispatched") return "success";
  return "warning";
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to capture camera frame."));
    }, type);
  });
}
