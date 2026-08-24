import { readStoredMedia } from "./mediaStore.mjs";

// Speech-to-text lives behind an interface so the job runner never branches on provider names.
// A provider answers `transcribe()` with the raw ASR text plus whatever metadata it knows
// (model, language, how long the call took) and throws a TranscriptionError otherwise.
//
// The `retryable` flag on that error is the whole point of the split: a 429 or a socket reset is
// worth another attempt on the next tick, while a missing API key or an unconfigured provider will
// fail identically forever and must reach a terminal state instead of burning the retry budget.

const EXTENSIONS = new Map([
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
]);

const MAX_TRANSCRIPT_CHARS = 12000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export class TranscriptionError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = "TranscriptionError";
    this.retryable = retryable === true;
    this.status = status;
  }
}

/**
 * Every provider name the gateway understands.
 *
 * Kept next to the adapters rather than in config.mjs so that adding one is a single edit: the
 * config whitelist and the "is anything configured?" check in app.mjs both read this list, and a
 * name missing from either of those degrades silently to `disabled`.
 */
export const TRANSCRIPTION_PROVIDERS = ["disabled", "mock", "openai", "parakeet"];

/** True for a provider that will actually attempt work, which is what gates enqueueing a job. */
export function isTranscriptionProviderEnabled(name) {
  return TRANSCRIPTION_PROVIDERS.includes(name) && name !== "disabled";
}

export function createTranscriptionProvider(config = {}) {
  const name = config.transcriptionProvider ?? "disabled";
  if (name === "mock") return mockProvider(config);
  if (name === "openai") return openAiProvider(config);
  if (name === "parakeet") return parakeetProvider(config);
  return disabledProvider(name);
}

function disabledProvider(name) {
  return {
    name: name === "disabled" ? "disabled" : name,
    model: null,
    available: false,
    async transcribe() {
      throw new TranscriptionError("No transcription provider is configured.", { retryable: false });
    },
  };
}

function mockProvider(config) {
  return {
    name: "mock",
    model: config.transcriptionModel ?? "mock",
    available: true,
    async transcribe({ media }) {
      return {
        text: buildMockTranscript(media),
        provider: "mock",
        model: config.transcriptionModel ?? "mock",
        language: config.transcriptionLanguage ?? "en",
        durationMs: 0,
      };
    },
  };
}

