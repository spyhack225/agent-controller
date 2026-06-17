import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

export function createSecretBox(secret) {
  const key = typeof secret === "string" && secret.length > 0
    ? createHash("sha256").update(secret, "utf8").digest()
    : null;

  return {
    enabled: Boolean(key),
    seal(value) {
      if (!key) return value;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(String(value), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    open(value) {
      if (typeof value !== "string") return value;
      if (!value.startsWith(`${VERSION}:`)) return value;
      if (!key) {
        throw new Error("Encrypted secret cannot be opened without a token encryption key.");
      }
      const [, ivText, tagText, ciphertextText] = value.split(":");
      if (!ivText || !tagText || !ciphertextText) {
        throw new Error("Encrypted secret has an invalid envelope.");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

export function isSealedSecret(value) {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}
