import { HttpError, requireString } from "./http.mjs";
import { normalizeMediaIntent } from "./media.mjs";

export async function normalizeIntent(payload, context = {}) {
  const type = requireString(payload.type, "type");

  switch (type) {
    case "status":
      return { type };
    case "agent_prompt":
      return {
        type,
        text: requireString(payload.text, "text"),
        source: payload.source ?? "device",
      };
    case "audio_prompt":
      return normalizeMediaIntent({
        type,
        transcript: typeof payload.transcript === "string" ? payload.transcript : undefined,
        prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
        mediaUploadId: typeof payload.mediaUploadId === "string" ? payload.mediaUploadId : undefined,
      }, context);
    case "camera_prompt":
      return normalizeMediaIntent({
        type,
        prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
        mediaUploadId: typeof payload.mediaUploadId === "string" ? payload.mediaUploadId : undefined,
      }, context);
    case "shell_input":
      return { type, command: requireString(payload.command, "command") };
    case "session_control": {
      const action = requireString(payload.action, "action");
      if (!["continue", "stop", "interrupt"].includes(action)) {
        throw new HttpError(400, "Unsupported session_control action.");
      }
      return { type, action };
    }
    case "approval_response": {
      const decision = requireString(payload.decision, "decision");
      if (!["approve", "reject"].includes(decision)) {
        throw new HttpError(400, "approval_response decision must be approve or reject.");
      }
      return {
        type,
        requestId: requireString(payload.requestId, "requestId"),
        decision,
      };
    }
    default:
      throw new HttpError(400, `Unsupported intent type: ${type}.`);
  }
}
