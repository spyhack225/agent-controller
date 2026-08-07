// Dependency-free S3-compatible object storage client.
//
// The gateway keeps `src/` at zero runtime dependencies, so AWS Signature Version 4 is
// implemented here by hand on top of node:crypto and the global fetch. Everything below is
// checked against the official AWS SigV4 test-suite vectors in test/s3.test.mjs — do not
// "tidy" the canonicalisation rules without re-running them, they are load bearing.

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const DEFAULT_TIMEOUT_MS = 30_000;

// Anything a header value may legally contain. Rejecting the rest is what stops a crafted
// object key or metadata value from smuggling a second header into the request.
const HEADER_VALUE = /^[\t -~]*$/u;
const METADATA_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9.\-_]{1,61}[A-Za-z0-9]$/u;

export class S3Error extends Error {
  constructor(message, { code, statusCode, requestId, hostId, url, method, key } = {}) {
    super(message);
    this.name = "S3Error";
    this.code = code ?? null;
    this.statusCode = statusCode ?? null;
    this.requestId = requestId ?? null;
    this.hostId = hostId ?? null;
    // Safe to retain: authentication is header-based, so a request URL never carries a
    // credential. Nothing derived from accessKeyId/secretAccessKey is stored on the error.
    this.url = url ?? null;
    this.method = method ?? null;
    this.key = key ?? null;
  }
}

export function isNotFound(error) {
  return error instanceof S3Error
    && (error.statusCode === 404 || error.code === "NoSuchKey" || error.code === "NotFound");
}

/* -------------------------------------------------------------------------- */
/* Signature Version 4                                                         */
/* -------------------------------------------------------------------------- */

// AWS's UriEncode(): percent-encode every byte except the unreserved set. Uppercase hex,
// space becomes %20 (never "+"). encodeURIComponent is not a substitute — it leaves
// !'()* unencoded, which produces a signature mismatch on those keys.
export function uriEncode(value, { encodeSlash = true } = {}) {
  const bytes = Buffer.from(String(value), "utf8");
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    const unreserved = (byte >= 0x41 && byte <= 0x5a) // A-Z
      || (byte >= 0x61 && byte <= 0x7a) // a-z
      || (byte >= 0x30 && byte <= 0x39) // 0-9
      || char === "-" || char === "." || char === "_" || char === "~";
    if (unreserved) out += char;
    else if (char === "/" && !encodeSlash) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// A URL's pathname is already percent-encoded, but only to WHATWG rules, which leave
// !'()*$ and friends raw. Decoding first and re-encoding to AWS rules makes this idempotent:
// it fixes up an under-encoded path without double-encoding an already-correct one. Without
// it, signing a URL object turns %2B into %252B and every real server answers 403.
function safeDecodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // A stray "%" that is not a valid escape; sign it as written.
  }
}

// S3 encodes the path exactly once (unlike most other AWS services, which encode twice) and
// never normalises "." / ".." away, because those are legal characters in an object key.
export function canonicalUri(path) {
  const raw = typeof path === "string" && path.length > 0 ? path : "/";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash
    .split("/")
    .map((segment) => uriEncode(safeDecodeSegment(segment)))
    .join("/");
}

// Sorted by encoded name, then encoded value. Values are always present, even when empty
// ("?acl" canonicalises to "acl=").
export function canonicalQueryString(query) {
  const pairs = [];
  if (query instanceof URLSearchParams) {
    for (const [name, value] of query) pairs.push([uriEncode(name), uriEncode(value)]);
  } else if (typeof query === "string" && query.length > 0) {
    for (const part of query.replace(/^\?/u, "").split("&")) {
      if (part === "") continue;
      const index = part.indexOf("=");
      const name = index === -1 ? part : part.slice(0, index);
      const value = index === -1 ? "" : part.slice(index + 1);
      pairs.push([uriEncode(decodeURIComponent(name)), uriEncode(decodeURIComponent(value))]);
    }
  } else if (query && typeof query === "object") {
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      pairs.push([uriEncode(name), uriEncode(value)]);
    }
  }

  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function normalizeHeaderValue(value) {
  const joined = Array.isArray(value) ? value.join(",") : String(value);
  // Trim, then collapse internal whitespace runs — including inside quoted strings, which is
  // what the official get-header-value-trim vector expects.
  return joined.trim().replace(/\s+/gu, " ");
}

export function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name.toLowerCase().trim(), normalizeHeaderValue(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  };
}

