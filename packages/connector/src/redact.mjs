const SENSITIVE_KEY = /(authorization|code|credential|secret|ticket|token|password)/i;
const BEARER = /\b(?:Bearer|Connector)\s+[A-Za-z0-9._~+\-/=]+/gi;

export function redact(value, depth = 0) {
  if (depth > 8) return "[REDACTED:DEPTH]";
  if (typeof value === "string") return value.replace(BEARER, "[REDACTED:CREDENTIAL]");
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
  }
  return output;
}

export function safeError(error) {
  const message = redact(String(error?.message ?? error));
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    message,
  };
}
