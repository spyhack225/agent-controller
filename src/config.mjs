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
    transcriptionProvider: normalizeTranscriptionProvider(env.TRANSCRIPTION_PROVIDER),
    factoryToken: env.FACTORY_TOKEN ?? null,
    otaSigningKey: env.OTA_SIGNING_KEY ?? null,
    defaultHardwareModel: env.DEFAULT_HARDWARE_MODEL ?? "e213-esp32-s3r8",
    authProvider,
    devTokenCreationEnabled: normalizeBoolean(env.ENABLE_DEV_TOKENS, authProvider === "dev" || demoMode),
    clerkSecretKey: env.CLERK_SECRET_KEY ?? null,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? null,
    clerkAuthorizedParties: parseCsv(env.CLERK_AUTHORIZED_PARTIES),
    storageProvider: env.STORAGE_PROVIDER ?? "file",
    convexUrl: env.CONVEX_URL ?? null,
    convexDeployment: env.CONVEX_DEPLOYMENT ?? null,
    convexGatewaySecret: env.GATEWAY_CONVEX_SECRET ?? null,
    t3TokenEncryptionKey: env.T3_TOKEN_ENCRYPTION_KEY ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY ?? null,
    clerkJwtIssuerDomain: env.CLERK_JWT_ISSUER_DOMAIN ?? null,
    rateLimits: loadRateLimitConfig(env),
    demoMode,
  };
}

function normalizeTranscriptionProvider(value) {
  if (!value) return "disabled";
  const provider = String(value).trim().toLowerCase();
  return ["disabled", "mock"].includes(provider) ? provider : "disabled";
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

function parseCsv(value) {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
