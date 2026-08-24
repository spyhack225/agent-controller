import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { HttpError } from "./http.mjs";
import { createS3Client, isNotFound } from "./s3.mjs";

let cachedClient = null;
let cachedKey = null;

function objectStoreFor(config) {
  if (config.firmwareStorageProvider !== "s3") return null;
  const key = [config.s3Endpoint, config.s3Region, config.firmwareS3Bucket, config.s3AccessKeyId].join("|");
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = createS3Client({ endpoint: config.s3Endpoint, region: config.s3Region,
    bucket: config.firmwareS3Bucket, accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    ...(config.s3SessionToken ? { sessionToken: config.s3SessionToken } : {}),
    ...(config.s3ForcePathStyle === undefined ? {} : { forcePathStyle: config.s3ForcePathStyle }),
    ...(config.s3TimeoutMs ? { timeoutMs: config.s3TimeoutMs } : {}) });
  cachedKey = key;
  return cachedClient;
}

export async function storeFirmwareArtifact({ config, buffer, hardwareModel, channel, version }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, "Firmware artifact cannot be empty.");
  if (buffer.length > config.maxFirmwareBytes) throw new HttpError(413, `Firmware artifact exceeds ${config.maxFirmwareBytes} bytes.`);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const safe = (value) => String(value).replace(/[^A-Za-z0-9._-]/gu, "_");
  const prefix = normalizePrefix(config.firmwareS3Prefix);
  const key = `${prefix}/${safe(hardwareModel)}/${safe(channel)}/${safe(version)}/${sha256}.bin`;
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    try {
      const existing = await objectStore.headObject({ key });
      if (existing.contentLength !== buffer.length || existing.metadata?.sha256 !== sha256) {
        throw new HttpError(409, "A different immutable firmware object already exists at this key.");
      }
      return { artifactKey: key, artifactProvider: "s3", sha256, sizeBytes: buffer.length };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await objectStore.putObject({ key, body: buffer, contentType: "application/octet-stream",
      cacheControl: "private, max-age=31536000, immutable", metadata: { sha256 } });
    return { artifactKey: key, artifactProvider: "s3", sha256, sizeBytes: buffer.length };
  }
  const storagePath = diskPath(config, key);
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, buffer, { flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(storagePath);
    if (createHash("sha256").update(existing).digest("hex") !== sha256) throw error;
  });
  return { artifactKey: key, artifactProvider: "disk", sha256, sizeBytes: buffer.length };
}

export async function readFirmwareArtifact(release, config) {
  if (!release?.artifactKey) throw new HttpError(404, "Managed firmware artifact not found.");
  if (release.artifactProvider === "s3") return (await objectStoreFor(config).getObject({ key: release.artifactKey })).body;
  return readFile(diskPath(config, release.artifactKey));
}

export async function deleteFirmwareArtifact(artifact, config) {
  if (!artifact?.artifactKey) return;
  if (artifact.artifactProvider === "s3") {
    try { await objectStoreFor(config).deleteObject({ key: artifact.artifactKey }); }
    catch (error) { if (!isNotFound(error)) throw error; }
    return;
  }
  await rm(diskPath(config, artifact.artifactKey), { force: true });
}

function normalizePrefix(value) {
  const parts = String(value ?? "firmware").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part))) {
    throw new HttpError(500, "FIRMWARE_S3_PREFIX must contain safe relative path segments.");
  }
  return parts.join("/");
}

function diskPath(config, key) {
  if (typeof key !== "string" || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new HttpError(500, "Invalid firmware artifact key.");
  }
  const root = resolve(config.firmwareDir);
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new HttpError(500, "Firmware artifact path escapes storage root.");
  return path;
}
