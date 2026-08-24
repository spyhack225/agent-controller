import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HttpError, requireString } from "./http.mjs";
import { buildSignedMediaUrl } from "./mediaLinks.mjs";
import { createS3Client, isNotFound } from "./s3.mjs";

const ALLOWED_MEDIA = {
  audio: new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"]),
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
};

const MAX_MEDIA_ATTACHMENTS = 8;

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

// Media lives on local disk for development and in S3-compatible object storage for production
// (roadmap Phase 1). `storagePath` holds the object key in both cases, so the record shape and the
// Convex schema are identical either way.
let cachedS3Client = null;
let cachedS3Key = null;

function objectStoreFor(config) {
  if (config?.mediaStorageProvider !== "s3") return null;
  const key = [config.s3Endpoint, config.s3Region, config.s3Bucket, config.s3AccessKeyId].join("|");
  if (cachedS3Client && cachedS3Key === key) return cachedS3Client;
  cachedS3Client = createS3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    ...(config.s3SessionToken ? { sessionToken: config.s3SessionToken } : {}),
    ...(config.s3ForcePathStyle === undefined ? {} : { forcePathStyle: config.s3ForcePathStyle }),
    ...(config.s3TimeoutMs ? { timeoutMs: config.s3TimeoutMs } : {}),
  });
  cachedS3Key = key;
  return cachedS3Client;
}

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
  const objectStore = objectStoreFor(config);
  let storagePath;
  if (objectStore) {
    storagePath = `${actor.userId}/${sha256}.${extension}`;
    await objectStore.putObject({ key: storagePath, body: buffer, contentType });
  } else {
    storagePath = join(config.mediaDir, actor.userId, `${sha256}.${extension}`);
    await mkdir(join(config.mediaDir, actor.userId), { recursive: true });
    await writeFile(storagePath, buffer);
  }

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

export async function readStoredMedia(media, config = null) {
  const objectStore = objectStoreFor(config);
  if (objectStore) return (await objectStore.getObject({ key: media.storagePath })).body;
  return readFile(media.storagePath);
}

export async function deleteStoredMedia(media, config = null) {
  if (!media?.storagePath) return;
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    try {
      await objectStore.deleteObject({ key: media.storagePath });
    } catch (error) {
      // Mirrors `rm --force` on disk: an already-absent object is not an error.
      if (!isNotFound(error)) throw error;
    }
    return;
  }
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

  if (config.transcriptionProvider === "openai") {
    let transcript;
    try {
      transcript = await transcribeWithOpenAi(media, config);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failed = await store.updateMediaProcessing?.({
        userId,
        mediaId,
        processing: {
          transcriptionStatus: "failed",
          transcriptSource: "openai",
          lastError: failureMessage,
        },
      });
      throw new HttpError(502, "Audio transcription failed.", {
        media: failed ?? media,
        cause: failureMessage,
      });
    }
    const updated = await store.updateMediaTranscript({
      userId,
      mediaId,
      transcript,
      source: "openai",
    });
    return { media: updated, transcript, provider: "openai" };
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

async function transcribeWithOpenAi(media, config) {
  if (!config.transcriptionApiKey) {
    throw new Error("TRANSCRIPTION_API_KEY is required when TRANSCRIPTION_PROVIDER=openai.");
  }

  const endpoint = config.transcriptionUrl ?? "https://api.openai.com/v1/audio/transcriptions";
  const buffer = await readStoredMedia(media, config);
  const form = new FormData();
  form.append("model", config.transcriptionModel);
  form.append(
    "file",
    new Blob([buffer], { type: media.contentType }),
    media.originalName ?? `${media.id}.${EXTENSIONS.get(media.contentType) ?? "bin"}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.transcriptionTimeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.transcriptionApiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Transcription timed out after ${config.transcriptionTimeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Transcription provider returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const transcript = normalizeTranscript(payload?.text ?? "");
  if (!transcript) throw new Error("Transcription provider returned an empty transcript.");
  return transcript;
}

// Builds the payload T3 receives in message.attachments. Includes a signed callback URL and,
// for small files, the bytes inline so an environment that cannot reach the gateway still
// gets the content.
export async function buildMediaAttachment({ media, config, baseUrl, now = Date.now() }) {
  const attachment = {
    type: media.kind,
    mediaId: media.id,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256,
    ...(media.originalName ? { name: media.originalName } : {}),
    ...(media.kind === "audio" && media.transcript ? { transcript: media.transcript } : {}),
    // A vision description reaches the agent even when it cannot fetch or see the image itself.
    ...(media.kind === "image" && media.description ? { description: media.description } : {}),
  };

  if (config.mediaSigningKey && baseUrl) {
    const signed = buildSignedMediaUrl({
      media,
      baseUrl,
      secret: config.mediaSigningKey,
      ttlSeconds: config.mediaLinkTtlSeconds,
      now,
    });
    attachment.url = signed.url;
    attachment.urlExpiresAt = signed.expiresAt;
  }

  if (media.sizeBytes <= config.mediaInlineMaxBytes) {
    try {
      attachment.dataBase64 = (await readStoredMedia(media, config)).toString("base64");
    } catch {
      // A missing or unreadable file must not block dispatch; the signed URL still stands.
    }
  }

  return attachment;
}

// Every referenced upload must resolve for the calling user. Skipping an unknown or foreign id
// would dispatch a turn whose text talks about media the agent never received.
export async function buildMediaAttachments({ store, userId, mediaUploadIds, config, baseUrl, now }) {
  const ids = [...new Set((mediaUploadIds ?? []).filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return [];
  if (ids.length > MAX_MEDIA_ATTACHMENTS) {
    throw new HttpError(400, `A turn can carry at most ${MAX_MEDIA_ATTACHMENTS} media attachments.`);
  }

  const attachments = [];
  for (const mediaId of ids) {
    const media = await store.getMediaForUser(userId, mediaId);
    if (!media) throw new HttpError(404, "Media upload not found.");
    if (!ALLOWED_MEDIA[media.kind]) {
      throw new HttpError(415, `Unsupported media kind: ${media.kind}.`);
    }
    attachments.push(await buildMediaAttachment({ media, config, baseUrl, now }));
  }
  return attachments;
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
