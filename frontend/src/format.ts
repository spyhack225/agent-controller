import type { Command, JsonRecord, MediaItem } from "./types";

export function formatRelativeTime(value?: string | null): string {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

export function formatUptime(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  const seconds = Math.floor(Number(value) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatMetric(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  return `${Number(value)} ${unit}`;
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

export function commandSummary(command: Command): string {
  const intent = command.intent ?? {};
  const candidates = [intent.command, intent.text, intent.prompt, intent.transcript];
  const summary = candidates.find((candidate) => typeof candidate === "string");
  if (typeof summary === "string" && summary.trim()) return summary;
  if (typeof command.result === "string") return command.result;
  if (command.result && typeof command.result === "object") {
    const reason = (command.result as JsonRecord).reason;
    if (typeof reason === "string") return reason;
  }
  return "No command detail";
}

export function commandType(command: Command): string {
  const type = command.intent?.type;
  return typeof type === "string" ? type.replaceAll("_", " ") : "command";
}

export function renderEventResult(result: unknown): string {
  if (!result) return "No result";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const record = result as JsonRecord;
    if (typeof record.status === "string") return record.status;
    if (typeof record.reason === "string") return record.reason;
  }
  return JSON.stringify(result);
}

export function formatMediaProcessing(media: MediaItem): string {
  const parts = [media.processing?.transcriptionStatus ?? "ready"];
  if (media.processing?.transcriptSource) parts.push(`via ${media.processing.transcriptSource}`);
  if (media.processing?.lastError) parts.push(media.processing.lastError);
  return parts.join(" · ");
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to capture camera frame."));
    }, type);
  });
}
