export const ONBOARDING_VERSION = 2;

export const ONBOARDING_STEPS = [
  "welcome",
  "host",
  "connect",
  "workspace",
  "device",
  "ready",
];

export const ONBOARDING_STATUSES = [
  "not_started",
  "in_progress",
  "paused",
  "completed",
];

export const ONBOARDING_NETWORK_MODES = [
  "local",
  "lan",
  "tailscale",
  "custom",
];

export const ONBOARDING_DEVICE_MODES = [
  "existing",
  "claim",
  "register",
  "browser_only",
];

const EMPTY_ONBOARDING = {
  version: ONBOARDING_VERSION,
  status: "not_started",
  currentStep: "welcome",
  networkMode: null,
  networkUrl: null,
  provider: {
    harness: null,
    instanceId: null,
    model: null,
  },
  workspace: {
    path: null,
    title: null,
    projectId: null,
  },
  environmentId: null,
  firstThreadId: null,
  device: {
    mode: null,
    deviceId: null,
    credentialConfirmed: false,
  },
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  updatedAt: null,
};

export function defaultOnboarding() {
  return structuredClone(EMPTY_ONBOARDING);
}

export function normalizeOnboarding(value, previous = null, now = new Date().toISOString()) {
  const base = normalizeStoredOnboarding(previous);
  const input = isRecord(value) ? value : {};
  const nextStatus = validValue(input.status, ONBOARDING_STATUSES) ?? base.status;
  const next = {
    version: ONBOARDING_VERSION,
    status: nextStatus,
    currentStep: validValue(input.currentStep, ONBOARDING_STEPS) ?? base.currentStep,
    networkMode: Object.hasOwn(input, "networkMode")
      ? nullableValidValue(input.networkMode, ONBOARDING_NETWORK_MODES)
      : base.networkMode,
    networkUrl: Object.hasOwn(input, "networkUrl")
      ? nullableString(input.networkUrl)
      : base.networkUrl,
    provider: {
      harness: nestedNullableString(input.provider, "harness", base.provider.harness),
      instanceId: nestedNullableString(input.provider, "instanceId", base.provider.instanceId),
      model: nestedNullableString(input.provider, "model", base.provider.model),
    },
    workspace: {
      path: nestedNullableString(input.workspace, "path", base.workspace.path),
      title: nestedNullableString(input.workspace, "title", base.workspace.title),
      projectId: nestedNullableString(input.workspace, "projectId", base.workspace.projectId),
    },
    environmentId: Object.hasOwn(input, "environmentId")
      ? nullableString(input.environmentId)
      : base.environmentId,
    firstThreadId: Object.hasOwn(input, "firstThreadId")
      ? nullableString(input.firstThreadId)
      : base.firstThreadId,
    device: {
      mode: nestedNullableValidValue(input.device, "mode", ONBOARDING_DEVICE_MODES, base.device.mode),
      deviceId: nestedNullableString(input.device, "deviceId", base.device.deviceId),
      credentialConfirmed: nestedBoolean(
        input.device,
        "credentialConfirmed",
        base.device.credentialConfirmed,
      ),
    },
    startedAt: base.startedAt,
    pausedAt: base.pausedAt,
    completedAt: base.completedAt,
    updatedAt: now,
  };

  if (next.status !== "not_started" && !next.startedAt) next.startedAt = now;
  if (next.status === "paused") next.pausedAt = now;
  if (next.status === "in_progress") next.pausedAt = null;
  if (next.status === "completed") {
    next.completedAt = base.completedAt ?? now;
    next.pausedAt = null;
    next.currentStep = "ready";
  } else if (base.status === "completed") {
    next.completedAt = null;
  }
  return next;
}

