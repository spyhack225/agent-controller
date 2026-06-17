import { capabilitiesForProfile } from "./profiles.mjs";

const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf\b/u,
  /\bsudo\b/u,
  /\bchmod\s+777\b/u,
  /\b(chown|mkfs|dd)\b/u,
  /\bgit\s+push\b/u,
  /\b(kubectl|terraform)\s+(apply|destroy)\b/u,
  /\bvercel\s+deploy\b/u,
  /\bnpm\s+publish\b/u,
];

export function evaluateIntentPolicy({ device, intent }) {
  const capabilities = capabilitiesForProfile(device.profile);
  const capability = capabilityForIntent(intent);

  if (!capabilities.has(capability)) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `Device profile "${device.profile}" cannot perform ${capability}.`,
    };
  }

  if (intent.type === "shell_input") {
    const command = intent.command.trim();
    const dangerous = DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(command));
    if (dangerous) {
      return {
        allowed: false,
        requiresApproval: true,
        risk: "high",
        reason: "Direct dangerous shell input requires an explicit higher-trust confirmation path.",
      };
    }
    return { allowed: true, risk: "medium" };
  }

  if (intent.type === "approval_response" && intent.decision === "approve") {
    return { allowed: true, risk: "medium" };
  }

  return { allowed: true, risk: "low" };
}

function capabilityForIntent(intent) {
  switch (intent.type) {
    case "status":
      return "status";
    case "agent_prompt":
      return "agent_prompt";
    case "audio_prompt":
    case "camera_prompt":
    case "media_prompt":
      return "media_prompt";
    case "shell_input":
      return "shell_input";
    case "approval_response":
      return "approval_response";
    case "session_control":
      return "session_control";
    default:
      return "unknown";
  }
}
