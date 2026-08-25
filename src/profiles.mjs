/**
 * Device profiles map a device (or a signed-in web client acting as one) to a capability set.
 *
 * There are two kinds of profile:
 *
 * - **Built-in profiles** — the three shipped defaults below, addressed by string id. These are
 *   the only ids `isKnownDeviceProfile()` accepts, so they remain the only values persisted on a
 *   device record.
 * - **Custom profiles** — a caller-supplied plain object `{ id, capabilities }` passed straight to
 *   `capabilitiesForProfile()` / `resolveDeviceProfile()`. Nothing is stored: the caller owns the
 *   lifetime of the object (config file, per-request override, future org policy document). This is
 *   deliberately database-free.
 */

/** Every capability the policy engine knows how to gate. Keep in sync with `capabilityForIntent()`. */
export const DEVICE_CAPABILITIES = Object.freeze([
  "status",
  "agent_prompt",
  "media_prompt",
  "session_control",
  "approval_response",
  "shell_input",
  // Creating a thread in the bound project, from hardware that has no keyboard. A write to the
  // owner's T3 environment, so it is a capability rather than a selection: `read-only` browses,
  // it does not create.
  "thread_create",
  // Direct terminal write (roadmap Phase 9 stage 3). Deliberately granted by NO built-in profile:
  // the roadmap keeps terminal:operate separate and opt-in, so it is reachable only through a
  // custom profile on an environment that was paired with the terminal:operate scope.
  "terminal_input",
]);

const CAPABILITY_SET = new Set(DEVICE_CAPABILITIES);

const DEVICE_PROFILES = [
  {
    id: "agent-controller",
    label: "Agent controller",
    description: "Full remote agent control for prompts, media, status, approvals, session control, thread creation, and policy-screened shell input.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "shell_input",
      "thread_create",
    ],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only. Prompts, media, approvals, session control, thread creation, and shell input are blocked.",
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
      "thread_create",
    ],
  },
];

const PROFILE_BY_ID = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));

/** Profile used whenever a profile reference cannot be resolved. Deny-by-default. */
export const FALLBACK_PROFILE_ID = "read-only";

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

/**
 * Validate a caller-supplied custom profile object.
 *
 * Shape: `{ id: string, capabilities: string[], label?: string, description?: string }`.
 * Unknown capability names are rejected so a typo silently granting nothing (or, worse, appearing
 * to grant something) surfaces at the call site.
 *
 * @returns {{ valid: true, profile: object } | { valid: false, reason: string }}
 */
export function validateCustomProfile(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { valid: false, reason: "Custom profile must be an object." };
  }
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) return { valid: false, reason: "Custom profile requires a non-empty string id." };
  if (!Array.isArray(candidate.capabilities)) {
    return { valid: false, reason: `Custom profile "${id}" requires a capabilities array.` };
  }
  const capabilities = [];
  for (const capability of candidate.capabilities) {
    if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
      return { valid: false, reason: `Custom profile "${id}" lists unknown capability ${JSON.stringify(capability)}.` };
    }
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return {
    valid: true,
    profile: {
      id,
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim() : id,
      description: typeof candidate.description === "string" ? candidate.description : "Custom profile supplied by the caller.",
      capabilities,
      custom: true,
    },
  };
}

/**
 * Resolve either a built-in profile id or a custom profile object to a profile record.
 *
 * @param {string | object | null | undefined} profileRef
 * @returns {object | null} the resolved profile, or `null` when it cannot be resolved.
 */
export function resolveDeviceProfile(profileRef) {
  if (typeof profileRef === "string") {
    const builtIn = getDeviceProfile(profileRef);
    return builtIn ? { ...builtIn, capabilities: [...builtIn.capabilities], custom: false } : null;
  }
  const custom = validateCustomProfile(profileRef);
  return custom.valid ? custom.profile : null;
}

/**
 * Capability set for a profile reference.
 *
 * Accepts a built-in id (existing behaviour) or a custom profile object. Anything unresolvable
 * falls back to the deny-by-default `read-only` capability set — never to an open one.
 */
export function capabilitiesForProfile(profileRef) {
  const resolved = resolveDeviceProfile(profileRef) ?? getDeviceProfile(FALLBACK_PROFILE_ID);
  return new Set(resolved.capabilities);
}
