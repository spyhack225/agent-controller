const DEVICE_PROFILES = [
  {
    id: "agent-controller",
    label: "Agent controller",
    description: "Full remote agent control for prompts, media, status, approvals, session control, and policy-screened shell input.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "shell_input",
    ],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only. Prompts, media, approvals, session control, and shell input are blocked.",
    capabilities: ["status"],
  },
  {
    id: "power-controller",
    label: "Power controller",
    description: "High-trust control profile used by signed-in web clients and advanced devices; dangerous shell input still requires approval.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "shell_input",
    ],
  },
];

const PROFILE_BY_ID = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));

export function listDeviceProfiles() {
  return DEVICE_PROFILES.map((profile) => ({
    ...profile,
    capabilities: [...profile.capabilities],
  }));
}

export function getDeviceProfile(profileId) {
  return PROFILE_BY_ID.get(profileId) ?? null;
}

export function isKnownDeviceProfile(profileId) {
  return PROFILE_BY_ID.has(profileId);
}

export function normalizeDeviceProfile(profileId, fallback = "agent-controller") {
  const profile = typeof profileId === "string" && profileId.trim() ? profileId.trim() : fallback;
  return profile;
}

export function capabilitiesForProfile(profileId) {
  return new Set((getDeviceProfile(profileId) ?? getDeviceProfile("read-only")).capabilities);
}
