import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, downloadJson, requestJson, type ApiOptions } from "./api";
import { useApprovalNotifications } from "./notifications";
import type {
  AuditEvent,
  AuthConfig,
  ClerkBridge,
  Command,
  CommandEvent,
  ConnectionState,
  Device,
  DeviceConfig,
  DeviceProfile,
  DeviceSecret,
  DisplayState,
  Environment,
  JsonRecord,
  Macro,
  MediaItem,
  ModelRecovery,
  ModelSelection,
  OnboardingReadiness,
  OnboardingResponse,
  OnboardingState,
  RemoteAccessStatus,
  T3HarnessCatalogue,
  T3Project,
  T3Thread,
  T3ThreadMessage,
  SavedAction,
  GatewayProfile,
} from "./types";

interface Notice {
  tone: "success" | "danger" | "info";
  message: string;
}

interface WorkspaceRecovery {
  environmentId: string;
  message: string;
}

export const T3_SNAPSHOT_UNAVAILABLE_MESSAGE = "T3 snapshot is unavailable.";

export function isT3SnapshotUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.message === T3_SNAPSHOT_UNAVAILABLE_MESSAGE;
}

interface UseControllerOptions {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as JsonRecord;
    return typeof record.text === "string"
      ? record.text
      : typeof record.content === "string" ? record.content : "";
  }).filter(Boolean).join("\n").trim();
}

export function normalizeThread(thread: JsonRecord, projects: T3Project[]): T3Thread | null {
  const idValue = thread.id ?? thread.threadId ?? thread.sessionId;
  if (typeof idValue !== "string" || !idValue) return null;
  const projectValue = thread.projectId
    ?? (typeof thread.project === "object" && thread.project
      ? (thread.project as JsonRecord).id
      : null);
  const projectId = typeof projectValue === "string" ? projectValue : null;
  const project = projects.find((candidate) => candidate.id === projectId);
  const titleValue = thread.title ?? thread.name ?? thread.label;
  const title = typeof titleValue === "string" && titleValue ? titleValue : idValue;
  const suffix = project?.title ?? project?.name ?? projectId ?? "";
  const statusValue = thread.status ?? thread.state;
  const rawModelSelection = thread.modelSelection;
  const modelSelection = rawModelSelection && typeof rawModelSelection === "object"
    && typeof (rawModelSelection as JsonRecord).instanceId === "string"
    && typeof (rawModelSelection as JsonRecord).model === "string"
    ? {
        instanceId: (rawModelSelection as JsonRecord).instanceId as string,
        model: (rawModelSelection as JsonRecord).model as string,
        ...(Array.isArray((rawModelSelection as JsonRecord).options)
          ? { options: (rawModelSelection as JsonRecord).options as unknown[] }
          : {}),
      }
    : null;
  const messages = Array.isArray(thread.messages) ? thread.messages.flatMap((message, index) => {
    if (!message || typeof message !== "object") return [];
    const record = message as JsonRecord;
    const text = messageText(record.text ?? record.content ?? record.message);
    if (!text) return [];
    const rawRole = typeof record.role === "string" ? record.role.toLowerCase() : "system";
    const role: T3ThreadMessage["role"] = rawRole === "user" || rawRole === "assistant" || rawRole === "tool"
      ? rawRole
      : "system";
    const id = typeof record.id === "string"
      ? record.id
      : typeof record.messageId === "string" ? record.messageId : `${idValue}-message-${index}`;
    return [{
      id,
      role,
      text,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      streaming: record.streaming === true,
    }];
  }) : [];
  return {
    id: idValue,
    label: suffix ? `${title} — ${suffix}` : title,
    projectId,
    modelSelection,
    status: typeof statusValue === "string" ? statusValue : null,
    messages,
  };
}

export function dedupeEnvironments(environments: Environment[]): Environment[] {
  const unique = new Map<string, Environment>();
  for (const environment of environments) {
    const key = environment.baseUrl.trim().replace(/\/+$/u, "").toLowerCase();
    const current = unique.get(key);
    if (!current) {
      unique.set(key, environment);
      continue;
    }

    // Legacy pairing could create a second row for the same T3 server. Keep the oldest identity so
    // device/onboarding references remain stable; when timestamps are unavailable, retain the first
    // API result (the stores return records in creation order).
    const currentCreatedAt = Date.parse(current.createdAt ?? "");
    const candidateCreatedAt = Date.parse(environment.createdAt ?? "");
    if (Number.isFinite(candidateCreatedAt)
      && (!Number.isFinite(currentCreatedAt) || candidateCreatedAt < currentCreatedAt)) {
      unique.set(key, environment);
    }
  }
  return [...unique.values()];
}