export function createCanonicalRequest({ method, path, query, headers, payloadHash }) {
  const { canonical, signedHeaders } = canonicalHeaders(headers);
  return {
    canonicalRequest: [
      String(method).toUpperCase(),
      canonicalUri(path),
      canonicalQueryString(query),
      canonical,
      signedHeaders,
      payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

export function sha256Hex(data) {
  return createHash("sha256").update(data ?? "").digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

// kSecret -> kDate -> kRegion -> kService -> kSigning.
export function deriveSigningKey({ secretAccessKey, dateStamp, region, service }) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

// Exposed for the test that pins the documented intermediate key chain.
export function deriveSigningKeyChain({ secretAccessKey, dateStamp, region, service }) {
  const kSecret = Buffer.from(`AWS4${secretAccessKey}`, "utf8");
  const kDate = hmac(kSecret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, TERMINATOR);
  return { kSecret, kDate, kRegion, kService, kSigning };
}

export function formatAmzDate(date) {
  return new Date(date).toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

/**
 * Signs a request and returns the headers to send plus every intermediate value, so the
 * canonical request and string-to-sign can be asserted against the AWS test vectors.
 */
export function signRequest({
  method,
  url,
  headers = {},
  payloadHash = EMPTY_PAYLOAD_SHA256,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  region,
  service = "s3",
  date = new Date(),
  // S3 requires x-amz-content-sha256 on every request; other services omit it.
  signContentSha256Header = service === "s3",
}) {
  if (!accessKeyId || !secretAccessKey) {
    throw new S3Error("S3 credentials are required to sign a request.", { code: "MissingCredentials" });
  }

  const target = url instanceof URL ? url : new URL(url);
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);

  const signedInput = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    signedInput[name.toLowerCase()] = value;
  }
  // `url.host` already omits the default port, which is exactly what undici puts on the wire.
  signedInput.host = signedInput.host ?? target.host;
  signedInput["x-amz-date"] = amzDate;
  if (signContentSha256Header) signedInput["x-amz-content-sha256"] = payloadHash;
  if (sessionToken) signedInput["x-amz-security-token"] = sessionToken;

  const { canonicalRequest, signedHeaders } = createCanonicalRequest({
    method,
    path: target.pathname,
    query: target.searchParams,
    headers: signedInput,
    payloadHash,
  });

  const scope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey({ secretAccessKey, dateStamp, region, service });
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    signature,
    signedHeaders,
    scope,
    amzDate,
    dateStamp,
    canonicalRequest,
    stringToSign,
    // Everything that went into the signature, host included.
    headers: { ...signedInput, authorization },
  };
}

/* -------------------------------------------------------------------------- */
/* Error responses                                                             */
/* -------------------------------------------------------------------------- */

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "u"));
  if (!match) return null;
  const value = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/u, "$1").trim();
  return value.length > 0 ? value : null;
}

// S3 (and MinIO, Ceph, R2, …) report failures as an <Error> document. Pull the machine
// readable code out of it; fall back to the status line when the body is empty, which is
// what HEAD responses always give us.
export function parseS3ErrorBody(body) {
  if (typeof body !== "string" || !body.includes("<Error")) return null;
  return {
    code: readTag(body, "Code"),
    message: readTag(body, "Message"),
    requestId: readTag(body, "RequestId"),
    hostId: readTag(body, "HostId"),
  };
}

function statusCodeName(status) {
  if (status === 404) return "NotFound";
  if (status === 403) return "AccessDenied";
  if (status === 401) return "Unauthorized";
  return `HTTP${status}`;
}

async function toS3Error(response, { url, method, key }) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // A body we cannot read must not mask the status we already have.
  }
  const parsed = parseS3ErrorBody(body);
  const code = parsed?.code ?? statusCodeName(response.status);
  const detail = parsed?.message ? ` ${parsed.message}` : "";
  return new S3Error(
    `S3 ${method} ${key ?? ""} failed with HTTP ${response.status} (${code}).${detail}`.replace(/\s+/gu, " ").trim(),
    {
      code,
      statusCode: response.status,
      requestId: parsed?.requestId ?? response.headers.get("x-amz-request-id"),
      hostId: parsed?.hostId ?? response.headers.get("x-amz-id-2"),
      url,
      method,
      key,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

function normalizeKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new S3Error("An object key is required.", { code: "InvalidArgument" });
  }
  const trimmed = key.replace(/^\/+/u, "");
  if (trimmed === "") throw new S3Error("An object key is required.", { code: "InvalidArgument" });
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new S3Error("Object keys cannot contain newlines.", { code: "InvalidArgument" });
  }
  return trimmed;
}

function encodeKeyPath(key) {
  return key.split("/").map((segment) => uriEncode(segment)).join("/");
}

function isAwsEndpoint(host) {
  return /(^|\.)amazonaws\.com$/u.test(host);
}

function buildMetadataHeaders(metadata) {
  const headers = {};
  if (!metadata) return headers;
  for (const [rawName, rawValue] of Object.entries(metadata)) {
    if (rawValue === undefined || rawValue === null) continue;
    const name = String(rawName).toLowerCase();
    const value = String(rawValue);
    if (!METADATA_NAME.test(name)) {
      throw new S3Error(`Invalid metadata name: ${JSON.stringify(rawName)}.`, { code: "InvalidArgument" });
    }
    if (!HEADER_VALUE.test(value)) {
      throw new S3Error(`Invalid metadata value for ${name}.`, { code: "InvalidArgument" });
    }
    headers[`x-amz-meta-${name}`] = value;
  }
  return headers;
}

