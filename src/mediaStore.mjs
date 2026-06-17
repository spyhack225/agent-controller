import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HttpError, requireString } from "./http.mjs";

const ALLOWED_MEDIA = {
  audio: new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"]),
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
};

const EXTENSIONS = new Map([
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export async function storeUploadedMedia({ store, config, actor, payload }) {
  const kind = requireString(payload.kind, "kind");
  if (!["audio", "image"].includes(kind)) {
    throw new HttpError(400, "kind must be audio or image.");
  }

  const contentType = requireString(payload.contentType, "contentType").toLowerCase();
  if (!ALLOWED_MEDIA[kind].has(contentType)) {
    throw new HttpError(415, `Unsupported ${kind} content type: ${contentType}.`);
  }

  const dataBase64 = requireString(payload.dataBase64, "dataBase64");
  const buffer = decodeBase64(dataBase64);
  if (buffer.length === 0) throw new HttpError(400, "Uploaded media cannot be empty.");
  if (buffer.length > config.maxMediaBytes) {
    throw new HttpError(413, `Uploaded media exceeds ${config.maxMediaBytes} bytes.`);
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const extension = EXTENSIONS.get(contentType) ?? "bin";
  const storagePath = join(config.mediaDir, actor.userId, `${sha256}.${extension}`);
  await mkdir(join(config.mediaDir, actor.userId), { recursive: true });
  await writeFile(storagePath, buffer);

  const privacy = await store.getUserPrivacySettings?.(actor.userId);
  const retentionDays = privacy?.mediaRetentionDays ?? config.defaultMediaRetentionDays ?? 30;
  const expiresAt = retentionDays === null
    ? null
    : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  return await store.createMediaUpload({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    kind,
    contentType,
    sizeBytes: buffer.length,
    sha256,
    storagePath,
    originalName: typeof payload.originalName === "string" ? payload.originalName : undefined,
    transcript: kind === "audio" && typeof payload.transcript === "string"
      ? normalizeTranscript(payload.transcript)
      : undefined,
    expiresAt,
  });
}

export async function readStoredMedia(media) {
  return readFile(media.storagePath);
}

export async function deleteStoredMedia(media) {
  if (!media?.storagePath) return;
  await rm(media.storagePath, { force: true });
}

export async function transcribeStoredAudio({ store, config, userId, mediaId }) {
  const media = await store.getMediaForUser(userId, mediaId);
  if (!media) throw new HttpError(404, "Media upload not found.");
  if (media.kind !== "audio") throw new HttpError(400, "Only audio media can be transcribed.");

  await store.updateMediaProcessing?.({
    userId,
    mediaId,
    processing: {
      transcriptionStatus: "processing",
      transcriptSource: config.transcriptionProvider,
      lastError: null,
    },
  });

  if (config.transcriptionProvider === "mock") {
    const transcript = buildMockTranscript(media);
    const updated = await store.updateMediaTranscript({
      userId,
      mediaId,
      transcript,
      source: "mock",
    });
    return { media: updated, transcript, provider: "mock" };
  }

  const message = "No transcription provider is configured.";
  const updated = await store.updateMediaProcessing?.({
    userId,
    mediaId,
    processing: {
      transcriptionStatus: "unavailable",
      transcriptSource: null,
      lastError: message,
    },
  });
  throw new HttpError(409, message, { media: updated ?? media });
}

export function mediaToPromptContext(media) {
  return [
    "Media attachment:",
    `id=${media.id}`,
    `kind=${media.kind}`,
    `contentType=${media.contentType}`,
    `sizeBytes=${media.sizeBytes}`,
    `sha256=${media.sha256}`,
  ].join(" ");
}

function buildMockTranscript(media) {
  const name = media.originalName ? ` ${media.originalName}` : "";
  return `Mock transcript for audio${name} (${media.contentType}, ${media.sizeBytes} bytes, sha256 ${media.sha256.slice(0, 12)}).`;
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new HttpError(400, "dataBase64 must be valid base64.");
  }
}

function normalizeTranscript(value) {
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}
