import { randomBytes, randomUUID } from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function nowIso() {
  return new Date().toISOString();
}