function collectMetadata(responseHeaders) {
  const metadata = {};
  for (const [name, value] of responseHeaders) {
    if (name.toLowerCase().startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
  }
  return metadata;
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new S3Error("Object body must be a Buffer, TypedArray or string.", { code: "InvalidArgument" });
}

/**
 * @param {object} options
 * @param {string} [options.endpoint]   Base endpoint, e.g. "http://127.0.0.1:9000" (MinIO) or
 *                                      "https://s3.us-east-1.amazonaws.com". Defaults to the
 *                                      regional AWS endpoint.
 * @param {string} options.region
 * @param {string} options.bucket
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {string} [options.sessionToken]
 * @param {boolean} [options.forcePathStyle]  Defaults to true for non-AWS endpoints (MinIO and
 *                                      friends only speak path style) and false for AWS.
 */
export function createS3Client({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  forcePathStyle,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  now = () => new Date(),
} = {}) {
  if (!region) throw new S3Error("region is required.", { code: "InvalidArgument" });
  if (!bucket || !BUCKET_NAME.test(bucket)) {
    throw new S3Error(`Invalid bucket name: ${JSON.stringify(bucket)}.`, { code: "InvalidArgument" });
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new S3Error("accessKeyId and secretAccessKey are required.", { code: "MissingCredentials" });
  }

  const base = new URL(endpoint ?? `https://s3.${region}.amazonaws.com`);
  const pathStyle = forcePathStyle ?? !isAwsEndpoint(base.hostname);
  // An endpoint may carry a path prefix (some gateways mount S3 under a sub-path).
  const prefix = base.pathname.replace(/\/+$/u, "");

  function objectUrl(key) {
    const encoded = encodeKeyPath(key);
    if (pathStyle) return new URL(`${prefix}/${bucket}/${encoded}`, base.origin);
    return new URL(`${prefix}/${encoded}`, `${base.protocol}//${bucket}.${base.host}`);
  }

  async function send({ method, key, body = null, headers = {}, payloadHash }) {
    const url = objectUrl(key);
    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
      service: "s3",
      date: now(),
    });

    // undici derives Host from the URL itself and rejects an explicit one; we signed the
    // same value it will send.
    const { host: _host, ...outgoing } = signed.headers;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const doFetch = fetchImpl ?? globalThis.fetch;
      response = await doFetch(url, { method, headers: outgoing, body, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new S3Error(`S3 ${method} timed out after ${timeoutMs}ms.`, {
          code: "RequestTimeout",
          url: url.toString(),
          method,
          key,
        });
      }
      throw new S3Error(`S3 ${method} request failed: ${error?.message ?? String(error)}`, {
        code: "NetworkError",
        url: url.toString(),
        method,
        key,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await toS3Error(response, { url: url.toString(), method, key });
    return { response, url };
  }

  return {
    bucket,
    region,
    endpoint: base.origin,
    forcePathStyle: pathStyle,
    objectUrl: (key) => objectUrl(normalizeKey(key)).toString(),

    async putObject({ key, body, contentType, metadata, cacheControl, contentDisposition } = {}) {
      const objectKey = normalizeKey(key);
      const payload = toBuffer(body);
      const headers = { ...buildMetadataHeaders(metadata) };
      if (contentType) {
        if (!HEADER_VALUE.test(String(contentType))) {
          throw new S3Error("Invalid contentType.", { code: "InvalidArgument" });
        }
        headers["content-type"] = String(contentType);
      }
      if (cacheControl) headers["cache-control"] = String(cacheControl);
      if (contentDisposition) headers["content-disposition"] = String(contentDisposition);

      const payloadHash = sha256Hex(payload);
      const { response, url } = await send({
        method: "PUT",
        key: objectKey,
        body: payload,
        headers,
        payloadHash,
      });

      return {
        key: objectKey,
        bucket,
        url: url.toString(),
        etag: response.headers.get("etag"),
        versionId: response.headers.get("x-amz-version-id"),
        sizeBytes: payload.length,
        sha256: payloadHash,
      };
    },

    async getObject({ key } = {}) {
      const objectKey = normalizeKey(key);
      const { response, url } = await send({
        method: "GET",
        key: objectKey,
        payloadHash: EMPTY_PAYLOAD_SHA256,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        key: objectKey,
        bucket,
        url: url.toString(),
        body: buffer,
        contentType: response.headers.get("content-type"),
        contentLength: buffer.length,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        metadata: collectMetadata(response.headers),
      };
    },

    async headObject({ key } = {}) {
      const objectKey = normalizeKey(key);
      const { response, url } = await send({
        method: "HEAD",
        key: objectKey,
        payloadHash: EMPTY_PAYLOAD_SHA256,
      });
      const length = response.headers.get("content-length");
      return {
        key: objectKey,
        bucket,
        url: url.toString(),
        contentType: response.headers.get("content-type"),
        contentLength: length === null ? null : Number.parseInt(length, 10),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        metadata: collectMetadata(response.headers),
      };
    },

    async deleteObject({ key } = {}) {
      const objectKey = normalizeKey(key);
      const { response, url } = await send({
        method: "DELETE",
        key: objectKey,
        payloadHash: EMPTY_PAYLOAD_SHA256,
      });
      return {
        key: objectKey,
        bucket,
        url: url.toString(),
        deleted: true,
        statusCode: response.status,
      };
    },
  };
}