function openAiProvider(config) {
  return {
    name: "openai",
    model: config.transcriptionModel ?? "whisper-1",
    available: Boolean(config.transcriptionApiKey),
    async transcribe({ media }) {
      if (!config.transcriptionApiKey) {
        // Nothing about this improves by trying again.
        throw new TranscriptionError(
          "TRANSCRIPTION_API_KEY is required when TRANSCRIPTION_PROVIDER=openai.",
          { retryable: false },
        );
      }

      const endpoint = config.transcriptionUrl ?? "https://api.openai.com/v1/audio/transcriptions";
      let buffer;
      try {
        buffer = await readStoredMedia(media, config);
      } catch (error) {
        // The bytes may be on an object store having a bad minute; that is worth another attempt.
        throw new TranscriptionError(`Stored audio could not be read: ${message(error)}`, { retryable: true });
      }

      const form = new FormData();
      form.append("model", config.transcriptionModel ?? "whisper-1");
      if (config.transcriptionLanguage) form.append("language", config.transcriptionLanguage);
      form.append(
        "file",
        new Blob([buffer], { type: media.contentType }),
        media.originalName ?? `${media.id}.${EXTENSIONS.get(media.contentType) ?? "bin"}`,
      );

      const controller = new AbortController();
      const timeoutMs = config.transcriptionTimeoutMs ?? 30_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
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
          throw new TranscriptionError(`Transcription timed out after ${timeoutMs}ms.`, { retryable: true });
        }
        throw new TranscriptionError(`Transcription request failed: ${message(error)}`, { retryable: true });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new TranscriptionError(`Transcription provider returned HTTP ${response.status}.`, {
          retryable: RETRYABLE_STATUSES.has(response.status),
          status: response.status,
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new TranscriptionError(`Transcription provider returned invalid JSON: ${message(error)}`, {
          retryable: true,
        });
      }

      const text = typeof payload?.text === "string" ? payload.text : "";
      if (text.trim().length === 0) {
        throw new TranscriptionError("Transcription provider returned an empty transcript.", {
          retryable: false,
        });
      }

      return {
        text: text.slice(0, MAX_TRANSCRIPT_CHARS),
        provider: "openai",
        model: payload?.model ?? config.transcriptionModel ?? "whisper-1",
        language: payload?.language ?? config.transcriptionLanguage ?? null,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

// --- Parakeet -------------------------------------------------------------------------------
//
// nvidia/parakeet-tdt-0.6b-v2 running as a small local ASR sidecar.
//
// The gateway never imports Python and never blocks its event loop on inference: it POSTs the clip
// to the sidecar over HTTP and waits on a socket exactly like the hosted providers above. CPU
// inference is the supported default and a GPU is only an accelerator — which is why the timeout
// defaults to minutes rather than seconds, and why concurrency is 1 until an operator says the box
// can take more.

export const PARAKEET_DEFAULT_URL = "http://127.0.0.1:8977/v1/transcribe";
export const PARAKEET_DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v2";
export const PARAKEET_DEFAULT_TIMEOUT_MS = 120_000;
export const PARAKEET_DEFAULT_MAX_CLIP_SECONDS = 120;
export const PARAKEET_DEFAULT_CONCURRENCY = 1;

/**
 * Containers the sidecar is expected to decode.
 *
 * Browser capture arrives as WebM/Opus (Chrome, Firefox) or MP4/AAC (Safari); a controller uploads
 * 16 kHz mono WAV, which needs no decoding at all. Anything else is refused here, with the list in
 * the message, instead of being posted and coming back as an opaque 4xx from a Python traceback.
 * PARAKEET_ACCEPTED_CONTENT_TYPES narrows or widens it to match the sidecar's actual decoder.
 */
export const PARAKEET_ACCEPTED_CONTENT_TYPES = ["audio/wav", "audio/webm", "audio/ogg", "audio/mp4"];

/**
 * Parakeet checkpoints known to be English-only.
 *
 * v2 is an English model. Pointing it at French does not produce French — it produces confident
 * English-shaped nonsense, which is worse than a refusal because it dispatches as if the user had
 * said it. A language the configured model cannot speak is therefore a configuration error and is
 * reported as one. Checkpoints not on this list are not asserted about: the language is passed
 * through and the sidecar decides.
 */
const PARAKEET_ENGLISH_ONLY_MODELS = new Set([
  "nvidia/parakeet-tdt-0.6b-v2",
  "nvidia/parakeet-tdt-1.1b",
  "nvidia/parakeet-rnnt-0.6b",
  "nvidia/parakeet-rnnt-1.1b",
  "nvidia/parakeet-ctc-0.6b",
  "nvidia/parakeet-ctc-1.1b",
]);
const PARAKEET_MULTILINGUAL_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

/** The adapter's whole configuration surface, resolved once so tests can assert on it directly. */
export function parakeetSettings(config = {}) {
  const accepted = Array.isArray(config.parakeetAcceptedContentTypes)
    && config.parakeetAcceptedContentTypes.length > 0
    ? config.parakeetAcceptedContentTypes.map((value) => String(value).trim().toLowerCase())
    : PARAKEET_ACCEPTED_CONTENT_TYPES;
  return {
    url: config.parakeetUrl ?? PARAKEET_DEFAULT_URL,
    model: config.parakeetModel ?? PARAKEET_DEFAULT_MODEL,
    apiKey: config.parakeetApiKey ?? null,
    timeoutMs: config.parakeetTimeoutMs ?? PARAKEET_DEFAULT_TIMEOUT_MS,
    maxClipSeconds: config.parakeetMaxClipSeconds ?? PARAKEET_DEFAULT_MAX_CLIP_SECONDS,
    language: normalizeLanguageTag(config.parakeetLanguage) ?? "en",
    concurrency: normalizeConcurrency(config.parakeetConcurrency),
    acceptedContentTypes: accepted,
  };
}

function parakeetProvider(config) {
  const settings = parakeetSettings(config);
  // One gate per provider instance, which is one per worker. The sidecar holds a single model in
  // memory; oversubscribing it makes every clip slower without finishing any of them sooner.
  const gate = createConcurrencyGate(settings.concurrency);

  return {
    name: "parakeet",
    model: settings.model,
    // No credential to be missing: an unreachable sidecar is a runtime condition, not a config one.
    available: true,
    settings,
    accepts: [...settings.acceptedContentTypes],
    async transcribe({ media }) {
      // Both checks are about configuration, so they run before a byte is read and fail terminally:
      // no number of retries turns an English model into a French one.
      assertParakeetLanguage(settings);
      assertParakeetContainer(media, settings);

      let buffer;
      try {
        buffer = await readStoredMedia(media, config);
      } catch (error) {
        // The bytes may be on an object store having a bad minute; that is worth another attempt.
        throw new TranscriptionError(`Stored audio could not be read: ${message(error)}`, { retryable: true });
      }

      // A WAV header is the one case where the gateway can measure the clip itself. Refusing an
      // over-long one costs a header read, where the sidecar would first decode the whole thing.
      const wav = media.contentType === "audio/wav" ? readWavFormat(buffer) : null;
      if (wav && wav.durationSeconds > settings.maxClipSeconds) {
        throw new TranscriptionError(
          `Audio clip is ${wav.durationSeconds.toFixed(1)}s, over the ${settings.maxClipSeconds}s`
          + " limit for the parakeet sidecar. Raise PARAKEET_MAX_CLIP_SECONDS or split the recording.",
          { retryable: false },
        );
      }

      const queuedAt = Date.now();
      return await gate(async () => callParakeet({
        media,
        buffer,
        wav,
        settings,
        gateWaitMs: Date.now() - queuedAt,
      }));
    },
  };
}

async function callParakeet({ media, buffer, wav, settings, gateWaitMs }) {
  const form = new FormData();
  form.append("model", settings.model);
  // Sent explicitly rather than left to detection: see PARAKEET_ENGLISH_ONLY_MODELS.
  form.append("language", settings.language);
  // The sidecar enforces this too, for the containers whose length the gateway cannot read.
  form.append("max_clip_seconds", String(settings.maxClipSeconds));
  if (wav) {
    // The sidecar resamples to the 16 kHz mono the model wants. Telling it what the header already
    // says saves a probe, and makes a controller clip (16 kHz mono PCM) a straight pass-through.
    form.append("sample_rate", String(wav.sampleRate));
    form.append("channels", String(wav.channels));
  }
  form.append("file", new Blob([buffer], { type: media.contentType }), parakeetFilename(media));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(settings.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TranscriptionError(
        `Parakeet sidecar did not answer within ${settings.timeoutMs}ms. CPU inference on a long clip`
        + " can exceed this; raise PARAKEET_TIMEOUT_MS or lower PARAKEET_MAX_CLIP_SECONDS.",
        { retryable: true },
      );
    }
    // A sidecar that is down looks exactly like one that is restarting, so this retries.
    throw new TranscriptionError(
      `Parakeet sidecar at ${settings.url} is unreachable: ${message(error)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timeout);
  }

  const requestMs = Date.now() - startedAt;
  const { payload, raw } = await readSidecarBody(response);

  if (!response.ok) {
    const detail = sidecarDetail(payload) ?? (raw ? raw.slice(0, 200) : null);
    throw new TranscriptionError(
      `Parakeet sidecar returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
      { retryable: RETRYABLE_STATUSES.has(response.status), status: response.status },
    );
  }
  if (!payload) {
    throw new TranscriptionError("Parakeet sidecar returned a body that is not JSON.", { retryable: true });
  }

  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.trim().length === 0) {
    // Silence, or a clip the model made nothing of. The same bytes produce the same silence.
    throw new TranscriptionError("Parakeet sidecar returned an empty transcript.", { retryable: false });
  }

  const audioSeconds = firstNumber(payload.durationSeconds, payload.duration_seconds)
    ?? (wav ? wav.durationSeconds : null);
  const decodeMs = firstNumber(
    payload.timings?.decodeMs,
    payload.timings?.decode_ms,
    payload.decodeMs,
    payload.decode_ms,
  );
  const inferenceMs = firstNumber(
    payload.timings?.inferenceMs,
    payload.timings?.inference_ms,
    payload.inferenceMs,
    payload.inference_ms,
  );

  return {
    text: text.slice(0, MAX_TRANSCRIPT_CHARS),
    provider: "parakeet",
    model: typeof payload.model === "string" ? payload.model : settings.model,
    language: typeof payload.language === "string" ? payload.language : settings.language,
    durationMs: requestMs,
    timings: {
      gateWaitMs,
      requestMs,
      ...(decodeMs === null ? {} : { decodeMs }),
      ...(inferenceMs === null ? {} : { inferenceMs }),
      ...(audioSeconds === null ? {} : { audioSeconds }),
      // Seconds of compute per second of audio. Above 1.0 the box cannot keep up with speech in
      // real time, which is the number that decides whether a GPU is worth adding.
      ...(inferenceMs !== null && audioSeconds ? { realtimeFactor: inferenceMs / (audioSeconds * 1000) } : {}),
    },
  };
}

function assertParakeetLanguage(settings) {
  if (!PARAKEET_ENGLISH_ONLY_MODELS.has(settings.model)) return;
  if (settings.language === "en") return;
  throw new TranscriptionError(
    `${settings.model} transcribes English only, but the configured language is "${settings.language}".`
    + ` Set PARAKEET_MODEL to a multilingual checkpoint (for example ${PARAKEET_MULTILINGUAL_MODEL})`
    + " rather than expecting an English model to cope.",
    { retryable: false },
  );
}

function assertParakeetContainer(media, settings) {
  const contentType = String(media?.contentType ?? "").trim().toLowerCase();
  if (settings.acceptedContentTypes.includes(contentType)) return;
  throw new TranscriptionError(
    `The parakeet sidecar does not accept ${contentType || "an unknown content type"}.`
    + ` Accepted: ${settings.acceptedContentTypes.join(", ")}.`,
    { retryable: false },
  );
}

function parakeetFilename(media) {
  return media.originalName ?? `${media.id}.${EXTENSIONS.get(media.contentType) ?? "bin"}`;
}

async function readSidecarBody(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return { payload: null, raw: "" };
  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    // A proxy's HTML error page is still worth quoting back; it is just not a payload.
    return { payload: null, raw };
  }
}

function sidecarDetail(payload) {
  for (const key of ["error", "detail", "message"]) {
    if (typeof payload?.[key] === "string" && payload[key].trim()) return payload[key].trim().slice(0, 200);
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeLanguageTag(value) {
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase().split(/[-_]/u)[0];
  return /^[a-z]{2,3}$/u.test(tag) ? tag : null;
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 16) : PARAKEET_DEFAULT_CONCURRENCY;
}

/**
 * Caps how many inference requests are in flight at once.
 *
 * A released slot is handed straight to the next waiter rather than decremented and re-acquired,
 * because the gap between those two would let a fresh caller overtake the queue and briefly exceed
 * the limit — which on a CPU box is the difference between one slow clip and two stalled ones.
 */
export function createConcurrencyGate(limit) {
  const max = Math.max(1, limit || 1);
  const waiting = [];
  let active = 0;

  return async function run(task) {
    if (active < max) {
      active += 1;
    } else {
      await new Promise((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Reads the format and length of a RIFF/WAVE clip without decoding it.
 *
 * Just enough parser to answer "how long is this, at what rate", which is all the adapter needs to
 * refuse an over-long clip before paying for inference. Returns null for anything that is not a
 * plain RIFF/WAVE — a compressed container's length is the sidecar's problem, not the gateway's.
 */
export function readWavFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // A streamed WAV can declare a zero-length data chunk; the bytes present are the truth.
      dataBytes = size > 0 ? Math.min(size, buffer.length - body) : buffer.length - body;
      break;
    }
    // RIFF chunks are word-aligned, so an odd size carries a pad byte.
    offset = body + size + (size % 2);
  }

  if (!format || dataBytes === null) return null;
  const byteRate = format.byteRate > 0
    ? format.byteRate
    : format.sampleRate * format.channels * Math.ceil(format.bitsPerSample / 8);
  if (!(byteRate > 0)) return null;
  return { ...format, dataBytes, durationSeconds: dataBytes / byteRate };
}

/**
 * What normalisation did to the transcript, reported as evidence rather than asserted.
 *
 * Parakeet already emits punctuation and capitalisation, so the cleanup below is only ever allowed
 * to move spacing, punctuation and case. `contentPreserved` checks exactly that, by comparing the
 * letters and digits with everything else stripped out. If those moved, something rewrote what the
 * user said, and it has to be shown to them as a diff rather than dispatched as their command.
 */
export function describeTranscriptChange(rawTranscript, normalizedTranscript) {
  if (typeof rawTranscript !== "string" || typeof normalizedTranscript !== "string") return null;
  const rawSignature = transcriptSignature(rawTranscript);
  const normalizedSignature = transcriptSignature(normalizedTranscript);
  const contentPreserved = rawSignature === normalizedSignature;
  return {
    changed: rawTranscript.trim() !== normalizedTranscript.trim(),
    contentPreserved,
    rawLength: rawTranscript.length,
    normalizedLength: normalizedTranscript.length,
    firstDivergenceIndex: contentPreserved ? null : firstDivergence(rawSignature, normalizedSignature),
  };
}

function transcriptSignature(value) {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}

function firstDivergence(left, right) {
  const shortest = Math.min(left.length, right.length);
  for (let index = 0; index < shortest; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return shortest;
}

/**
 * The `normalizing` stage's actual work: punctuation and whitespace cleanup.
 *
 * Deliberately conservative — it never rewrites words, only spacing, sentence casing and a
 * terminal stop, so the normalized version stays diffable against the raw one.
 */
export function normalizeTranscriptText(value) {
  if (typeof value !== "string") return null;
  let text = value.replaceAll(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  text = text.replaceAll(/\s+([,.;:!?])/gu, "$1");
  // Only split before a letter, never a digit: "3,000" and "10:30" are not missing spaces.
  text = text.replaceAll(/([,;:])(?=\p{L})/gu, "$1 ");
  // And only before a capital, so "clip.webm" or "v1.2" survives a sentence-boundary rule that
  // exists for "done.Next" — a filename mangled into "clip. webm" is worse than a missing space.
  text = text.replaceAll(/([.!?])(?=\p{Lu})/gu, "$1 ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?…]$/u.test(text)) text = `${text}.`;
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}

export function buildMockTranscript(media) {
  const name = media.originalName ? ` ${media.originalName}` : "";
  return `Mock transcript for audio${name} (${media.contentType}, ${media.sizeBytes} bytes, sha256 ${media.sha256.slice(0, 12)}).`;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
