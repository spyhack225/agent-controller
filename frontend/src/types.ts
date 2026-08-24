export type PageId =
  | "quick"
  | "operate"
  | "actions"
  | "devices"
  | "environments"
  | "media"
  | "activity"
  | "settings"
  | "onboarding";
export type ConnectionState =
  | "signed-out"
  | "connecting"
  | "connected"
  | "live"
  | "reconnecting"
  | "error";

export type JsonRecord = Record<string, unknown>;

export interface AuthConfig {
  authProvider?: string;
  demoMode?: boolean;
  developmentTokens?: { enabled?: boolean };
  clerk?: {
    enabled?: boolean;
    publishableKey?: string | null;
  };
}

export interface RemoteAccessStatus {
  checkedAt: string;
  gateway: {
    host: string;
    port: number;
    loopbackUrl: string;
    lanUrls: string[];
    publicBaseUrl: string | null;
  };
  tailscale: {
    installed: boolean;
    connected: boolean;
    backendState: string;
    dnsName: string | null;
    ips: string[];
    httpsUrl: string | null;
    serve: { active: boolean; statusAvailable: boolean };
    funnel: { active: boolean; statusAvailable: boolean };
    mode: "serve" | "funnel" | null;
    publicBaseUrlConfigured: boolean;
    ready: boolean;
    error: string | null;
    nextStep: "install" | "connect" | "enable" | "restart" | "ready";
  };
}

export type GatewayProfileMode = "lan" | "tailnet" | "custom";

