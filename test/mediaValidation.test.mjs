import assert from "node:assert/strict";
import test from "node:test";

import { validateMediaBytes } from "../src/mediaValidation.mjs";
import { createStore } from "../src/store.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("media validation rejects declared MIME mismatches without reflecting private metadata", () => {
  assert.throws(
    () => validateMediaBytes(Buffer.from("not an image"), { kind: "image", contentType: "image/png" }),
    (error) => error.status === 422
      && error.code === "media_content_mismatch"
      && error.message === "Uploaded media content failed validation.",
  );
});

test("image dimensions and decoded pixel count are bounded before decode", () => {
  const bomb = Buffer.from(PNG);
  bomb.writeUInt32BE(50_000, 16);
  bomb.writeUInt32BE(50_000, 20);
  assert.throws(
    () => validateMediaBytes(bomb, {
      kind: "image", contentType: "image/png", config: { maxImageDimension: 8192, maxImagePixels: 40_000_000 },
    }),
    (error) => error.code === "media_image_limits_exceeded",
  );
});

test("parsable WAV limits reject long, high-rate or multi-channel clips", () => {
  const wav = waveHeader({ channels: 6, sampleRate: 192_000, seconds: 1 });
  assert.throws(
    () => validateMediaBytes(wav, {
      kind: "audio", contentType: "audio/wav",
      config: { maxAudioChannels: 2, maxAudioSampleRate: 96_000, maxAudioDurationSeconds: 300 },
    }),
    (error) => error.code === "media_audio_limits_exceeded",
  );
  const long = waveHeader({ channels: 1, sampleRate: 8_000, seconds: 301 });
  assert.throws(
    () => validateMediaBytes(long, { kind: "audio", contentType: "audio/wav" }),
    (error) => error.code === "media_audio_limits_exceeded",
  );
});

test("owner quota counts committed media and unfinished reservations without double counting", () => {
  const store = createStore();
  store.createMediaUpload({
    userId: "user_quota", kind: "image", contentType: "image/png", sizeBytes: 60,
    sha256: "a".repeat(64), storagePath: "/private/a.png",
  });
  const common = {
    userId: "user_quota", deviceId: null, kind: "image", contentType: "image/png",
    expectedSizeBytes: 30, expectedSha256: "b".repeat(64), storagePath: "/private/b.png",
    expiresAt: "2099-01-01T00:00:00.000Z", ownerByteLimit: 100,
  };
  assert.equal(store.createMediaUploadSession({ ...common, clientRequestId: "web:quota-one" }).created, true);
  assert.equal(store.createMediaUploadSession({
    ...common, expectedSizeBytes: 11, clientRequestId: "web:quota-two",
  }).byteLimitExceeded, true);
});

function waveHeader({ channels, sampleRate, seconds }) {
  const bytesPerSample = 2;
  const dataBytes = channels * sampleRate * bytesPerSample * seconds;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(channels * sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}
