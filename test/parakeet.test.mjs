import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMediaJobRunner } from "../src/mediaJobs.mjs";
import { createMemoryStore } from "../src/store.mjs";
import {
  PARAKEET_ACCEPTED_CONTENT_TYPES,
  createConcurrencyGate,
  createTranscriptionProvider,
  describeTranscriptChange,
  normalizeTranscriptText,
  parakeetSettings,
  readWavFormat,
} from "../src/transcription.mjs";

const USER_ID = "user_dev";
const SIDECAR_URL = "http://127.0.0.1:8977/v1/transcribe";

/**
 * A real RIFF/WAVE clip of `seconds` of 16 kHz mono PCM — the exact shape a controller uploads.
 *
 * The adapter reads this header to refuse an over-long clip before paying for inference, so the
 * tests need genuine bytes rather than a stub that claims a duration.
 */
function wavClip(seconds, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataBytes = Math.round(byteRate * seconds);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/** Writes a clip to a temp directory and returns the media record pointing at it. */
async function seedAudio(t, {
  store = createMemoryStore(),
  contentType = "audio/wav",
  originalName = "clip.wav",
  bytes = wavClip(2),
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "parakeet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, originalName);
  await writeFile(storagePath, bytes);

  store.ensureUser({ userId: USER_ID });
  const media = store.createMediaUpload({
    userId: USER_ID,
    deviceId: null,
    kind: "audio",
    contentType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storagePath,
    originalName,
  });
  return { store, media: { ...media, storagePath }, storagePath, bytes };
}

/** Replaces globalThis.fetch for the duration of one test and records what the adapter sent. */
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return await handler({ url: String(url), init, call: requests.length });
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parakeetConfig(overrides = {}) {
  return { transcriptionProvider: "parakeet", parakeetUrl: SIDECAR_URL, ...overrides };
}

test("a clip is posted to the sidecar with the model, language and clip ceiling declared", async (t) => {
  const { store, media } = await seedAudio(t);
  const requests = stubFetch(t, () => jsonResponse({
    text: "Deploy the staging branch.",
    model: "nvidia/parakeet-tdt-0.6b-v2",
    language: "en",
    durationSeconds: 2,
    timings: { decodeMs: 12, inferenceMs: 480 },
  }));

  const config = parakeetConfig({ parakeetMaxClipSeconds: 90 });
  const provider = createTranscriptionProvider(config);
  const result = await provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, SIDECAR_URL);
  assert.equal(requests[0].init.method, "POST");
  // No credential is sent unless the sidecar is behind an authenticated hop.
  assert.equal(requests[0].init.headers.authorization, undefined);

  const form = requests[0].init.body;
  assert.equal(form.get("model"), "nvidia/parakeet-tdt-0.6b-v2");
  assert.equal(form.get("language"), "en", "the language is declared, never left to detection.");
  assert.equal(form.get("max_clip_seconds"), "90");
  // A controller clip is already 16 kHz mono; saying so lets the sidecar skip the resample probe.
  assert.equal(form.get("sample_rate"), "16000");
  assert.equal(form.get("channels"), "1");
  const file = form.get("file");
  assert.equal(file.name, "clip.wav");
  assert.equal(file.type, "audio/wav");
  assert.equal(file.size, 44 + 64000);

  assert.equal(result.provider, "parakeet");
  assert.equal(result.text, "Deploy the staging branch.");
  assert.equal(result.model, "nvidia/parakeet-tdt-0.6b-v2");
  assert.equal(result.language, "en");
  assert.equal(result.timings.decodeMs, 12);
  assert.equal(result.timings.inferenceMs, 480);
  assert.equal(result.timings.audioSeconds, 2);
  // 480ms of compute for 2s of audio: a quarter of real time, so this box keeps up.
  assert.equal(result.timings.realtimeFactor, 0.24);
  assert.equal(typeof result.timings.gateWaitMs, "number");
});

test("a Python sidecar's snake_case timings are read as readily as camelCase", async (t) => {
  const { store, media } = await seedAudio(t, { contentType: "audio/webm", originalName: "voice.webm" });
  stubFetch(t, () => jsonResponse({ text: "Ship it.", decode_ms: 31, inference_ms: 900, duration_seconds: 3 }));

  const config = parakeetConfig({ parakeetApiKey: "sidecar-secret" });
  const provider = createTranscriptionProvider(config);
  const result = await provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config });

  assert.equal(result.timings.decodeMs, 31);
  assert.equal(result.timings.inferenceMs, 900);
  assert.equal(result.timings.audioSeconds, 3);
  // A WebM clip's length is the sidecar's to report; the gateway cannot read it from the header.
  assert.equal(result.text, "Ship it.");
});