export interface GatewayProfile {
  id: string;
  label: string;
  mode: GatewayProfileMode;
  baseUrl: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceGatewaySwitch {
  deviceId: string;
  revision: number;
  state: "stable" | "pending" | "failed";
  activeProfile?: GatewayProfile | null;
  pendingProfile?: GatewayProfile | null;
  previousProfile?: GatewayProfile | null;
  lastError?: string | null;
  requestedAt?: string | null;
  appliedAt?: string | null;
}

export interface DeviceGatewaySelection {
  revision: number;
  state: "stable" | "pending" | "failed";
  activeProfileId?: string | null;
  pendingProfileId?: string | null;
  previousProfileId?: string | null;
  lastError?: string | null;
  requestedAt?: string | null;
  appliedAt?: string | null;
}

export interface DeviceProfile {
  id: string;
  label?: string;
  description?: string;
  /** Intent types the profile grants, as returned by GET /v1/device-profiles. */
  capabilities?: string[];
}

export interface EnvironmentHealth {
  lastCheckedAt?: string | null;
  lastReachableAt?: string | null;
  lastError?: string | null;
  snapshot?: {
    title?: string;
    state?: string;
    line1?: string;
    line2?: string;
  } | null;
  compatibility?: T3CompatibilityResult | null;
}

export type T3CompatibilityStatus =
  | "unchecked"
  | "compatible"
  | "update_recommended"
  | "review_required"
  | "incompatible"
  | "unknown";

export interface T3CompatibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface T3CompatibilityFinding {
  level: "danger" | "warning" | "info";
  code: string;
  message: string;
}

export interface T3CompatibilityResult {
  environmentId: string;
  environmentLabel: string;
  checkedAt: string | null;
  installedVersion: string | null;
  previousVersion?: string | null;
  versionChanged?: boolean;
  status: T3CompatibilityStatus;
  compatible: boolean;
  breakingRisk: boolean;
  latestVersion: string | null;
  recommendedVersion: string;
  minimumVersion: string;
  maximumTestedVersion: string;
  recommendation: string;
  checks: T3CompatibilityCheck[];
  findings: T3CompatibilityFinding[];
}

export interface T3ReleaseCompatibility {
  packageName: string;
  latestVersion: string | null;
  latestError: string | null;
  minimumVersion: string;
  maximumTestedVersion: string;
  recommendedVersion: string;
  status: "supported" | "review_required" | "unavailable";
  alert: string | null;
  checkedAt?: string;
}

export interface T3CompatibilityOverview {
  release: T3ReleaseCompatibility;
  results: T3CompatibilityResult[];
  summary: {
    environments: number;
    breakingRisks: number;
    incompatible: number;
    reviewRequired: number;
    updatesRecommended: number;
    unchecked: number;
    needsAttention: boolean;
  };
}

export interface Environment {
  id: string;
  label: string;
  status?: string;
  baseUrl: string;
  accessTokenExpiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  health?: EnvironmentHealth;
}

/** What still points at an environment, as returned by GET /v1/t3/environments/:id/dependencies. */
export interface EnvironmentDependencyRef {
  id: string;
  label: string;
}

export interface EnvironmentDependencyCounts {
  devices: number;
  actions: number;
  macros: number;
  onboarding: number;
}

export interface EnvironmentDependencies {
  environmentId: string;
  dependencies: {
    devices: EnvironmentDependencyRef[];
    actions: EnvironmentDependencyRef[];
    macros: EnvironmentDependencyRef[];
    onboarding: boolean;
  };
  counts: EnvironmentDependencyCounts;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: unknown[];
}

export interface ModelRecovery {
  requested: ModelSelection | null;
  selected: ModelSelection;
  reason: string;
  catalogueSource: "live" | "registered" | "snapshot-only";
}

export interface T3ModelOptionChoice {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface T3ModelOption {
  id: string;
  label: string;
  type: string;
  currentValue: string | null;
  choices: T3ModelOptionChoice[];
}

export interface T3HarnessModel {
  slug: string;
  name: string;
  isCustom: boolean;
  options: T3ModelOption[];
  /** True when the model was only inferred from usage, not from a registered catalogue. */
  observed?: boolean;
}

export interface T3Harness {
  instanceId: string;
  label: string;
  badge?: string | null;
  version?: string | null;
  status?: string;
  available?: boolean;
  unavailableReason?: string | null;
  auth?: { status: string; type: string | null; label: string | null };
  models: T3HarnessModel[];
}

export interface T3SessionFailure {
  threadId: string | null;
  title: string | null;
  status: string;
  instanceId: string | null;
  model: string | null;
  message: string;
  code: string | null;
  updatedAt: string | null;
}

export interface T3HarnessCatalogue {
  harnesses: T3Harness[];
  usable: string[];
  modelSelection: ModelSelection | null;
  sessionFailures: T3SessionFailure[];
  catalogueSource: "live" | "registered" | "snapshot-only";
}

export interface T3Project {
  id: string;
  title?: string;
  name?: string;
  workspaceRoot?: string;
  defaultModelSelection?: ModelSelection | null;
}

export interface T3ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt?: string | null;
  streaming?: boolean;
}

export interface T3Thread {
  id: string;
  label: string;
  projectId?: string | null;
  modelSelection?: ModelSelection | null;
  status?: string | null;
  messages?: T3ThreadMessage[];
}

export interface DeviceConfig {
  environmentId?: string | null;
  threadId?: string | null;
  gatewayAccessMode?: "local" | "tailscale" | "online";
  gatewayUrl?: string | null;
  defaultPrompt?: string;
  shellCommand?: string;
  menu?: string[];
}

export interface DeviceStatus {
  lastHeartbeatAt?: string | null;
  firmwareVersion?: string | null;
  hardwareModel?: string | null;
  ipAddress?: string | null;
  wifiRssi?: number | null;
  freeHeap?: number | null;
  uptimeMs?: number | null;
  batteryPercent?: number | null;
  batteryMv?: number | null;
  protocolVersion?: number | null;
  features?: string[];
  limits?: {
    menuItems?: number;
    labelCharacters?: number;
  };
}

export interface Device {
  id: string;
  label: string;
  profile: string;
  claimed?: boolean;
  revokedAt?: string | null;
  lastSeenAt?: string | null;
  presence?: {
    state?: string;
    online?: boolean;
    staleAfterMs?: number;
  };
  /**
   * Which owner operations the gateway will currently accept for this device. Server-declared so
   * the console does not have to re-derive it from revokedAt and drift out of sync with the guards
   * in the store. Absent on an older gateway, which callers should treat as permitted.
   */
  actions?: {
    rotateSecret?: boolean;
    transferReset?: boolean;
    updateConfig?: boolean;
    updateProfile?: boolean;
    revoke?: boolean;
    delete?: boolean;
  };
  status?: DeviceStatus;
  config?: DeviceConfig;
  gatewaySelection?: DeviceGatewaySelection;
}

export interface Command {
  id: string;
  status: string;
  risk?: string;
  threadId?: string | null;
  environmentId?: string | null;
  deviceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  intent?: JsonRecord;
  result?: JsonRecord | string | null;
  metrics?: JsonRecord;
}

export interface CommandEvent {
  id: string;
  status: string;
  previousStatus?: string | null;
  risk?: string;
  actorType?: string;
  actorId?: string | null;
  result?: JsonRecord | string | null;
  createdAt?: string;
}

export interface Macro {
  id: string;
  label: string;
  environmentId?: string | null;
  threadId?: string | null;
  intent?: JsonRecord;
  disabled?: boolean;
  disabledReason?: string | null;
}

export type SavedActionType = "prompt" | "shell" | "media" | "macro";

export interface SavedActionStep {
  actionId: string;
  position?: number;
  continueOnFailure?: boolean;
}

/** A reusable operation. Payloads remain in the gateway; devices only receive opaque action IDs. */
export interface SavedAction {
  id: string;
  label: string;
  type: SavedActionType;
  intent?: JsonRecord | null;
  payload?: JsonRecord;
  targetMode?: "device-current" | "fixed";
  steps?: SavedActionStep[];
  environmentId?: string | null;
  threadId?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deviceIds?: string[];
}

export interface DeviceControlItem {
  id?: string;
  kind?: "system" | "status" | "stop" | "remote_action" | string;
  actionId?: string;
  label?: string;
  enabled?: boolean;
  reason?: string | null;
  requiresThread?: boolean;
  requiresConfirmation?: boolean;
}

export interface DeviceControls {
  revision: number;
  acknowledgedRevision?: number | null;
  appliedRevision?: number | null;
  appliedAt?: string | null;
  lastAckStatus?: string | null;
  lastAckError?: string | null;
  items: DeviceControlItem[];
  capacity?: number;
}

export interface DeviceFirmwarePolicy {
  channel: "stable" | "beta";
  updateMode: "manual" | "notify" | "automatic";
  desiredVersion?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  availableVersions?: string[];
  status?: string | null;
  lastUpdateStatus?: string | null;
  lastUpdateAt?: string | null;
  lastError?: string | null;
  lastUpdateError?: string | null;
  updateProgress?: number | null;
  targetVersion?: string | null;
  releaseNotes?: string | null;
}

export interface MediaItem {
  id: string;
  kind: "audio" | "image" | string;
  contentType: string;
  sizeBytes?: number;
  originalName?: string | null;
  transcript?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  processing?: {
    transcriptionStatus?: string;
    transcriptSource?: string | null;
    lastError?: string | null;
  };
}

export interface AuditEvent {
  id?: string;
  action: string;
  actorType?: string;
  actorId?: string | null;
  targetId?: string | null;
  createdAt: string;
}

export interface DisplayState extends JsonRecord {
  title?: string;
  state?: string;
  line1?: string;
  line2?: string;
  latestAction?: string | null;
  counts?: Record<string, number>;
}

export interface DeviceSecret {
  title: string;
  id?: string;
  secret?: string;
  claimCode?: string;
}

export interface ClerkBridge {
  loaded: boolean;
  signedIn: boolean;
  userLabel: string | null;
  getToken: () => Promise<string | null>;
  openSignIn: () => void;
  openSignUp: () => void;
  openUserProfile: () => void;
  signOut: () => Promise<void>;
}

export type OnboardingStep = "welcome" | "host" | "connect" | "workspace" | "device" | "ready";
export type OnboardingStatus = "not_started" | "in_progress" | "paused" | "completed";
export type OnboardingNetworkMode = "local" | "lan" | "tailscale" | "custom";
export type OnboardingDeviceMode = "existing" | "claim" | "register" | "browser_only";

export interface OnboardingState {
  version: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  networkMode: OnboardingNetworkMode | null;
  networkUrl: string | null;
  provider: {
    harness: string | null;
    instanceId: string | null;
    model: string | null;
  };
  workspace: {
    path: string | null;
    title: string | null;
    projectId: string | null;
  };
  environmentId: string | null;
  firstThreadId: string | null;
  device: {
    mode: OnboardingDeviceMode | null;
    deviceId: string | null;
    credentialConfirmed: boolean;
  };
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface OnboardingReadiness {
  checks: {
    account: boolean;
    hostPlan: boolean;
    environmentPaired: boolean;
    environmentReachable: boolean;
    workspaceSelected: boolean;
    providerConfigured: boolean;
    firstRunDispatched: boolean;
    deviceReady: boolean;
  };
  ready: boolean;
  environment: Environment | null;
  device: Device | null;
}

export interface OnboardingResponse {
  onboarding: OnboardingState;
  readiness: OnboardingReadiness;
}
