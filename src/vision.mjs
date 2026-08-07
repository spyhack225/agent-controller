// OCR / vision step of the camera flow (roadmap Phase 6):
//   device/phone -> VPS image upload -> OCR/vision/attachment -> prompt -> dispatch
//
// Mirrors `transcribeStoredAudio` in mediaStore.mjs: a provider chosen by config, a `mock`
// provider for tests and local dev, processing-state updates around the call, and failures
// mapped to HttpError so the route handler needs no special casing.

import { HttpError } from "./http.mjs";
import { readStoredMedia } from "./mediaStore.mjs";

export const VISION_PROVIDERS = ["disabled", "mock", "openai"];

const DEFAULT_VISION_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_VISION_MODEL = "gpt-4o-mini";
const DEFAULT_VISION_MAX_TOKENS = 600;
const DEFAULT_VISION_PROMPT =
  "Describe this image for an engineer who cannot see it. "
  + "Transcribe every piece of visible text verbatim, then summarise what the image shows.";

const MAX_DESCRIPTION_CHARS = 12000;

export async function describeStoredImage({ store, config, userId, mediaId }) {
  const media = await store.getMediaForUser(userId, mediaId);
  if (!media) throw new HttpError(404, "Media upload not found.");
  if (media.kind !== "image") throw new HttpError(400, "Only image media can be described.");

  const provider = normalizeProvider(config.visionProvider);

  await store.updateMediaProcessing?.({
    userId,
    mediaId,
    processing: {
      visionStatus: "processing",
      descriptionSource: provider,
      lastError: null,
    },
  });

  if (provider === "mock") {
    const description = buildMockDescription(media);
    const updated = await store.updateMediaDescription?.({
      userId,
      mediaId,
      description,
      source: "mock",
    });
    return { media: updated ?? presentMedia(media, description, "mock"), description, provider: "mock" };
  }

  if (provider === "openai") {
    let description;
    try {
      description = await describeWithOpenAi(media, config);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failed = await store.updateMediaProcessing?.({
        userId,
        mediaId,
        processing: {
          visionStatus: "failed",
          descriptionSource: "openai",
          lastError: failureMessage,
        },
      });
      throw new HttpError(502, "Image description failed.", {
        media: failed ?? presentMedia(media),
        cause: failureMessage,
      });
    }
    const updated = await store.updateMediaDescription?.({
      userId,
      mediaId,
      description,
      source: "openai",
    });
    return {
      media: updated ?? presentMedia(media, description, "openai"),
      description,
      provider: "openai",
    };
  }

  const message = "No vision provider is configured.";
  const updated = await store.updateMediaProcessing?.({
    userId,
    mediaId,
    processing: {
      visionStatus: "unavailable",
      descriptionSource: null,
      lastError: message,
    },
  });
  throw new HttpError(409, message, { media: updated ?? presentMedia(media) });
}

async function describeWithOpenAi(media, config) {
  if (!config.visionApiKey) {
    throw new Error("VISION_API_KEY is required when VISION_PROVIDER=openai.");
  }

  const endpoint = config.visionUrl ?? DEFAULT_VISION_URL;
  const timeoutMs = config.visionTimeoutMs ?? 30_000;
  const buffer = await readStoredMedia(media, config);
  const body = buildVisionRequest({
    media,
    dataBase64: buffer.toString("base64"),
    model: config.visionModel ?? DEFAULT_VISION_MODEL,
    prompt: config.visionPrompt ?? DEFAULT_VISION_PROMPT,
    maxTokens: config.visionMaxTokens ?? DEFAULT_VISION_MAX_TOKENS,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.visionApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Image description timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Vision provider returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const description = extractVisionDescription(payload);
  if (!description) throw new Error("Vision provider returned an empty description.");
  return description;
}

// Pure: builds the OpenAI-compatible chat/completions body with the image inlined as a data
// URL. Kept free of I/O so the payload shape can be asserted without a network stub.
export function buildVisionRequest({
  media,
  dataBase64,
  model = DEFAULT_VISION_MODEL,
  prompt = DEFAULT_VISION_PROMPT,
  maxTokens = DEFAULT_VISION_MAX_TOKENS,
}) {
  if (!media?.contentType) throw new Error("media.contentType is required to build a vision request.");
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    throw new Error("dataBase64 is required to build a vision request.");
  }

  return {
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${media.contentType};base64,${dataBase64}` } },
        ],
      },
    ],
  };
}

// Pure: pulls the assistant text out of a chat/completions response. Content may be a plain
// string or the multi-part array form, so both are handled.
export function extractVisionDescription(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return normalizeDescription(content);
  if (Array.isArray(content)) {
    const text = content
      .map((part) => String(typeof part === "string" ? part : (part?.text ?? "")).trim())
      .filter(Boolean)
      .join("\n");
    return normalizeDescription(text);
  }
  return undefined;
}

// Counterpart of mediaToPromptContext: turns a description into the one-line context string
// that gets prepended to the prompt before dispatch.
export function visionToPromptContext(media, description = media?.description) {
  const text = normalizeDescription(description ?? "");
  if (!text) return "";
  return [
    "Image description:",
    `id=${media.id}`,
    `contentType=${media.contentType}`,
    ...(media.originalName ? [`name=${media.originalName}`] : []),
    "--",
    text,
  ].join(" ");
}

function buildMockDescription(media) {
  const name = media.originalName ? ` ${media.originalName}` : "";
  return `Mock description for image${name} (${media.contentType}, ${media.sizeBytes} bytes, sha256 ${media.sha256.slice(0, 12)}).`;
}

function normalizeProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VISION_PROVIDERS.includes(provider) ? provider : "disabled";
}

function normalizeDescription(value) {
  const description = String(value ?? "").trim();
  return description.length > 0 ? description.slice(0, MAX_DESCRIPTION_CHARS) : undefined;
}

// Fallback for stores that cannot yet persist a description. Never leaks storagePath, which
// the store's own publicMediaUpload() strips.
function presentMedia(media, description = undefined, source = null) {
  const { storagePath, ...publicFields } = media;
  if (description === undefined) return publicFields;
  return {
    ...publicFields,
    description,
    processing: {
      ...(publicFields.processing ?? {}),
      visionStatus: "ready",
      descriptionSource: source,
    },
  };
}