export function normalizeStoredOnboarding(value) {
  if (!isRecord(value)) return defaultOnboarding();
  const provider = isRecord(value.provider) ? value.provider : {};
  const workspace = isRecord(value.workspace) ? value.workspace : {};
  const device = isRecord(value.device) ? value.device : {};
  return {
    version: ONBOARDING_VERSION,
    status: validValue(value.status, ONBOARDING_STATUSES) ?? "not_started",
    currentStep: validValue(value.currentStep, ONBOARDING_STEPS) ?? "welcome",
    networkMode: nullableValidValue(value.networkMode, ONBOARDING_NETWORK_MODES),
    networkUrl: nullableString(value.networkUrl),
    provider: {
      harness: nullableString(provider.harness),
      instanceId: nullableString(provider.instanceId),
      model: nullableString(provider.model),
    },
    workspace: {
      path: nullableString(workspace.path),
      title: nullableString(workspace.title),
      projectId: nullableString(workspace.projectId),
    },
    environmentId: nullableString(value.environmentId),
    firstThreadId: nullableString(value.firstThreadId),
    device: {
      mode: nullableValidValue(device.mode, ONBOARDING_DEVICE_MODES),
      deviceId: nullableString(device.deviceId),
      credentialConfirmed: device.credentialConfirmed === true,
    },
    startedAt: nullableString(value.startedAt),
    pausedAt: nullableString(value.pausedAt),
    completedAt: nullableString(value.completedAt),
    updatedAt: nullableString(value.updatedAt),
  };
}

export function buildOnboardingReadiness({
  onboarding,
  environments = [],
  devices = [],
  commands = [],
}) {
  const setup = normalizeStoredOnboarding(onboarding);
  const environment = environments.find((candidate) => candidate.id === setup.environmentId) ?? null;
  const device = devices.find((candidate) => candidate.id === setup.device.deviceId) ?? null;
  const firstRunCommand = commands.find((command) =>
    command.environmentId === setup.environmentId
    && command.threadId === setup.firstThreadId
    && command.normalized?.type === "thread.launch"
    && command.normalized?.createThread?.projectId === setup.workspace.projectId
    && command.normalized?.startTurn?.modelSelection?.instanceId === setup.provider.instanceId
    && command.normalized?.startTurn?.modelSelection?.model === setup.provider.model
    // Dispatch acknowledgement only proves T3 accepted the request. The command arbiter moves the
    // row to completed only after a newer assistant reply is observed, which is the first honest
    // end-to-end proof that the provider actually ran.
    && command.status === "completed") ?? null;
  // `latestActivityAt` rather than `presence.online`, deliberately: activation means "this hardware
  // has proven it reaches the gateway", not "it is powered on at the instant you loaded the page".
  // A controller unplugged since setup must not un-complete someone's onboarding.
  const configuredDevice = Boolean(
    device
    && !device.revokedAt
    && device.config?.environmentId === setup.environmentId
    && device.config?.threadId === setup.firstThreadId
    && device.presence?.latestActivityAt,
  );
  const firstRunCompleted = Boolean(setup.firstThreadId && firstRunCommand);
  const checks = {
    account: true,
    hostPlan: Boolean(
      setup.networkMode
      && setup.provider.harness
      && setup.workspace.path
      && (setup.networkMode !== "custom" || setup.networkUrl),
    ),
    environmentPaired: Boolean(environment),
    environmentReachable: Boolean(
      environment
      && environment.status === "reachable"
      && environment.health?.lastReachableAt,
    ),
    workspaceSelected: Boolean(setup.workspace.projectId),
    providerConfigured: Boolean(setup.provider.instanceId && setup.provider.model),
    firstRunCompleted,
    // Compatibility alias for pre-cloud console builds. Its semantics are deliberately stricter
    // now: accepted/dispatched is false until the command arbiter observes the agent reply.
    firstRunDispatched: firstRunCompleted,
    deviceReady: setup.device.mode === "browser_only"
      || Boolean(
        configuredDevice
        && (setup.device.mode !== "register" || setup.device.credentialConfirmed),
      ),
  };
  return {
    checks,
    ready: Object.entries(checks)
      .filter(([key]) => key !== "firstRunDispatched")
      .every(([, value]) => Boolean(value)),
    environment,
    device,
    firstRunCommand,
  };
}

function nestedNullableString(value, key, fallback) {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return fallback;
  return nullableString(value[key]);
}

function nestedNullableValidValue(value, key, allowed, fallback) {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return fallback;
  return nullableValidValue(value[key], allowed);
}

function nestedBoolean(value, key, fallback) {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return fallback;
  return value[key] === true;
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validValue(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function nullableValidValue(value, allowed) {
  if (value === null || value === undefined) return null;
  return validValue(value, allowed);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
