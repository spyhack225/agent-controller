import { HttpError } from "./http.mjs";
import { mediaToPromptContext } from "./mediaStore.mjs";

export async function normalizeMediaIntent(intent, context = {}) {
  const media = await resolveMedia(intent.mediaUploadId, context);
  if (intent.type === "audio_prompt") {
    const transcript = typeof intent.transcript === "string" && intent.transcript.trim()
      ? intent.transcript.trim()
      : media?.transcript;
    if (typeof transcript === "string" && transcript.trim()) {
      return {
        type: "agent_prompt",
        text: withMediaContext(transcript.trim(), media),
        source: "device-audio",
        ...(media ? { mediaUploadId: media.id } : {}),
      };
    }
    return {
      type: "media_prompt",
      text: withMediaContext(
        intent.prompt ?? "Audio received. Transcription provider is not configured yet.",
        media,
      ),
      media: media
        ? { kind: media.kind, mediaUploadId: media.id, contentType: media.contentType }
        : { kind: "audio", status: "stored" },
      ...(media ? { mediaUploadId: media.id } : {}),
      source: "device-audio",
    };
  }

  if (intent.type === "camera_prompt") {
    const text = typeof intent.prompt === "string" && intent.prompt.trim()
      ? intent.prompt.trim()
      : "Analyze the attached camera snapshot and report what matters for the current coding task.";
    return {
      type: "media_prompt",
      text: withMediaContext(text, media),
      media: media
        ? { kind: media.kind, mediaUploadId: media.id, contentType: media.contentType }
        : { kind: "image", status: "stored" },
      ...(media ? { mediaUploadId: media.id } : {}),
      source: "device-camera",
    };
  }

  return intent;
}

async function resolveMedia(mediaUploadId, context) {
  if (mediaUploadId === undefined) return null;
  if (typeof mediaUploadId !== "string" || mediaUploadId.trim().length === 0) {
    throw new HttpError(400, "mediaUploadId must be a non-empty string.");
  }
  const media = await context.store?.getMediaForUser(context.userId, mediaUploadId.trim());
  if (!media) throw new HttpError(404, "Media upload not found.");
  return media;
}

function withMediaContext(text, media) {
  if (!media) return text;
  return `${text}\n\n${mediaToPromptContext(media)}`;
}
