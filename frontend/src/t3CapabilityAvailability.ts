import type { Environment, MediaItem, T3CapabilityManifest } from "./types";

export interface CapabilityAvailability { enabled: boolean; reason: string | null }

export function featureAvailability(
  environment: Environment | null | undefined,
  feature: string,
  now = Date.now(),
): CapabilityAvailability {
  const manifest = environment?.health?.capabilities;
  if (!manifest) return { enabled: false, reason: "Checking T3 capabilities…" };
  if (!manifestFresh(manifest, now)) return { enabled: false, reason: "T3 capabilities are stale. Reconnect T3 Code." };
  if (manifest.features?.[feature]?.state !== "supported") {
    return { enabled: false, reason: "The connected T3 does not support this action." };
  }
  return { enabled: true, reason: null };
}

export function composerAvailability(
  environment: Environment | null | undefined,
  attachments: MediaItem[],
  firstTurn = false,
  now = Date.now(),
): CapabilityAvailability {
  const action = featureAvailability(environment, firstTurn ? "launch" : "dispatch", now);
  if (!action.enabled) return action;
  const manifest = environment?.health?.capabilities;
  for (const item of attachments) {
    const state = manifest?.attachments?.[item.kind as "image" | "audio" | "file"]?.state;
    if (state === "supported") continue;
    if (item.kind === "audio" && typeof item.transcript === "string" && item.transcript.trim()) continue;
    return { enabled: false, reason: item.kind === "audio"
      ? "Transcribe this audio before sending it to T3."
      : "The connected T3 does not support this attachment." };
  }
  return action;
}

function manifestFresh(manifest: T3CapabilityManifest, now: number) {
  const freshUntil = Date.parse(manifest.freshUntil);
  return manifest.freshness === "fresh" && Number.isFinite(freshUntil) && freshUntil > now;
}