test("the sidecar credential is only sent when one is configured", async (t) => {
  const { store, media } = await seedAudio(t);
  const requests = stubFetch(t, () => jsonResponse({ text: "Done." }));

  const config = parakeetConfig({ parakeetApiKey: "sidecar-secret" });
  const provider = createTranscriptionProvider(config);
  await provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config });

  assert.equal(requests[0].init.headers.authorization, "Bearer sidecar-secret");
});

test("an unsupported container is refused before the sidecar is ever called", async (t) => {
  const { store, media } = await seedAudio(t, {
    contentType: "audio/mpeg",
    originalName: "voice.mp3",
    bytes: Buffer.from("not really an mp3"),
  });
  const requests = stubFetch(t, () => jsonResponse({ text: "should never happen" }));

  const config = parakeetConfig();
  const provider = createTranscriptionProvider(config);

  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.name, "TranscriptionError");
      assert.equal(error.retryable, false, "a container the decoder cannot open never improves on retry.");
      assert.match(error.message, /does not accept audio\/mpeg/u);
      // The message names the whole accepted set, so the fix does not need the source.
      for (const accepted of PARAKEET_ACCEPTED_CONTENT_TYPES) assert.match(error.message, new RegExp(accepted, "u"));
      return true;
    },
  );
  assert.equal(requests.length, 0, "an unsupported clip must not become an opaque 4xx from the sidecar.");

  // An operator whose sidecar does decode MP3 says so, and the same clip goes through.
  const widened = parakeetConfig({ parakeetAcceptedContentTypes: ["audio/wav", "audio/mpeg"] });
  const widenedProvider = createTranscriptionProvider(widened);
  const result = await widenedProvider.transcribe({
    media: store.getMediaForUser(USER_ID, media.id),
    config: widened,
  });
  assert.equal(result.text, "should never happen");
  assert.equal(requests.length, 1);
});

test("a clip over the ceiling is refused from its own header, before inference", async (t) => {
  const { store, media } = await seedAudio(t, { bytes: wavClip(200) });
  const requests = stubFetch(t, () => jsonResponse({ text: "should never happen" }));

  const config = parakeetConfig({ parakeetMaxClipSeconds: 120 });
  const provider = createTranscriptionProvider(config);

  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /Audio clip is 200\.0s, over the 120s limit/u);
      return true;
    },
  );
  assert.equal(requests.length, 0);
});

test("an English-only checkpoint refuses a language it cannot speak", async (t) => {
  const { store, media } = await seedAudio(t);
  const requests = stubFetch(t, () => jsonResponse({ text: "should never happen" }));

  const config = parakeetConfig({ parakeetLanguage: "fr" });
  const provider = createTranscriptionProvider(config);

  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, false, "a model does not learn French on the second attempt.");
      assert.match(error.message, /nvidia\/parakeet-tdt-0\.6b-v2 transcribes English only/u);
      // The fix is a different checkpoint, and the message says which kind.
      assert.match(error.message, /PARAKEET_MODEL/u);
      assert.match(error.message, /parakeet-tdt-0\.6b-v3/u);
      return true;
    },
  );
  assert.equal(requests.length, 0, "poor English is worse than a refusal, so nothing is sent.");

  // A checkpoint the gateway holds no opinion about passes the language straight through.
  const multilingual = parakeetConfig({ parakeetLanguage: "fr", parakeetModel: "nvidia/parakeet-tdt-0.6b-v3" });
  const provider2 = createTranscriptionProvider(multilingual);
  await provider2.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config: multilingual });
  assert.equal(requests[0].init.body.get("language"), "fr");
  assert.equal(requests[0].init.body.get("model"), "nvidia/parakeet-tdt-0.6b-v3");
});

test("a hung sidecar aborts on the configured timeout and stays retryable", async (t) => {
  const { store, media } = await seedAudio(t);
  stubFetch(t, ({ init }) => new Promise((resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      reject(error);
    });
  }));

  const config = parakeetConfig({ parakeetTimeoutMs: 40 });
  const provider = createTranscriptionProvider(config);

  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, true, "a slow box is worth another tick; a wrong one is not.");
      assert.match(error.message, /did not answer within 40ms/u);
      assert.match(error.message, /PARAKEET_TIMEOUT_MS/u);
      return true;
    },
  );
});

