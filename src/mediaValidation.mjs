import { HttpError } from "./http.mjs";

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Validate the bytes, not the caller-controlled Content-Type. Parsers below only inspect bounded
 * buffers admitted by MAX_MEDIA_BYTES and never invoke a decompressor or codec. */
export function validateMediaBytes(buffer, { kind, contentType, config = {} } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw mediaError("media_content_invalid");
  const detected = kind === "image" ? inspectImage(buffer) : kind === "audio" ? inspectAudio(buffer) : null;
  if (!detected || detected.contentType !== contentType) throw mediaError("media_content_mismatch");
  if (kind === "image") {
    const maxDimension = positive(config.maxImageDimension, 8192);
    const maxPixels = positive(config.maxImagePixels, 40_000_000);
    if (!detected.width || !detected.height
      || detected.width > maxDimension || detected.height > maxDimension
      || detected.width * detected.height > maxPixels) {
      throw mediaError("media_image_limits_exceeded");
    }
  } else {
    const maxDuration = positive(config.maxAudioDurationSeconds, 300);
    const maxRate = positive(config.maxAudioSampleRate, 96_000);
    const maxChannels = positive(config.maxAudioChannels, 2);
    if ((detected.durationSeconds !== null && detected.durationSeconds > maxDuration)
      || (detected.sampleRate !== null && detected.sampleRate > maxRate)
      || (detected.channels !== null && detected.channels > maxChannels)) {
      throw mediaError("media_audio_limits_exceeded");
    }
  }
  return detected;
}

function inspectImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { contentType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (JPEG_SOF.has(marker) && length >= 7) {
        return { contentType: "image/jpeg", height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
    return null;
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { contentType: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { contentType: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function inspectAudio(buffer) {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12; let fmt = null; let dataBytes = null;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (size > buffer.length - start) break;
      if (id === "fmt " && size >= 16) fmt = { channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8) };
      if (id === "data") dataBytes = size;
      offset = start + size + (size % 2);
    }
    if (!fmt) return null;
    return { contentType: "audio/wav", channels: fmt.channels, sampleRate: fmt.sampleRate,
      durationSeconds: dataBytes !== null && fmt.byteRate > 0 ? dataBytes / fmt.byteRate : null };
  }
  const mp3 = inspectMp3(buffer);
  if (mp3) return mp3;
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return { contentType: "audio/mp4", channels: null, sampleRate: null, durationSeconds: inspectMp4Duration(buffer) };
  }
  if (buffer.length >= 27 && buffer.toString("ascii", 0, 4) === "OggS") {
    return inspectOgg(buffer);
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { contentType: "audio/webm", channels: null, sampleRate: null, durationSeconds: null };
  }
  return null;
}

function inspectMp3(buffer) {
  let offset = buffer.toString("ascii", 0, 3) === "ID3" && buffer.length >= 10
    ? 10 + ((buffer[6] & 0x7f) << 21) + ((buffer[7] & 0x7f) << 14) + ((buffer[8] & 0x7f) << 7) + (buffer[9] & 0x7f)
    : 0;
  const end = Math.min(buffer.length - 4, offset + 64 * 1024);
  for (; offset <= end; offset += 1) {
    const header = buffer.readUInt32BE(offset);
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000) continue;
    const version = (header >>> 19) & 3; const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15; const rateIndex = (header >>> 10) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    const rates = version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    const ratesKbps = version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const bitrate = ratesKbps[bitrateIndex] * 1000;
    return { contentType: "audio/mpeg", channels: ((header >>> 6) & 3) === 3 ? 1 : 2,
      sampleRate: rates[rateIndex], durationSeconds: bitrate > 0 ? ((buffer.length - offset) * 8) / bitrate : null };
  }
  return null;
}

function inspectMp4Duration(buffer) {
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset); const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > buffer.length) break;
    if (type === "moov") {
      for (let child = offset + 8; child + 8 <= offset + size;) {
        const childSize = buffer.readUInt32BE(child); const childType = buffer.toString("ascii", child + 4, child + 8);
        if (childSize < 8 || child + childSize > offset + size) break;
        if (childType === "mvhd" && childSize >= 28) {
          const version = buffer[child + 8]; const base = child + (version === 1 ? 28 : 20);
          if (base + (version === 1 ? 12 : 8) <= child + childSize) {
            const scale = buffer.readUInt32BE(base); const duration = version === 1 ? Number(buffer.readBigUInt64BE(base + 4)) : buffer.readUInt32BE(base + 4);
            return scale > 0 ? duration / scale : null;
          }
        }
        child += childSize;
      }
    }
    offset += size;
  }
  return null;
}

function inspectOgg(buffer) {
  const packetStart = 27 + buffer[26];
  let channels = null; let sampleRate = null;
  if (packetStart + 19 <= buffer.length && buffer.subarray(packetStart, packetStart + 8).equals(Buffer.from("4f70757348656164", "hex"))) {
    channels = buffer[packetStart + 9]; sampleRate = 48_000;
  } else if (packetStart + 16 <= buffer.length && buffer[packetStart] === 1 && buffer.toString("ascii", packetStart + 1, packetStart + 7) === "vorbis") {
    channels = buffer[packetStart + 11]; sampleRate = buffer.readUInt32LE(packetStart + 12);
  }
  let lastGranule = null;
  for (let offset = 0; offset + 27 <= buffer.length;) {
    if (buffer.toString("ascii", offset, offset + 4) !== "OggS") break;
    lastGranule = Number(buffer.readBigUInt64LE(offset + 6));
    const segments = buffer[offset + 26]; let body = 0;
    if (offset + 27 + segments > buffer.length) break;
    for (let i = 0; i < segments; i += 1) body += buffer[offset + 27 + i];
    offset += 27 + segments + body;
  }
  return { contentType: "audio/ogg", channels, sampleRate,
    durationSeconds: lastGranule !== null && sampleRate ? lastGranule / sampleRate : null };
}

function positive(value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; }

function mediaError(code) {
  const error = new HttpError(422, "Uploaded media content failed validation.");
  error.code = code;
  return error;
}
