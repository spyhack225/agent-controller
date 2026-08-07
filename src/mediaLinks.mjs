import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "m1";

// Media has to reach the T3 environment, which holds no platform session. Rather than
// widening media reads to unauthenticated callers, every attachment carries a short-lived
// HMAC token scoped to a single media id and owner.
export function createMediaAccessToken({ mediaId, userId, secret, expiresAtMs }) {
  if (!secret) throw new Error("A media signing key is required to create media access tokens.");
  if (!mediaId || !userId) throw new Error("mediaId and userId are required to sign a media token.");
  const encoded = encodePayload({ v: VERSION, m: mediaId, u: userId, e: expiresAtMs });
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyMediaAccessToken({ token, secret, now = Date.now() }) {
  if (!secret || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = token.slice(0, separator);
  if (!safeEqual(token.slice(separator + 1), sign(encoded, secret))) return null;

  const payload = decodePayload(encoded);
  if (!payload || payload.v !== VERSION) return null;
  if (typeof payload.m !== "string" || typeof payload.u !== "string") return null;
  if (!Number.isFinite(payload.e) || payload.e <= now) return null;

  return { mediaId: payload.m, userId: payload.u, expiresAtMs: payload.e };
}

export function buildSignedMediaUrl({ media, baseUrl, secret, ttlSeconds, now = Date.now() }) {
  const expiresAtMs = now + ttlSeconds * 1000;
  const token = createMediaAccessToken({
    mediaId: media.id,
    userId: media.userId,
    secret,
    expiresAtMs,
  });
  const url = new URL(`/v1/media/${encodeURIComponent(media.id)}/content`, baseUrl);
  url.searchParams.set("token", token);
  return { url: url.toString(), expiresAt: new Date(expiresAtMs).toISOString() };
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