test("a sidecar that is not listening is retryable, since a restart looks identical", async (t) => {
  const { store, media } = await seedAudio(t);
  stubFetch(t, () => { throw new TypeError("fetch failed"); });

  const config = parakeetConfig();
  const provider = createTranscriptionProvider(config);

  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /is unreachable/u);
      assert.match(error.message, /127\.0\.0\.1:8977/u);
      return true;
    },
  );
});

test("a 503 is retryable, a 422 is not, and both quote the sidecar's own message", async (t) => {
  const { store, media } = await seedAudio(t);
  const config = parakeetConfig();
  const provider = createTranscriptionProvider(config);

  stubFetch(t, () => jsonResponse({ detail: "model is still loading" }, { status: 503 }));
  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Parakeet sidecar returned HTTP 503: model is still loading");
      return true;
    },
  );

  globalThis.fetch = async () => jsonResponse({ error: "clip has no decodable audio stream" }, { status: 422 });
  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.retryable, false, "the same bytes decode the same way every time.");
      assert.match(error.message, /clip has no decodable audio stream/u);
      return true;
    },
  );

  // A proxy's HTML error page is still quoted back rather than swallowed.
  globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /HTTP 502: <html>502 Bad Gateway<\/html>/u);
      return true;
    },
  );

  // Silence is not an outage: retrying the same clip produces the same nothing.
  globalThis.fetch = async () => jsonResponse({ text: "   " });
  await assert.rejects(
    () => provider.transcribe({ media: store.getMediaForUser(USER_ID, media.id), config }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /empty transcript/u);
      return true;
    },
  );
});

test("concurrency caps how many clips are inside the sidecar at once", async (t) => {
  const { store, media } = await seedAudio(t);
  let inFlight = 0;
  let peak = 0;
  stubFetch(t, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return jsonResponse({ text: "Concurrent enough." });
  });

  const config = parakeetConfig({ parakeetConcurrency: 2 });
  const provider = createTranscriptionProvider(config);
  assert.equal(provider.settings.concurrency, 2);

  const record = store.getMediaForUser(USER_ID, media.id);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => provider.transcribe({ media: record, config })),
  );

  assert.equal(results.length, 6);
  assert.equal(peak, 2, "one model in memory serves as many clips at once as the operator allows.");
  // The clips that waited say so, which is what makes a saturated sidecar visible in the timings.
  assert.ok(results.some((result) => result.timings.gateWaitMs > 0));
});

test("the gate hands a released slot straight to the next waiter", async () => {
  const gate = createConcurrencyGate(1);
  let inFlight = 0;
  let peak = 0;
  const task = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return true;
  };

  await Promise.all(Array.from({ length: 5 }, () => gate(task)));
  assert.equal(peak, 1);

  // A throwing task must release its slot, or the gate deadlocks on the next call.
  await assert.rejects(() => gate(async () => { throw new Error("boom"); }), /boom/u);
  assert.equal(await gate(async () => "still open"), "still open");
});

test("readWavFormat measures a clip without decoding it, and declines anything else", () => {
  const clip = readWavFormat(wavClip(1.5, { sampleRate: 44100, channels: 2 }));
  assert.equal(clip.sampleRate, 44100);
  assert.equal(clip.channels, 2);
  assert.equal(clip.bitsPerSample, 16);
  assert.ok(Math.abs(clip.durationSeconds - 1.5) < 0.001);

  assert.equal(readWavFormat(Buffer.from("not a wav at all")), null);
  assert.equal(readWavFormat(Buffer.alloc(0)), null);
  assert.equal(readWavFormat("a string"), null);
});

test("normalising a parakeet transcript is cleanup only, and any rewrite is reported", () => {
  // Parakeet already punctuates and capitalises, so the cleanup has almost nothing to do.
  const raw = "  Deploy the staging branch, then run the smoke tests.  ";
  const normalized = normalizeTranscriptText(raw);
  assert.equal(normalized, "Deploy the staging branch, then run the smoke tests.");

  const change = describeTranscriptChange(raw, normalized);
  assert.equal(change.changed, false, "trimming alone is not a change to what was said.");
  assert.equal(change.contentPreserved, true);
  assert.equal(change.firstDivergenceIndex, null);

  // Spacing and case may move freely; the letters may not.
  assert.equal(describeTranscriptChange("done.Next up", "Done. Next up.").contentPreserved, true);
  const rewritten = describeTranscriptChange("deploy the staging branch", "Deploy the stating branch.");
  assert.equal(rewritten.contentPreserved, false);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.firstDivergenceIndex, 12, "'staging' became 'stating' at the twelfth letter.");
});

