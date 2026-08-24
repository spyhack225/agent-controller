import { HttpError } from "./http.mjs";
import { MAX_MEDIA_ATTACHMENTS, assertSupportedMediaKind, mediaToPromptContext } from "./mediaStore.mjs";

// An intent carries an ordered list of uploads. protocol-v1 firmware and saved media actions send
// a single `mediaUploadId`, so the scalar stays an accepted alias for a one-element list.
export function normalizeMediaUploadIds(payload) {
  const raw = payload?.mediaUploadIds;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new HttpError(400, "mediaUploadIds must be an array of media ids.");
  }
  const candidates = [...(Array.isArray(raw) ? raw : []), payload?.mediaUploadId];
  const ids = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      throw new HttpError(400, "mediaUploadId must be a non-empty string.");
    }
    const id = candidate.trim();
    // Order is the attachment order the agent sees, so a repeat keeps its first position.
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_MEDIA_ATTACHMENTS) {
    throw new HttpError(400, `A turn can carry at most ${MAX_MEDIA_ATTACHMENTS} media attachments.`);
  }
  return ids;
}

export async function normalizeMediaIntent(intent, context = {}) {
  const uploads = await resolveMedia(intent.mediaUploadIds, context);
  const primary = uploads[0] ?? null;
  const attached = uploads.length > 0 ? { mediaUploadIds: uploads.map((media) => media.id) } : {};

  if (intent.type === "audio_prompt") {
    const transcript = typeof intent.transcript === "string" && intent.transcript.trim()
      ? intent.transcript.trim()
      : joinTranscripts(uploads);
    if (typeof transcript === "string" && transcript.trim()) {
      return {
        type: "agent_prompt",
        text: withMediaContext(transcript.trim(), uploads),
        source: "device-audio",
        ...attached,
      };
    }
    return {
      type: "media_prompt",
      text: withMediaContext(
        intent.prompt ?? "Audio received. Transcription provider is not configured yet.",
        uploads,
      ),
      media: primary
        ? { kind: primary.kind, mediaUploadId: primary.id, contentType: primary.contentType }
        : { kind: "audio", status: "stored" },
      ...attached,
      source: "device-audio",
    };
  }

  if (intent.type === "camera_prompt") {
    const text = typeof intent.prompt === "string" && intent.prompt.trim()
      ? intent.prompt.trim()
      : "Analyze the attached camera snapshot and report what matters for the current coding task.";
    return {
      type: "media_prompt",
      text: withMediaContext(text, uploads),
      media: primary
        ? { kind: primary.kind, mediaUploadId: primary.id, contentType: primary.contentType }
        : { kind: "image", status: "stored" },
      ...attached,
      source: "device-camera",
    };
  }

  return intent;
}

// Every referenced upload is checked, not just the first: a foreign or unsupported id anywhere in
// the list must fail the whole turn rather than be silently dropped from the attachment set.
async function resolveMedia(mediaUploadIds, context) {
  const uploads = [];
  for (const mediaUploadId of mediaUploadIds ?? []) {
    const media = await context.store?.getMediaForUser(context.userId, mediaUploadId);
    if (!media) throw new HttpError(404, "Media upload not found.");
    assertSupportedMediaKind(media.kind);
    uploads.push(media);
  }
  return uploads;
}

function joinTranscripts(uploads) {
  const transcripts = uploads
    .map((media) => (typeof media.transcript === "string" ? media.transcript.trim() : ""))
    .filter((transcript) => transcript.length > 0);
  return transcripts.length > 0 ? transcripts.join("\n\n") : undefined;
}

function withMediaContext(text, uploads) {
  if (uploads.length === 0) return text;
  return [text, ...uploads.map((media) => mediaToPromptContext(media))].join("\n\n");
}
