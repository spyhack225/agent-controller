import { loadAlertThresholds } from "./alerts.mjs";
import { loadRateLimitConfig } from "./rateLimit.mjs";

export function loadConfig(env = process.env) {
  const authProvider = env.AUTH_PROVIDER ?? (env.CLERK_SECRET_KEY ? "clerk" : "dev");
  const demoMode = env.DEMO_MODE === "1";
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3996", 10),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
    dataFile: env.DATA_FILE ?? null,
    mediaDir: env.MEDIA_DIR ?? ".data/media",
    maxMediaBytes: Number.parseInt(env.MAX_MEDIA_BYTES ?? String(2 * 1024 * 1024), 10),
    defaultMediaRetentionDays: normalizeRetentionDays(env.DEFAULT_MEDIA_RETENTION_DAYS, 30),
    mediaSigningKey: env.MEDIA_SIGNING_KEY
      ?? env.T3_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_CONVEX_SECRET
      ?? null,
    mediaLinkTtlSeconds: normalizePositiveInt(env.MEDIA_LINK_TTL_SECONDS, 900),
    mediaStorageProvider: env.MEDIA_STORAGE_PROVIDER === "s3" ? "s3" : "disk",
    s3Endpoint: env.S3_ENDPOINT ?? null,
    s3Region: env.S3_REGION ?? "us-east-1",
    s3Bucket: env.S3_BUCKET ?? null,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID ?? null,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
    s3SessionToken: env.S3_SESSION_TOKEN ?? null,
    // Tri-state on purpose: unset lets the client auto-detect (MinIO/R2 need path style,
    // AWS does not). Coercing this to false would break non-AWS endpoints.
    s3ForcePathStyle: normalizeOptionalBoolean(env.S3_FORCE_PATH_STYLE),
    s3TimeoutMs: normalizePositiveInt(env.S3_TIMEOUT_MS, 15_000),
    firmwareStorageProvider: env.FIRMWARE_STORAGE_PROVIDER === "s3" ? "s3" : "disk",
    firmwareDir: env.FIRMWARE_DIR ?? ".data/firmware",
    firmwareS3Bucket: env.FIRMWARE_S3_BUCKET ?? env.S3_BUCKET ?? null,
    firmwareS3Prefix: (env.FIRMWARE_S3_PREFIX ?? "firmware").replace(/^\/+|\/+$/gu, "") || "firmware",
    maxFirmwareBytes: normalizePositiveInt(env.MAX_FIRMWARE_BYTES, 16 * 1024 * 1024),
    firmwareDownloadSigningKey: env.FIRMWARE_DOWNLOAD_SIGNING_KEY ?? null,
    firmwareDownloadTtlSeconds: normalizePositiveInt(env.FIRMWARE_DOWNLOAD_TTL_SECONDS, 600),
    mediaInlineMaxBytes: normalizePositiveInt(env.MEDIA_INLINE_MAX_BYTES, 256 * 1024),
    transcriptionProvider: normalizeTranscriptionProvider(env.TRANSCRIPTION_PROVIDER),
    transcriptionUrl: env.TRANSCRIPTION_URL ?? null,
    transcriptionApiKey: env.TRANSCRIPTION_API_KEY ?? null,
    transcriptionModel: env.TRANSCRIPTION_MODEL ?? "whisper-1",
    transcriptionTimeoutMs: normalizePositiveInt(env.TRANSCRIPTION_TIMEOUT_MS, 30_000),
    visionProvider: normalizeVisionProvider(env.VISION_PROVIDER),
    visionUrl: env.VISION_URL ?? null,
    visionApiKey: env.VISION_API_KEY ?? null,
    visionModel: env.VISION_MODEL ?? "gpt-4o-mini",
    visionTimeoutMs: normalizePositiveInt(env.VISION_TIMEOUT_MS, 30_000),
    visionMaxTokens: normalizePositiveInt(env.VISION_MAX_TOKENS, 600),
    visionPrompt: env.VISION_PROMPT ?? null,
    factoryToken: env.FACTORY_TOKEN ?? null,
    // Phase 4 "TLS only": refuse to issue or accept device credentials in cleartext.
    // Loopback is always exempt so local development and the simulator still work.
    requireTls: normalizeBoolean(env.REQUIRE_TLS, false),
    billingWebhookSecret: env.BILLING_WEBHOOK_SECRET ?? null,
    // Plan limits and tier-based policy are inert until an operator turns billing on. Otherwise
    // every existing deployment would silently drop to the free tier's 0-device, no-shell limits.
    billingEnforced: normalizeBoolean(env.BILLING_ENFORCED, false),
    otaSigningKey: env.OTA_SIGNING_KEY ?? null,
    defaultHardwareModel: env.DEFAULT_HARDWARE_MODEL ?? "e213-esp32-s3r8",
    authProvider,
    devTokenCreationEnabled: normalizeBoolean(env.ENABLE_DEV_TOKENS, authProvider === "dev" || demoMode),
    clerkSecretKey: env.CLERK_SECRET_KEY ?? null,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY ?? null,
    clerkAuthorizedParties: parseCsv(env.CLERK_AUTHORIZED_PARTIES),
    storageProvider: env.STORAGE_PROVIDER ?? "file",
    convexUrl: env.CONVEX_URL ?? null,
    convexDeployment: env.CONVEX_DEPLOYMENT ?? null,
    convexGatewaySecret: env.GATEWAY_CONVEX_SECRET ?? null,
    t3TokenEncryptionKey: env.T3_TOKEN_ENCRYPTION_KEY ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY ?? null,
    clerkJwtIssuerDomain: env.CLERK_JWT_ISSUER_DOMAIN ?? null,
    // Only classify request origin when the operator has actually declared trusted ranges.
    // An unconfigured list stays undefined so the network_location policy dimension is inert.
    trustedNetworks: parseCsv(env.TRUSTED_NETWORKS),
    policyAllowedHours: parseAllowedHours(env.POLICY_ALLOWED_HOURS),
    snapshotPollEnabled: normalizeBoolean(env.SNAPSHOT_POLL_ENABLED, true),
    snapshotPollIntervalMs: normalizePositiveInt(env.SNAPSHOT_POLL_INTERVAL_MS, 5000),
    alertThresholds: loadAlertThresholds(env),
    rateLimits: loadRateLimitConfig(env),
    demoMode,
  };
}

function normalizeTranscriptionProvider(value) {
  if (!value) return "disabled";
  const provider = String(value).trim().toLowerCase();
  return ["disabled", "mock", "openai"].includes(provider) ? provider : "disabled";
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeVisionProvider(value) {
  if (!value) return "disabled";
  const provider = String(value).trim().toLowerCase();
  return ["disabled", "mock", "openai"].includes(provider) ? provider : "disabled";
}

function normalizePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeRetentionDays(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (String(value).toLowerCase() === "never") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : fallback;
}

// Accepts "9-18" or a JSON window object/array understood by the policy engine.
function parseAllowedHours(value) {
  if (!value) return null;
  const text = String(value).trim();
  const range = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/u);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start >= 0 && start <= 24 && end >= 0 && end <= 24) return [start, end];
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseCsv(value) {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