test("a failed transcription leaves the audio intact and the job retryable", async (t) => {
  const store = createMemoryStore();
  const { media, storagePath, bytes } = await seedAudio(t, { store, bytes: wavClip(3) });
  const config = parakeetConfig({ parakeetMaxClipSeconds: 120 });

  stubFetch(t, ({ call }) => (call === 1
    ? jsonResponse({ detail: "worker is restarting" }, { status: 503 })
    : jsonResponse({
      text: "  Deploy the staging branch.  ",
      language: "en",
      duration_seconds: 3,
      timings: { decode_ms: 18, inference_ms: 1100 },
    })));

  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "parakeet" });
  const runner = createMediaJobRunner({ store, config, logger: { warn: () => {} } });
  assert.equal(runner.provider.name, "parakeet");

  await runner.runOnce();

  let job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "queued", "a sidecar hiccup returns the job to the queue, not to failure.");
  assert.equal(job.attempts, 1);
  assert.equal(job.failureKind, "retryable");
  assert.match(job.lastError, /HTTP 503: worker is restarting/u);
  assert.equal(job.leaseOwner, null, "a failed attempt must release its lease for the next tick.");
  assert.equal(job.rawTranscript, null);

  // The clip itself is untouched: a transcript is derived, the upload is the source.
  assert.deepEqual(await readFile(storagePath), bytes);
  const record = store.getMediaForUser(USER_ID, media.id);
  assert.equal(record.storagePath, storagePath);
  assert.equal(record.transcript, null);
  assert.equal(store.listMediaUploads(USER_ID)[0].processing.transcriptionStatus, "processing");

  await runner.runOnce();

  job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "dispatched");
  assert.equal(job.attempts, 2, "the earlier attempt is kept; the retry is not a fresh job.");
  assert.equal(job.lastError, null);
  assert.equal(job.provider, "parakeet");
  assert.equal(job.language, "en");
  assert.equal(job.rawTranscript, "  Deploy the staging branch.  ", "the ASR output is kept verbatim.");
  assert.equal(job.normalizedTranscript, "Deploy the staging branch.");
  assert.equal(store.listMediaUploads(USER_ID)[0].transcript, "Deploy the staging branch.");
  assert.deepEqual(await readFile(storagePath), bytes, "the audio survives transcription unchanged.");
});

test("the job records queue wait, decode, inference, normalisation and total", async (t) => {
  const store = createMemoryStore();
  const { media } = await seedAudio(t, { store, bytes: wavClip(3) });
  const config = parakeetConfig();

  stubFetch(t, () => jsonResponse({
    text: "Restart the worker.",
    duration_seconds: 3,
    timings: { decodeMs: 21, inferenceMs: 1500 },
  }));

  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "parakeet" });
  await createMediaJobRunner({ store, config }).runOnce();

  const { timings } = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(timings.decodeMs, 21);
  assert.equal(timings.inferenceMs, 1500);
  assert.equal(timings.audioSeconds, 3);
  assert.equal(timings.realtimeFactor, 0.5);
  assert.equal(typeof timings.queueWaitMs, "number");
  assert.equal(typeof timings.gateWaitMs, "number");
  assert.equal(typeof timings.providerMs, "number");
  assert.equal(typeof timings.normalizeMs, "number");
  assert.equal(typeof timings.totalMs, "number");
  assert.ok(timings.totalMs >= timings.queueWaitMs, "total spans the queue wait it contains.");
  assert.ok(timings.queuedAt && timings.transcribedAt && timings.normalizedAt && timings.dispatchedAt);
});

test("parakeet is a first-class provider name, not an overloaded openai branch", () => {
  const provider = createTranscriptionProvider({ transcriptionProvider: "parakeet" });
  assert.equal(provider.name, "parakeet");
  assert.equal(provider.model, "nvidia/parakeet-tdt-0.6b-v2");
  assert.deepEqual(provider.accepts, PARAKEET_ACCEPTED_CONTENT_TYPES);

  // Defaults: a local sidecar on CPU, one clip at a time, minutes of patience.
  const settings = parakeetSettings({});
  assert.equal(settings.url, SIDECAR_URL);
  assert.equal(settings.concurrency, 1);
  assert.equal(settings.timeoutMs, 120_000);
  assert.equal(settings.maxClipSeconds, 120);
  assert.equal(settings.language, "en");

  // A regional tag names the same language; the model is chosen by language, not by locale.
  assert.equal(parakeetSettings({ parakeetLanguage: "en-GB" }).language, "en");
  assert.equal(parakeetSettings({ parakeetLanguage: "nonsense" }).language, "en");
});