export function useController({ authConfig, clerk }: UseControllerOptions) {
  const authenticated = Boolean(clerk?.loaded && clerk.signedIn);
  const [connection, setConnection] = useState<ConnectionState>("signed-out");
  const [connectionDetail, setConnectionDetail] = useState("Authentication required");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [workspaceRecovery, setWorkspaceRecovery] = useState<WorkspaceRecovery | null>(null);
  const [lastResult, setLastResult] = useState<unknown>({
    message: "Console ready.",
  });

  const [deviceProfiles, setDeviceProfiles] = useState<DeviceProfile[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [threads, setThreads] = useState<T3Thread[]>([]);
  const [harnessCatalogue, setHarnessCatalogue] = useState<T3HarnessCatalogue | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [commandEvents, setCommandEvents] = useState<CommandEvent[]>([]);
  const [timelineCommand, setTimelineCommand] = useState<Command | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [actions, setActions] = useState<SavedAction[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [display, setDisplay] = useState<DisplayState | null>(null);
  const [privacyDays, setPrivacyDays] = useState<number | null>(30);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessStatus | null>(null);
  const [gatewayProfiles, setGatewayProfiles] = useState<GatewayProfile[]>([]);
  const [deviceSecret, setDeviceSecret] = useState<DeviceSecret | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [onboardingReadiness, setOnboardingReadiness] = useState<OnboardingReadiness | null>(null);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);

  const [selectedEnvironmentId, setSelectedEnvironmentIdState] = useState("");
  const [selectedProjectId, setSelectedProjectIdState] = useState("");
  const [selectedThreadId, setSelectedThreadIdState] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>({
    environmentId: null,
    threadId: null,
    gatewayAccessMode: "local",
    gatewayUrl: null,
    defaultPrompt: "",
    shellCommand: "npm test",
    menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
  });

  const refreshTimerRef = useRef<number | null>(null);
  // Refresh coalescing and rate-limit backoff. Without these, one 429 feeds the next refresh and
  // the dashboard hammers the gateway until the window resets.
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const rateLimitedUntilRef = useRef(0);
  const refreshAllRef = useRef<(() => Promise<void>) | null>(null);
  const selectedEnvironmentIdRef = useRef("");
  const selectedProjectIdRef = useRef("");
  const selectedThreadIdRef = useRef("");
  const snapshotRequestRef = useRef(0);
  const harnessRequestRef = useRef(0);

  const api = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    try {
      let requestToken = options.token;
      if (options.auth !== false && !requestToken) {
        requestToken = await clerk?.getToken() ?? undefined;
        if (!requestToken) {
          throw new ApiError(401, "Sign in to continue.");
        }
      }
      return await requestJson<T>(path, {
        ...options,
        token: requestToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request failure.";
      setConnection("error");
      setConnectionDetail(message);
      setNotice({ tone: "danger", message });
      throw error;
    }
  }, [clerk]);

  const run = useCallback(async <T,>(
    key: string,
    successMessage: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (busyAction) return undefined;
    setBusyAction(key);
    try {
      const result = await task();
      setLastResult(result);
      setNotice({ tone: "success", message: successMessage });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed.";
      setLastResult({ error: message });
      setNotice({ tone: "danger", message });
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }, [busyAction]);

  const refreshAll = useCallback(async () => {
    if (!authenticated) return;

    // The gateway asked us to slow down and we have not waited long enough yet. Retrying here is
    // what turns one 429 into a storm, because every failed refresh triggers another one.
    if (Date.now() < rateLimitedUntilRef.current) return;

    // A refresh is twelve requests. Overlapping refreshes multiply that against the rate limit for
    // no benefit, so coalesce instead: remember that another was asked for and run it once.
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;

    try {
      // allSettled, not all: one throttled endpoint must not discard the other good responses.
      const results = await Promise.allSettled([
        api<{ environments: Environment[] }>("/v1/t3/environments"),
        api<{ devices: Device[] }>("/v1/devices"),
        api<{ commands: Command[] }>("/v1/commands"),
        api<{ macros: Macro[] }>("/v1/macros"),
        api<{ privacy: { mediaRetentionDays: number | null } }>("/v1/settings/privacy"),
        api<{ media: MediaItem[] }>("/v1/media"),
        api<{ events: AuditEvent[] }>("/v1/audit"),
        api<{ display: DisplayState }>("/v1/display"),
        api<OnboardingResponse>("/v1/onboarding"),
        api<{ actions: SavedAction[] }>("/v1/actions"),
        api<{ remoteAccess: RemoteAccessStatus }>("/v1/settings/remote-access"),
        api<{ profiles: GatewayProfile[] }>("/v1/gateway-profiles"),
      ]);

      const [
        environmentResult, deviceResult, commandResult, macroResult, privacyResult,
        mediaResult, auditResult, displayResult, onboardingResult, actionsResult, remoteAccessResult,
        gatewayProfilesResult,
      ] = results;

      const valueOf = <T,>(result: PromiseSettledResult<T>): T | null =>
        result.status === "fulfilled" ? result.value : null;

      if (environmentResult.status === "fulfilled") {
        setEnvironments(dedupeEnvironments(environmentResult.value.environments ?? []));
      }
      if (deviceResult.status === "fulfilled") setDevices(deviceResult.value.devices ?? []);
      if (commandResult.status === "fulfilled") setCommands(commandResult.value.commands ?? []);
      if (macroResult.status === "fulfilled") setMacros(macroResult.value.macros ?? []);
      if (privacyResult.status === "fulfilled") {
        setPrivacyDays(privacyResult.value.privacy?.mediaRetentionDays ?? null);
      }
      if (mediaResult.status === "fulfilled") setMedia(mediaResult.value.media ?? []);
      if (auditResult.status === "fulfilled") {
        setAudit((auditResult.value.events ?? []).slice(-120).reverse());
      }
      if (displayResult.status === "fulfilled") setDisplay(displayResult.value.display ?? null);
      if (actionsResult.status === "fulfilled") setActions(actionsResult.value.actions ?? []);
      if (remoteAccessResult.status === "fulfilled") {
        setRemoteAccess(remoteAccessResult.value.remoteAccess ?? null);
      }
      if (gatewayProfilesResult.status === "fulfilled") {
        setGatewayProfiles(gatewayProfilesResult.value.profiles ?? []);
      }
      const onboardingValue = valueOf(onboardingResult);
      if (onboardingValue) {
        setOnboarding(onboardingValue.onboarding);
        setOnboardingReadiness(onboardingValue.readiness);
        setOnboardingLoaded(true);
      }

      const failures = results.filter((result) => result.status === "rejected");
      const throttled = failures
        .map((result) => (result as PromiseRejectedResult).reason)
        .find((reason) => reason instanceof ApiError && reason.status === 429) as ApiError | undefined;

      if (throttled) {
        // Honour retry-after; fall back to the window length the gateway uses.
        const waitMs = Math.max(1000, (throttled.retryAfterSeconds ?? 30) * 1000);
        rateLimitedUntilRef.current = Date.now() + waitMs;
        setConnection("reconnecting");
        setConnectionDetail(`Rate limited by the gateway; retrying in ${Math.ceil(waitMs / 1000)}s`);
        return;
      }

      // A session that has gone invalid must still surface, even from a partial refresh.
      const unauthorized = failures
        .map((result) => (result as PromiseRejectedResult).reason)
        .find((reason) => reason instanceof ApiError && (reason.status === 401 || reason.status === 403));
      if (unauthorized) throw unauthorized;

      if (failures.length === 0) {
        setConnection((current) => current === "live" ? "live" : "connected");
        setConnectionDetail("Gateway synchronized");
      }
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        // Let the current tick settle before draining the coalesced request.
        window.setTimeout(() => void refreshAllRef.current?.(), 0);
      }
    }
  }, [api, authenticated]);

  const loadRemoteAccess = useCallback(async (force = false) => {
    const result = await api<{ remoteAccess: RemoteAccessStatus }>(
      `/v1/settings/remote-access${force ? "?refresh=1" : ""}`,
    );
    setRemoteAccess(result.remoteAccess);
    return result.remoteAccess;
  }, [api]);

  // Lets the coalescing tail call the latest refreshAll without making it a dependency of itself.
  refreshAllRef.current = refreshAll;

  const refreshCommands = useCallback(async () => {
    if (!authenticated) return;
    const result = await api<{ commands: Command[] }>("/v1/commands");
    setCommands(result.commands ?? []);
  }, [api, authenticated]);

  const refreshMedia = useCallback(async () => {
    if (!authenticated) return;
    const result = await api<{ media: MediaItem[] }>("/v1/media");
    setMedia(result.media ?? []);
  }, [api, authenticated]);

  const clearSessionState = useCallback(() => {
    setConnection("signed-out");
    setConnectionDetail("Authentication required");
    setEnvironments([]);
    setProjects([]);
    setThreads([]);
    setDevices([]);
    setCommands([]);
    setMacros([]);
    setActions([]);
    setMedia([]);
    setAudit([]);
    setDisplay(null);
    setRemoteAccess(null);
    setGatewayProfiles([]);
    setOnboarding(null);
    setOnboardingReadiness(null);
    setOnboardingLoaded(false);
    setWorkspaceRecovery(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadProfiles() {
      try {
        const result = await requestJson<{ profiles: DeviceProfile[] }>("/v1/device-profiles", {
          auth: false,
        });
        if (!cancelled) setDeviceProfiles(result.profiles ?? []);
      } catch (error) {
        if (!cancelled) {
          setNotice({
            tone: "danger",
            message: error instanceof Error ? error.message : "Device profiles unavailable.",
          });
        }
      }
    }
    void loadProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!clerk?.loaded) return;
    if (!clerk.signedIn) {
      clearSessionState();
      return;
    }
    let cancelled = false;
    setConnection("connecting");
    setConnectionDetail("Authenticating Clerk session");
    refreshAll().catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        clearSessionState();
        setNotice({ tone: "danger", message: "Your Clerk session is no longer valid. Sign in again." });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [clearSessionState, clerk?.loaded, clerk?.signedIn, refreshAll]);

  useEffect(() => {
    if (!authenticated) return;
    const stream = new EventSource("/v1/events", { withCredentials: true });
    stream.addEventListener("connected", () => {
      setConnection("live");
      setConnectionDetail("Live event stream connected");
    });
    stream.addEventListener("heartbeat", () => {
      setConnection("live");
      setConnectionDetail("Live event stream connected");
    });
    stream.addEventListener("state.changed", (event) => {
      try {
        const payload = JSON.parse(event.data) as { summary?: { latestAction?: string } };
        setConnectionDetail(payload.summary?.latestAction ?? "State updated");
      } catch {
        setConnectionDetail("State updated");
      }
      setConnection("live");
      // Each refresh is nine requests, so debounce generously. Bursts of state.changed are
      // common (a poll tick, a heartbeat, a command update) and all we need is one refetch.
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        void refreshAll();
      }, 750);
    });
    stream.onerror = () => {
      setConnection("reconnecting");
      setConnectionDetail("Live stream reconnecting");
    };
    return () => {
      stream.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [authenticated, refreshAll]);

  useEffect(() => {
    if (environments.length === 0) {
      selectedEnvironmentIdRef.current = "";
      setSelectedEnvironmentIdState("");
      setProjects([]);
      setThreads([]);
      return;
    }
    if (!environments.some((environment) => environment.id === selectedEnvironmentId)) {
      selectedEnvironmentIdRef.current = environments[0].id;
      setSelectedEnvironmentIdState(environments[0].id);
    }
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    if (devices.length === 0) {
      setSelectedDeviceId("");
      return;
    }
    if (!devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || !authenticated) return;
    let cancelled = false;
    api<{ config: DeviceConfig }>(`/v1/devices/${encodeURIComponent(selectedDeviceId)}/config`)
      .then((result) => {
        if (!cancelled) {
          setDeviceConfig({
            environmentId: result.config.environmentId ?? null,
            threadId: result.config.threadId ?? null,
            gatewayAccessMode: result.config.gatewayAccessMode ?? "local",
            gatewayUrl: result.config.gatewayUrl ?? null,
            defaultPrompt: result.config.defaultPrompt ?? "",
            shellCommand: result.config.shellCommand ?? "npm test",
            menu: result.config.menu ?? [],
          });
        }
      })
      .catch(() => {
        // The global request surface already presents the error.
      });
    return () => {
      cancelled = true;
    };
  }, [api, authenticated, selectedDeviceId]);

  const setSelectedEnvironmentId = useCallback((environmentId: string) => {
    selectedEnvironmentIdRef.current = environmentId;
    selectedProjectIdRef.current = "";
    selectedThreadIdRef.current = "";
    snapshotRequestRef.current += 1;
    harnessRequestRef.current += 1;
    setSelectedEnvironmentIdState(environmentId);
    setProjects([]);
    setThreads([]);
    setHarnessCatalogue(null);
    setSelectedProjectIdState("");
    setSelectedThreadIdState("");
  }, []);

  const setSelectedProjectId = useCallback((projectId: string) => {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectIdState(projectId);
    const selectedThread = threads.find((thread) => thread.id === selectedThreadIdRef.current);
    if (selectedThread?.projectId === projectId) return;
    const nextThreadId = threads.find((thread) => thread.projectId === projectId)?.id ?? "";
    selectedThreadIdRef.current = nextThreadId;
    setSelectedThreadIdState(nextThreadId);
  }, [threads]);

  const setSelectedThreadId = useCallback((threadId: string) => {
    selectedThreadIdRef.current = threadId;
    setSelectedThreadIdState(threadId);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread?.projectId) {
      selectedProjectIdRef.current = thread.projectId;
      setSelectedProjectIdState(thread.projectId);
    }
  }, [threads]);

  // The agent harnesses and models this environment can actually launch. Kept separate from the
  // snapshot because a failure here must not stop projects and threads from loading.
  const loadHarnesses = useCallback(async (environmentId = selectedEnvironmentId) => {
    if (!environmentId) return null;
    const requestId = ++harnessRequestRef.current;
    try {
      const result = await api<T3HarnessCatalogue>(
        `/v1/t3/environments/${encodeURIComponent(environmentId)}/harnesses`,
      );
      if (requestId === harnessRequestRef.current
        && selectedEnvironmentIdRef.current === environmentId) {
        setHarnessCatalogue(result);
      }
      return result;
    } catch {
      if (requestId === harnessRequestRef.current
        && selectedEnvironmentIdRef.current === environmentId) {
        setHarnessCatalogue(null);
      }
      return null;
    }
  }, [api, selectedEnvironmentId]);

  const loadSnapshot = useCallback(async (environmentId = selectedEnvironmentId) => {
    if (!environmentId) throw new Error("Select a T3 environment first.");
    const requestId = ++snapshotRequestRef.current;
    const harnessRequest = loadHarnesses(environmentId);
    let result: {
      environment: Environment;
      snapshot?: { projects?: JsonRecord[]; threads?: JsonRecord[] };
      screen?: unknown;
    };
    try {
      result = await api<typeof result>(
        `/v1/t3/environments/${encodeURIComponent(environmentId)}/snapshot`,
      );
      setWorkspaceRecovery(null);
    } catch (error) {
      if (isT3SnapshotUnavailableError(error)) {
        setWorkspaceRecovery({ environmentId, message: T3_SNAPSHOT_UNAVAILABLE_MESSAGE });
      }
      throw error;
    }
    await harnessRequest;
    if (requestId !== snapshotRequestRef.current
      || selectedEnvironmentIdRef.current !== environmentId) {
      return result;
    }
    const nextProjects = (result.snapshot?.projects ?? [])
      .filter((project): project is JsonRecord => typeof project?.id === "string")
      .map((project) => project as unknown as T3Project);
    const nextThreads = (result.snapshot?.threads ?? [])
      .map((thread) => normalizeThread(thread, nextProjects))
      .filter((thread): thread is T3Thread => Boolean(thread));
    const preservedThread = nextThreads.find((thread) => thread.id === selectedThreadIdRef.current) ?? null;
    const preservedProject = nextProjects.find((project) => project.id === selectedProjectIdRef.current) ?? null;
    const nextProjectId = preservedThread?.projectId
      ?? preservedProject?.id
      ?? nextProjects[0]?.id
      ?? nextThreads[0]?.projectId
      ?? "";
    const nextThreadId = preservedThread?.id
      ?? nextThreads.find((thread) => thread.projectId === nextProjectId)?.id
      ?? nextThreads[0]?.id
      ?? "";
    const synchronizedProjectId = nextThreads.find((thread) => thread.id === nextThreadId)?.projectId
      ?? nextProjectId;
    setProjects(nextProjects);
    setThreads(nextThreads);
    selectedProjectIdRef.current = synchronizedProjectId;
    selectedThreadIdRef.current = nextThreadId;
    setSelectedProjectIdState(synchronizedProjectId);
    setSelectedThreadIdState(nextThreadId);
    return result;
  }, [api, loadHarnesses, selectedEnvironmentId]);

  const dismissWorkspaceRecovery = useCallback(() => {
    setWorkspaceRecovery(null);
    setNotice((current) => current?.message === T3_SNAPSHOT_UNAVAILABLE_MESSAGE ? null : current);
  }, []);

  const launchProject = useCallback(async (input: {
    projectId: string;
    text: string;
    modelSelection?: ModelSelection;
  }) => {
    if (!selectedEnvironmentId) throw new Error("Select a T3 environment first.");
    const result = await api<{
      threadId: string;
      command: Command;
      modelSelection: ModelSelection;
      modelRecovery?: ModelRecovery | null;
    }>(
      `/v1/t3/environments/${encodeURIComponent(selectedEnvironmentId)}/threads`,
      {
        method: "POST",
        body: input,
      },
    );
    selectedThreadIdRef.current = result.threadId;
    setSelectedThreadIdState(result.threadId);
    await loadSnapshot(selectedEnvironmentId);
    await refreshCommands();
    return result;
  }, [api, loadSnapshot, refreshCommands, selectedEnvironmentId]);

  const loadCommandTimeline = useCallback(async (command: Command) => {
    const result = await api<{ command: Command; events: CommandEvent[] }>(
      `/v1/commands/${encodeURIComponent(command.id)}/events`,
    );
    setTimelineCommand(result.command);
    setCommandEvents(result.events ?? []);
    return result;
  }, [api]);

  const saveOnboarding = useCallback(async (input: Partial<OnboardingState>) => {
    const result = await api<OnboardingResponse>("/v1/onboarding", {
      method: "PUT",
      body: input,
    });
    setOnboarding(result.onboarding);
    setOnboardingReadiness(result.readiness);
    return result;
  }, [api]);

  const signOut = useCallback(async () => {
    if (clerk?.signedIn) await clerk.signOut();
    clearSessionState();
    setNotice({ tone: "info", message: "Signed out of the gateway." });
  }, [clearSessionState, clerk]);

  const downloadDiagnostics = useCallback(async () => {
    const bundle = await api<unknown>("/v1/support/diagnostics");
    downloadJson(
      `agent-controller-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json`,
      bundle,
    );
    setLastResult(bundle);
    setNotice({ tone: "success", message: "Redacted diagnostics downloaded." });
  }, [api]);

  const pendingApprovals = useMemo(
    () => commands.filter((command) => command.status === "approval_required").slice(-12).reverse(),
    [commands],
  );
  const recentCommands = useMemo(() => commands.slice(-24).reverse(), [commands]);
  const selectedEnvironment = useMemo(
    () => environments.find((environment) => environment.id === selectedEnvironmentId) ?? null,
    [environments, selectedEnvironmentId],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const approvalNotifications = useApprovalNotifications(pendingApprovals);

  return {
    ...approvalNotifications,
    authConfig,
    clerk,
    authenticated,
    connection,
    connectionDetail,
    busyAction,
    notice,
    setNotice,
    workspaceRecovery,
    dismissWorkspaceRecovery,
    lastResult,
    setLastResult,
    deviceProfiles,
    environments,
    projects,
    threads,
    harnesses: harnessCatalogue?.harnesses ?? [],
    harnessCatalogueSource: harnessCatalogue?.catalogueSource ?? null,
    sessionFailures: harnessCatalogue?.sessionFailures ?? [],
    suggestedModelSelection: harnessCatalogue?.modelSelection ?? null,
    loadHarnesses,
    devices,
    commands,
    pendingApprovals,
    recentCommands,
    commandEvents,
    timelineCommand,
    macros,
    actions,
    media,
    audit,
    display,
    privacyDays,
    setPrivacyDays,
    remoteAccess,
    gatewayProfiles,
    loadRemoteAccess,
    deviceSecret,
    setDeviceSecret,
    onboarding,
    onboardingReadiness,
    onboardingLoaded,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    selectedEnvironment,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    selectedThreadId,
    setSelectedThreadId,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedDevice,
    deviceConfig,
    setDeviceConfig,
    api,
    run,
    refreshAll,
    refreshCommands,
    refreshMedia,
    loadSnapshot,
    launchProject,
    loadCommandTimeline,
    saveOnboarding,
    signOut,
    clearSessionState,
    downloadDiagnostics,
  };
}

export type Controller = ReturnType<typeof useController>;
