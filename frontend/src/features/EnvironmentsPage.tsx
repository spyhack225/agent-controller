import {
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  CloudCog,
  FolderGit2,
  Globe2,
  KeyRound,
  Link2,
  Network,
  RefreshCw,
  Router,
  Save,
  Server,
  ShieldCheck,
  Users,
  Wifi,
  Unplug,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Controller } from "../controller";
import { formatRelativeTime } from "../format";
import type { Device, Environment, GatewayProfile, RemoteAccessStatus } from "../types";
import { Button, Field, StatusBadge, cn, type StatusTone, useConfirm } from "../ui";

interface EnvironmentsPageProps {
  controller: Controller;
  connectOpen?: boolean;
  onConnectOpenChange?: (open: boolean) => void;
}

type CredentialType = "pairingToken" | "accessToken";
type EnvironmentTab = "connection" | "gateways" | "credential" | "health" | "workspace";
type EnvironmentAccessMode = "local" | "tailscale" | "online";

interface EnvironmentGateway {
  id: string;
  profileId: string | null;
  mode: EnvironmentAccessMode;
  label: string;
  url: string | null;
  users: Device[];
  detected: boolean;
}

const environmentAccessOptions: Array<{
  id: EnvironmentAccessMode;
  label: string;
  description: string;
  icon: typeof Network;
}> = [
  {
    id: "local",
    label: "Local / LAN",
    description: "Reach T3 on this computer or a trusted local network.",
    icon: Network,
  },
  {
    id: "tailscale",
    label: "Tailscale",
    description: "Private HTTPS access across your Tailnet. Recommended.",
    icon: ShieldCheck,
  },
  {
    id: "online",
    label: "Online HTTPS",
    description: "Connect through a secured public tunnel or reverse proxy.",
    icon: Globe2,
  },
];

function environmentAccessLabel(mode: EnvironmentAccessMode) {
  return environmentAccessOptions.find((option) => option.id === mode)?.label ?? "Local / LAN";
}

function environmentUrlPlaceholder(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "https://machine.tailnet.ts.net";
  if (mode === "online") return "https://t3.example.com";
  return "http://127.0.0.1:3773";
}

function inferEnvironmentAccessMode(baseUrl: string): EnvironmentAccessMode {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith(".ts.net")) return "tailscale";
    if (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname.endsWith(".local")
      || /^10\./u.test(hostname)
      || /^192\.168\./u.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)
    ) return "local";
    return parsed.protocol === "https:" ? "online" : "local";
  } catch {
    return "local";
  }
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function environmentUrlValid(value: string, mode: EnvironmentAccessMode) {
  if (!isHttpUrl(value)) return false;
  if (mode === "local") return true;
  return new URL(value.trim()).protocol === "https:";
}

function credentialExpired(environment: Environment): boolean {
  return Boolean(
    environment.status === "token_expired"
    || (environment.accessTokenExpiresAt && Date.parse(environment.accessTokenExpiresAt) <= Date.now()),
  );
}

function environmentStatus(environment: Environment): { label: string; tone: StatusTone } {
  if (credentialExpired(environment)) return { label: "token expired", tone: "danger" };
  if (environment.status === "reachable") return { label: "reachable", tone: "success" };
  if (environment.status === "unreachable" || environment.health?.lastError) {
    return { label: "unreachable", tone: "danger" };
  }
  if (environment.health?.lastReachableAt) return { label: "not checked", tone: "warning" };
  return { label: environment.status ?? "unchecked", tone: "neutral" };
}

function gatewayLabel(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "Tailscale gateway";
  if (mode === "online") return "Online gateway";
  return "Local / LAN gateway";
}

function normalizeGatewayUrl(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/u, "") || null;
}

function inferredDeviceGatewayMode(device: Device): EnvironmentAccessMode {
  return device.config?.gatewayAccessMode
    ?? inferEnvironmentAccessMode(device.config?.gatewayUrl ?? "");
}

function gatewayModeFromProfile(profile: GatewayProfile): EnvironmentAccessMode {
  if (profile.mode === "tailnet") return "tailscale";
  if (profile.mode === "custom") return "online";
  return "local";
}

export function environmentGatewayInventory(
  environmentId: string,
  devices: Device[],
  profiles: GatewayProfile[],
  remoteAccess: RemoteAccessStatus | null,
): EnvironmentGateway[] {
  const gateways = new Map<string, EnvironmentGateway>();
  const detectedUrls = new Set([
    ...(remoteAccess?.gateway.lanUrls ?? []),
    ...(remoteAccess?.gateway.loopbackUrl ? [remoteAccess.gateway.loopbackUrl] : []),
    ...(remoteAccess?.tailscale.ready && remoteAccess.tailscale.httpsUrl ? [remoteAccess.tailscale.httpsUrl] : []),
    ...(remoteAccess?.gateway.publicBaseUrl ? [remoteAccess.gateway.publicBaseUrl] : []),
  ].map((url) => normalizeGatewayUrl(url)?.toLowerCase()).filter(Boolean));
  const addGateway = ({
    id,
    profileId = null,
    mode,
    label,
    url,
    device,
    detected = false,
  }: {
    id?: string;
    profileId?: string | null;
    mode: EnvironmentAccessMode;
    label?: string;
    url?: string | null;
    device?: Device;
    detected?: boolean;
  }) => {
    const normalizedUrl = normalizeGatewayUrl(url);
    const gatewayId = id ?? normalizedUrl?.toLowerCase() ?? `device-managed:${mode}`;
    const existing = gateways.get(gatewayId) ?? {
      id: gatewayId,
      profileId,
      mode,
      label: label ?? gatewayLabel(mode),
      url: normalizedUrl,
      users: [],
      detected: false,
    };
    if (device && !existing.users.some((candidate) => candidate.id === device.id)) {
      existing.users.push(device);
    }
    existing.detected ||= detected;
    gateways.set(gatewayId, existing);
  };

  for (const profile of profiles) {
    const normalizedUrl = normalizeGatewayUrl(profile.baseUrl);
    addGateway({
      id: `profile:${profile.id}`,
      profileId: profile.id,
      mode: gatewayModeFromProfile(profile),
      label: profile.label,
      url: normalizedUrl,
      detected: Boolean(normalizedUrl && detectedUrls.has(normalizedUrl.toLowerCase())),
    });
  }

  for (const device of devices) {
    if (device.revokedAt || device.config?.environmentId !== environmentId) continue;
    const activeProfileId = device.gatewaySelection?.activeProfileId;
    if (activeProfileId && gateways.has(`profile:${activeProfileId}`)) {
      addGateway({
        id: `profile:${activeProfileId}`,
        profileId: activeProfileId,
        mode: gateways.get(`profile:${activeProfileId}`)?.mode ?? "local",
        device,
      });
      continue;
    }
    addGateway({
      mode: inferredDeviceGatewayMode(device),
      url: device.config?.gatewayUrl,
      device,
      label: activeProfileId ? "Unavailable gateway profile" : undefined,
    });
  }

  return [...gateways.values()].sort((left, right) => {
    const activeDifference = Number(right.users.length > 0) - Number(left.users.length > 0);
    if (activeDifference) return activeDifference;
    const modeOrder: Record<EnvironmentAccessMode, number> = { local: 0, tailscale: 1, online: 2 };
    return modeOrder[left.mode] - modeOrder[right.mode] || (left.url ?? "").localeCompare(right.url ?? "");
  });
}

export function EnvironmentsPage({
  controller: c,
  connectOpen = false,
  onConnectOpenChange,
}: EnvironmentsPageProps) {
  const confirm = useConfirm();
  const [internalConnectOpen, setInternalConnectOpen] = useState(false);
  const [editingEnvironment, setEditingEnvironment] = useState<Environment | null>(null);
  const activeConnectOpen = onConnectOpenChange ? connectOpen : internalConnectOpen;

  useEffect(() => {
    if (!editingEnvironment) return;
    const current = c.environments.find((environment) => environment.id === editingEnvironment.id);
    if (!current) setEditingEnvironment(null);
    else if (current !== editingEnvironment) setEditingEnvironment(current);
  }, [c.environments, editingEnvironment?.id]);

  const setConnectOpen = (open: boolean) => {
    if (onConnectOpenChange) onConnectOpenChange(open);
    else setInternalConnectOpen(open);
  };

  const openEnvironment = (environment: Environment) => {
    c.setSelectedEnvironmentId(environment.id);
    setEditingEnvironment(environment);
  };

  const checkEnvironment = async (environment: Environment) => {
    await c.run(`check-environment-${environment.id}`, "Reachability check complete.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/check`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const loadSnapshot = async (environment: Environment, closeEditor = false) => {
    c.setSelectedEnvironmentId(environment.id);
    if (closeEditor) setEditingEnvironment(null);
    await c.run(`environment-snapshot-${environment.id}`, "Workspace snapshot loaded.", () => c.loadSnapshot(environment.id));
  };

  const unpairEnvironment = async (environment: Environment) => {
    const accepted = await confirm({
      title: `Unpair ${environment.label}?`,
      description: "Devices using this environment will have their default environment cleared. Stored access credentials will be removed.",
      confirmLabel: "Unpair environment",
    });
    if (!accepted) return;
    await c.run("unpair-environment", "Environment unpaired.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, { method: "DELETE" });
      setEditingEnvironment(null);
      await c.refreshAll();
      return result;
    });
  };

  return (
    <div className="environments-workspace">
      <section className="environments-overview" aria-labelledby="environments-heading">
        <div>
          <p className="eyebrow">T3 control plane</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="environments-heading" className="font-display text-xl font-semibold tracking-[-0.025em]">
              {c.environments.length ? "Connected environments" : "Connect your first environment"}
            </h2>
            {c.environments.length ? <StatusBadge label={`${c.environments.length} paired`} /> : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            {c.environments.length
              ? "Reachability, credentials, and live T3 workspace state across every paired host."
              : "Pair the workstation where T3 Code runs to load projects and dispatch agent work."}
          </p>
        </div>
      </section>

      <EnvironmentActionCluster className="environments-mobile-actions" onConnect={() => setConnectOpen(true)} />

      {c.environments.length ? (
        <section className="environment-grid" aria-label="T3 environment inventory">
          {c.environments.map((environment) => (
            <EnvironmentTile
              key={environment.id}
              environment={environment}
              gateways={environmentGatewayInventory(environment.id, c.devices ?? [], c.gatewayProfiles ?? [], c.remoteAccess ?? null)}
              busyAction={c.busyAction}
              onOpen={() => openEnvironment(environment)}
              onCheck={() => void checkEnvironment(environment)}
              onLoad={() => void loadSnapshot(environment)}
            />
          ))}
        </section>
      ) : (
        <section className="devices-empty environment-empty" aria-labelledby="empty-environments-title">
          <div className="devices-empty__signal environment-empty__signal" aria-hidden="true">
            <span />
            <Network className="size-6" />
          </div>
          <p className="eyebrow">No T3 hosts paired</p>
          <h3 id="empty-environments-title" className="font-display text-xl font-semibold">Where does your agent work run?</h3>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
            Connect a local workstation, Tailnet host, or secured tunnel endpoint. Credentials stay encrypted and are never returned by the API.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setConnectOpen(true)}><Cable className="size-4" /> Connect T3 Code</Button>
            <span className="environment-empty__hint"><ShieldCheck className="size-3.5" /> Encrypted at rest</span>
          </div>
        </section>
      )}

      <ConnectEnvironmentDialog
        controller={c}
        open={activeConnectOpen}
        onClose={() => setConnectOpen(false)}
      />

      <EnvironmentEditorDialog
        controller={c}
        environment={editingEnvironment}
        onClose={() => setEditingEnvironment(null)}
        onCheck={() => editingEnvironment && void checkEnvironment(editingEnvironment)}
        onLoad={() => editingEnvironment && void loadSnapshot(editingEnvironment, true)}
        onUnpair={() => editingEnvironment && void unpairEnvironment(editingEnvironment)}
      />
    </div>
  );
}

export function EnvironmentActionCluster({
  onConnect,
  className,
}: {
  onConnect: () => void;
  className?: string;
}) {
  return (
    <div className={cn("environment-action-cluster", className)}>
      <Button size="sm" variant="primary" onClick={onConnect}><Cable className="size-3.5" /> Connect environment</Button>
    </div>
  );
}

function EnvironmentTile({
  environment,
  gateways,
  busyAction,
  onOpen,
  onCheck,
  onLoad,
}: {
  environment: Environment;
  gateways: EnvironmentGateway[];
  busyAction: string | null;
  onOpen: () => void;
  onCheck: () => void;
  onLoad: () => void;
}) {
  const status = environmentStatus(environment);
  const stop = (callback: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    callback();
  };
  return (
    <article className="device-tile environment-tile" onClick={onOpen}>
      <button type="button" className="device-tile__header" aria-label={`Edit ${environment.label}`} onClick={stop(onOpen)}>
        <div className="device-tile__glyph environment-tile__glyph"><Server className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate font-display text-base font-semibold">{environment.label}</h3>
            <StatusBadge tone={status.tone} label={status.label} />
          </div>
          <p className="mt-1 truncate text-xs text-ink-muted">{environment.baseUrl}</p>
        </div>
        <ArrowRight className="device-tile__open size-4" />
      </button>

      <dl className="device-tile__metrics environment-tile__metrics">
        <EnvironmentMetric label="Last checked" value={formatRelativeTime(environment.health?.lastCheckedAt)} />
        <EnvironmentMetric label="Last reachable" value={formatRelativeTime(environment.health?.lastReachableAt)} />
        <EnvironmentMetric
          label="Credential"
          value={environment.accessTokenExpiresAt ? formatRelativeTime(environment.accessTokenExpiresAt) : "No known expiry"}
          tone={credentialExpired(environment) ? "danger" : undefined}
        />
        <EnvironmentMetric label="Snapshot age" value={formatRelativeTime(environment.health?.lastCheckedAt)} />
        <EnvironmentMetric label="Projects" value={environment.health?.snapshot?.line1 ?? "Not loaded"} />
        <EnvironmentMetric label="Sessions" value={environment.health?.snapshot?.line2 ?? "Not loaded"} />
      </dl>

      {environment.health?.lastError ? (
        <p className="environment-tile__error" title={environment.health.lastError}>{environment.health.lastError}</p>
      ) : null}

      <EnvironmentGatewaySummary gateways={gateways} />

      <div className="device-tile__actions environment-tile__actions">
        <Button
          size="sm"
          busy={busyAction === `environment-snapshot-${environment.id}`}
          onClick={stop(onLoad)}
        >
          <CloudCog className="size-3.5" /> Load snapshot
        </Button>
        <Button
          size="sm"
          busy={busyAction === `check-environment-${environment.id}`}
          onClick={stop(onCheck)}
        >
          <RefreshCw className="size-3.5" /> Check
        </Button>
      </div>
    </article>
  );
}

function GatewayIcon({ mode, className }: { mode: EnvironmentAccessMode; className?: string }) {
  const Icon = mode === "tailscale" ? ShieldCheck : mode === "online" ? Globe2 : Router;
  return <Icon className={className} />;
}

function gatewayUsersLabel(users: Device[]) {
  if (!users.length) return "No devices assigned";
  if (users.length === 1) return users[0].label;
  const visible = users.slice(0, 2).map((device) => device.label).join(", ");
  return users.length > 2 ? `${visible} +${users.length - 2}` : visible;
}

function EnvironmentGatewaySummary({ gateways }: { gateways: EnvironmentGateway[] }) {
  const activeCount = gateways.filter((gateway) => gateway.users.length > 0).length;
  const visibleGateways = gateways.slice(0, 3);
  return (
    <section className="environment-tile__gateways" aria-label="Controller gateways">
      <div className="environment-tile__gateways-heading">
        <span><Router className="size-3.5" /> Controller gateways</span>
        <strong>{activeCount ? `${activeCount} active` : "None active"}</strong>
      </div>
      {visibleGateways.length ? (
        <div className="environment-tile__gateway-list">
          {visibleGateways.map((gateway) => (
            <div key={gateway.id} className="environment-tile__gateway" data-active={gateway.users.length > 0 || undefined}>
              <GatewayIcon mode={gateway.mode} className="size-3.5" />
              <div>
                <strong>{gateway.label}</strong>
                <span title={gatewayUsersLabel(gateway.users)}>{gatewayUsersLabel(gateway.users)}</span>
              </div>
              <small>{gateway.users.length ? "Active" : gateway.detected ? "Available" : "Not detected"}</small>
            </div>
          ))}
          {gateways.length > visibleGateways.length ? (
            <p className="environment-tile__gateway-more">+{gateways.length - visibleGateways.length} more in details</p>
          ) : null}
        </div>
      ) : (
        <p className="environment-tile__gateway-empty">No gateway endpoints or attached devices detected.</p>
      )}
    </section>
  );
}

function EnvironmentMetric({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" }) {
  return (
    <div className="device-tile__metric">
      <dt>{label}</dt>
      <dd className={tone === "danger" ? "text-danger" : undefined}>{value}</dd>
    </div>
  );
}

function ConnectEnvironmentDialog({
  controller: c,
  open,
  onClose,
}: {
  controller: Controller;
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState("Mac T3 Code");
  const [baseUrl, setBaseUrl] = useState("");
  const [accessMode, setAccessMode] = useState<EnvironmentAccessMode>("local");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("pairingToken");
  const [result, setResult] = useState<Environment | null>(null);
  const steps = ["Purpose", "Access", "Endpoint", "Credential", "Review"];

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setLabel("Mac T3 Code");
    setBaseUrl("");
    setAccessMode("local");
    setCredential("");
    setCredentialType("pairingToken");
    setResult(null);
  }, [open]);

  if (!open) return null;
  const canContinue = step === 2
    ? Boolean(label.trim() && environmentUrlValid(baseUrl, accessMode))
    : step === 3
      ? Boolean(credential.trim())
      : true;

  const connect = async () => {
    const created = await c.run("pair-environment", "T3 environment connected.", async () => {
      const response = await c.api<{ environment: Environment }>("/v1/t3/environments", {
        method: "POST",
        body: {
          label: label.trim() || "T3 Code",
          baseUrl: baseUrl.trim(),
          [credentialType]: credential.trim(),
        },
      });
      setCredential("");
      await c.refreshAll();
      c.setSelectedEnvironmentId(response.environment.id);
      return response;
    });
    if (created) setResult(created.environment);
  };

  return (
    <EnvironmentModalShell
      open
      title={result ? "Environment connected" : "Connect T3 Code"}
      eyebrow={result ? "Connection ready" : "Environment onboarding"}
      description={result ? result.baseUrl : "Pair the host that owns your projects and agent sessions."}
      onClose={onClose}
      footer={result ? (
        <Button variant="primary" onClick={onClose}><Check className="size-4" /> Done</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={step === 0 ? onClose : () => setStep((current) => current - 1)}>
            {step === 0 ? "Cancel" : <><ArrowLeft className="size-4" /> Back</>}
          </Button>
          <Button
            variant="primary"
            busy={c.busyAction === "pair-environment"}
            disabled={!canContinue}
            onClick={() => step === steps.length - 1 ? void connect() : setStep((current) => current + 1)}
          >
            {step === steps.length - 1 ? "Connect environment" : "Continue"}
            {step < steps.length - 1 ? <ArrowRight className="size-4" /> : null}
          </Button>
        </>
      )}
    >
      {result ? (
        <div className="device-flow__result">
          <div className="device-flow__result-check"><Check className="size-6" /></div>
          <h3>Host paired successfully</h3>
          <p>Agent Controller can now health-check this host and load its T3 projects and sessions.</p>
          <dl>
            <EnvironmentReviewRow label="Environment" value={result.label} />
            <EnvironmentReviewRow label="Environment ID" value={result.id} mono />
            <EnvironmentReviewRow label="Access path" value={environmentAccessLabel(accessMode)} />
            <EnvironmentReviewRow label="Endpoint" value={result.baseUrl} mono />
          </dl>
        </div>
      ) : (
        <>
          <EnvironmentStepper steps={steps} current={step} />
          <div className="device-flow__body">
            {step === 0 ? <EnvironmentIntro /> : null}
            {step === 1 ? (
              <div className="environment-flow__access">
                <div>
                  <h3 className="font-display text-base font-semibold">Choose how the gateway reaches T3</h3>
                  <p className="mt-1 text-sm text-ink-muted">The access path controls who can reach the host and which endpoint you enter next.</p>
                </div>
                <EnvironmentAccessSelector value={accessMode} onChange={setAccessMode} />
                <EnvironmentAccessGuidance mode={accessMode} controller={c} />
              </div>
            ) : null}
            {step === 2 ? (
              <div className="environment-flow__form">
                <div>
                  <h3 className="font-display text-base font-semibold">Identify the T3 host</h3>
                  <p className="mt-1 text-sm text-ink-muted">Use a label operators recognize and the {environmentAccessLabel(accessMode).toLowerCase()} endpoint this gateway can reach.</p>
                </div>
                <Field label="Environment label" htmlFor="connect-environment-label">
                  <input id="connect-environment-label" autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
                </Field>
                <Field label="T3 base URL" htmlFor="connect-environment-url" hint={environmentEndpointHint(accessMode)}>
                  <input id="connect-environment-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={environmentUrlPlaceholder(accessMode)} />
                </Field>
                <EnvironmentAccessSummary mode={accessMode} />
              </div>
            ) : null}
            {step === 3 ? (
              <div className="environment-flow__form">
                <div>
                  <h3 className="font-display text-base font-semibold">Authenticate the connection</h3>
                  <p className="mt-1 text-sm text-ink-muted">Pairing tokens are exchanged for scoped access. Existing access tokens are stored directly.</p>
                </div>
                <CredentialSwitcher value={credentialType} onChange={setCredentialType} />
                <Field
                  label={credentialType === "pairingToken" ? "Pairing token" : "Access token"}
                  htmlFor="connect-environment-token"
                  hint="The credential is encrypted at rest and never returned by the API."
                >
                  <textarea
                    id="connect-environment-token"
                    autoFocus
                    className="font-mono"
                    rows={4}
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    placeholder="Paste credential"
                  />
                </Field>
              </div>
            ) : null}
            {step === 4 ? (
              <div className="device-flow__review">
                <div>
                  <p className="eyebrow">Confirm connection</p>
                  <h3 className="font-display text-lg font-semibold">Pair {label}</h3>
                  <p className="mt-1 text-sm text-ink-muted">After saving, use Check to verify that the gateway can reach this endpoint.</p>
                </div>
                <dl>
                  <EnvironmentReviewRow label="Label" value={label} />
                  <EnvironmentReviewRow label="Access path" value={environmentAccessLabel(accessMode)} />
                  <EnvironmentReviewRow label="Endpoint" value={baseUrl} mono />
                  <EnvironmentReviewRow label="Credential" value={credentialType === "pairingToken" ? "Pairing token" : "Access token"} />
                  <EnvironmentReviewRow label="Storage" value="Encrypted at rest" />
                </dl>
              </div>
            ) : null}
          </div>
        </>
      )}
    </EnvironmentModalShell>
  );
}

function EnvironmentAccessSelector({
  value,
  onChange,
}: {
  value: EnvironmentAccessMode;
  onChange: (value: EnvironmentAccessMode) => void;
}) {
  return (
    <div className="environment-access-grid" role="radiogroup" aria-label="Access path">
      {environmentAccessOptions.map((option) => {
        const Icon = option.icon;
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="environment-access-card"
            data-active={selected || undefined}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
          >
            <span className="environment-access-card__icon"><Icon className="size-4" /></span>
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function EnvironmentAccessGuidance({ mode, controller: c }: { mode: EnvironmentAccessMode; controller: Controller }) {
  if (mode === "tailscale") {
    const tailscale = c.remoteAccess?.tailscale;
    const gatewayReady = Boolean(tailscale?.connected);
    return (
      <section className="environment-access-guide" data-tone={gatewayReady ? "success" : "info"} aria-label="Tailscale setup">
        <div className="environment-access-guide__heading">
          <ShieldCheck className="size-4" />
          <div>
            <strong>Private Tailnet access</strong>
            <span>{gatewayReady ? `This gateway is connected${tailscale?.dnsName ? ` as ${tailscale.dnsName}` : ""}.` : "Connect this gateway and the T3 host to the same Tailnet."}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            busy={c.busyAction === "refresh-environment-tailscale"}
            onClick={() => void c.run(
              "refresh-environment-tailscale",
              "Tailscale status refreshed.",
              () => c.loadRemoteAccess(true),
            )}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
        <p>On the T3 host, generate a private HTTPS URL and one-time pairing credential:</p>
        <CopyableSyntax value="npx t3 pair --tailscale" label="Tailscale command" />
        <small>Tailscale Serve keeps the endpoint private to authorized Tailnet members.</small>
      </section>
    );
  }

  if (mode === "online") {
    return (
      <section className="environment-access-guide" data-tone="warning" aria-label="Online access guidance">
        <div className="environment-access-guide__heading">
          <Globe2 className="size-4" />
          <div>
            <strong>Public internet endpoint</strong>
            <span>Use an existing HTTPS tunnel or reverse proxy that terminates TLS.</span>
          </div>
        </div>
        <p>Expose only the T3 endpoint, keep token authentication enabled, and restrict ingress at the tunnel or proxy whenever possible.</p>
        <CopyableSyntax value="https://t3.example.com" label="HTTPS endpoint example" />
        <small>Never enter a plain HTTP URL for an internet-accessible host.</small>
      </section>
    );
  }

  return (
    <section className="environment-access-guide" data-tone="neutral" aria-label="Local network guidance">
      <div className="environment-access-guide__heading">
        <Wifi className="size-4" />
        <div>
          <strong>Direct network access</strong>
          <span>Best when Agent Controller can already reach the T3 host.</span>
        </div>
      </div>
      <p>Use loopback when both services share a computer, or the host's private IP on a trusted LAN.</p>
      <CopyableSyntax value="http://127.0.0.1:3773" label="local endpoint" />
    </section>
  );
}

function CopyableSyntax({ value, label }: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [value]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const feedback = copyState === "copied" ? "Copied" : copyState === "error" ? "Try again" : "Copy";
  return (
    <div className="environment-access-guide__syntax">
      <code>{value}</code>
      <button
        type="button"
        data-state={copyState}
        aria-label={`${feedback} ${label}`}
        onClick={() => void copy()}
      >
        {copyState === "copied" ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
        <span aria-live="polite">{feedback}</span>
      </button>
    </div>
  );
}

function EnvironmentAccessSummary({ mode }: { mode: EnvironmentAccessMode }) {
  const Icon = mode === "tailscale" ? ShieldCheck : mode === "online" ? Globe2 : Wifi;
  return (
    <div className="environment-access-summary">
      <Icon className="size-4" />
      <div>
        <strong>{environmentAccessLabel(mode)}</strong>
        <span>{mode === "tailscale" ? "Private HTTPS over your Tailnet" : mode === "online" ? "Public HTTPS with token authentication" : "Direct host or trusted LAN connection"}</span>
      </div>
    </div>
  );
}

function environmentEndpointHint(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "Paste the HTTPS MagicDNS URL printed by T3.";
  if (mode === "online") return "HTTPS is required for an internet-accessible endpoint.";
  return "Use loopback or a private LAN address reachable by this gateway.";
}

function EnvironmentIntro() {
  return (
    <div className="device-flow__intro">
      <div className="device-flow__hero-icon"><Server className="size-6" /></div>
      <StatusBadge tone="info" label="Scoped T3 access" />
      <h3>Connect the machine where T3 Code runs</h3>
      <p>The gateway uses this connection to discover projects, load sessions, and dispatch approved agent work.</p>
      <ul>
        <li><CheckCircle2 className="size-4" /> Supports local, Tailnet, and tunnel endpoints</li>
        <li><CheckCircle2 className="size-4" /> Encrypts the resulting access token at rest</li>
        <li><CheckCircle2 className="size-4" /> Tracks reachability and credential expiry</li>
      </ul>
    </div>
  );
}

function CredentialSwitcher({ value, onChange }: { value: CredentialType; onChange: (value: CredentialType) => void }) {
  return (
    <div className="intent-switcher w-full" aria-label="Credential type">
      <button type="button" className="intent-switcher__item flex-1" data-active={value === "pairingToken" || undefined} aria-pressed={value === "pairingToken"} onClick={() => onChange("pairingToken")}>
        <Link2 className="size-3.5" /> Pairing token
      </button>
      <button type="button" className="intent-switcher__item flex-1" data-active={value === "accessToken" || undefined} aria-pressed={value === "accessToken"} onClick={() => onChange("accessToken")}>
        <KeyRound className="size-3.5" /> Access token
      </button>
    </div>
  );
}

function EnvironmentStepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="device-flow__steps" aria-label="Connection progress">
      {steps.map((label, index) => (
        <li key={label} data-active={index === current || undefined} data-complete={index < current || undefined}>
          <span>{index < current ? <Check className="size-3" /> : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function EnvironmentEditorDialog({
  controller: c,
  environment,
  onClose,
  onCheck,
  onLoad,
  onUnpair,
}: {
  controller: Controller;
  environment: Environment | null;
  onClose: () => void;
  onCheck: () => void;
  onLoad: () => void;
  onUnpair: () => void;
}) {
  const [tab, setTab] = useState<EnvironmentTab>("connection");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [accessMode, setAccessMode] = useState<EnvironmentAccessMode>("local");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("accessToken");

  useEffect(() => {
    if (!environment) return;
    setTab("connection");
    setLabel(environment.label);
    setBaseUrl(environment.baseUrl);
    setAccessMode(inferEnvironmentAccessMode(environment.baseUrl));
    setCredential("");
    setCredentialType("accessToken");
  }, [environment?.id]);

  if (!environment) return null;
  const status = environmentStatus(environment);
  const validConnection = Boolean(label.trim() && environmentUrlValid(baseUrl, accessMode));
  const gateways = environmentGatewayInventory(environment.id, c.devices ?? [], c.gatewayProfiles ?? [], c.remoteAccess ?? null);

  const save = async () => {
    if (!validConnection) return;
    const saved = await c.run("update-environment", "Environment settings updated.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, {
        method: "PUT",
        body: {
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          ...(credential.trim() ? { [credentialType]: credential.trim() } : {}),
        },
      });
      setCredential("");
      await c.refreshAll();
      return result;
    });
    if (saved) onClose();
  };

  return (
    <EnvironmentModalShell
      open
      size="large"
      title={environment.label}
      eyebrow="Environment details"
      description={environment.id}
      headerAction={<StatusBadge tone={status.tone} label={status.label} />}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={c.busyAction === "update-environment"} disabled={!validConnection} onClick={() => void save()}>
            <Save className="size-4" /> Save changes
          </Button>
        </>
      )}
    >
      <div className="device-editor environment-editor">
        <nav className="device-editor__tabs" aria-label="Environment settings">
          {(["connection", "gateways", "credential", "health", "workspace"] as const).map((item) => (
            <button key={item} type="button" data-active={tab === item || undefined} onClick={() => setTab(item)}>{item}</button>
          ))}
        </nav>
        <div className="device-editor__body">
          {tab === "connection" ? (
            <div className="grid gap-5">
              <Field label="Environment label" htmlFor="edit-environment-label" hint="Shown in the resource rail, commands, and health alerts.">
                <input id="edit-environment-label" value={label} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              <div className="environment-editor__access">
                <div>
                  <p className="text-xs font-semibold text-ink">Access path</p>
                  <p className="mt-1 text-xs text-ink-muted">Changing the path does not alter the endpoint until you save.</p>
                </div>
                <EnvironmentAccessSelector value={accessMode} onChange={setAccessMode} />
                <EnvironmentAccessGuidance mode={accessMode} controller={c} />
              </div>
              <Field label="T3 base URL" htmlFor="edit-environment-url" hint={environmentEndpointHint(accessMode)}>
                <input id="edit-environment-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={environmentUrlPlaceholder(accessMode)} />
              </Field>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow label="Access path" value={environmentAccessLabel(accessMode)} />
                <EnvironmentReviewRow label="Environment ID" value={environment.id} mono />
                <EnvironmentReviewRow label="Created" value={formatRelativeTime(environment.createdAt)} />
                <EnvironmentReviewRow label="Last updated" value={formatRelativeTime(environment.updatedAt)} />
              </dl>
            </div>
          ) : null}

          {tab === "gateways" ? (
            <EnvironmentGatewayDetails gateways={gateways} />
          ) : null}

          {tab === "credential" ? (
            <div className="environment-editor__section">
              <div>
                <p className="font-display text-base font-semibold">Replace the stored credential</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">Leave this empty to keep the encrypted credential unchanged.</p>
              </div>
              <CredentialSwitcher value={credentialType} onChange={setCredentialType} />
              <Field label={credentialType === "pairingToken" ? "Replacement pairing token" : "Replacement access token"} htmlFor="edit-environment-token" hint="Saved credentials are never displayed again.">
                <textarea id="edit-environment-token" className="font-mono" rows={5} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Unchanged" />
              </Field>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow
                  label="Credential expires"
                  value={environment.accessTokenExpiresAt ? formatRelativeTime(environment.accessTokenExpiresAt) : "No known expiry"}
                />
                <EnvironmentReviewRow label="Stored as" value="Encrypted token" />
              </dl>
            </div>
          ) : null}

          {tab === "health" ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-semibold">Connection telemetry</p>
                  <p className="mt-1 text-sm text-ink-muted">Current reachability and the last successful contact with T3.</p>
                </div>
                <Button size="sm" busy={c.busyAction === `check-environment-${environment.id}`} onClick={onCheck}><RefreshCw className="size-3.5" /> Check now</Button>
              </div>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow label="Status" value={status.label} />
                <EnvironmentReviewRow label="Last checked" value={formatRelativeTime(environment.health?.lastCheckedAt)} />
                <EnvironmentReviewRow label="Last reachable" value={formatRelativeTime(environment.health?.lastReachableAt)} />
                <EnvironmentReviewRow label="Snapshot" value={environment.health?.snapshot?.line1 ?? "Not loaded"} />
                <EnvironmentReviewRow label="Sessions" value={environment.health?.snapshot?.line2 ?? "Not loaded"} />
              </dl>
              {environment.health?.lastError ? <p className="environment-editor__error" role="alert">{environment.health.lastError}</p> : null}
              <section className="device-editor__danger" aria-labelledby="environment-danger-title">
                <div>
                  <p id="environment-danger-title" className="font-display text-sm font-semibold text-danger">Connection danger zone</p>
                  <p className="mt-1 text-xs text-ink-muted">Unpairing removes the credential and clears this default from attached devices.</p>
                </div>
                <Button size="sm" variant="danger-ghost" onClick={onUnpair}><Unplug className="size-3.5" /> Unpair environment</Button>
              </section>
            </div>
          ) : null}

          {tab === "workspace" ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-semibold">Projects and sessions</p>
                  <p className="mt-1 text-sm text-ink-muted">The live T3 snapshot for this environment.</p>
                </div>
                <Button size="sm" busy={c.busyAction === `environment-snapshot-${environment.id}`} onClick={onLoad}><RefreshCw className="size-3.5" /> Load snapshot</Button>
              </div>
              {c.projects.length || c.threads.length ? (
                <div className="environment-workspace-list">
                  <section>
                    <h4><FolderGit2 className="size-3.5" /> {c.projects.length} projects</h4>
                    <div>
                      {c.projects.map((project) => (
                        <article key={project.id}>
                          <p>{project.title ?? project.name ?? project.id}</p>
                          <code>{project.workspaceRoot ?? project.id}</code>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h4><Clock3 className="size-3.5" /> {c.threads.length} sessions</h4>
                    <div>
                      {c.threads.map((thread) => (
                        <article key={thread.id}>
                          <p>{thread.label}</p>
                          <code>{thread.id}</code>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="environment-workspace-empty">
                  <CloudCog className="size-5" />
                  <p>No workspace snapshot loaded</p>
                  <span>Fetch this host to inspect its projects and sessions.</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </EnvironmentModalShell>
  );
}

function EnvironmentGatewayDetails({ gateways }: { gateways: EnvironmentGateway[] }) {
  const activeGateways = gateways.filter((gateway) => gateway.users.length > 0);
  const attachedDevices = new Map(
    activeGateways.flatMap((gateway) => gateway.users.map((device) => [device.id, device] as const)),
  );

  return (
    <div className="environment-editor__section environment-gateways">
      <div className="environment-gateways__intro">
        <div>
          <p className="font-display text-base font-semibold">Controller gateways</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            Endpoints used by physical controllers assigned to this environment. The T3 connection URL is managed separately under Connection.
          </p>
        </div>
        <dl className="environment-gateways__summary">
          <div><dt>Active</dt><dd>{activeGateways.length}</dd></div>
          <div><dt>Devices</dt><dd>{attachedDevices.size}</dd></div>
        </dl>
      </div>

      {gateways.length ? (
        <div className="environment-gateways__list">
          {gateways.map((gateway) => {
            const active = gateway.users.length > 0;
            return (
              <article key={gateway.id} className="environment-gateway-row" data-active={active || undefined}>
                <div className="environment-gateway-row__icon"><GatewayIcon mode={gateway.mode} className="size-4" /></div>
                <div className="environment-gateway-row__main">
                  <div className="environment-gateway-row__heading">
                    <div>
                      <h4>{gateway.label}</h4>
                      <StatusBadge
                        tone={active ? "success" : gateway.detected ? "info" : "neutral"}
                        label={active ? "active" : gateway.detected ? "available" : "not detected"}
                      />
                    </div>
                    <span>{gateway.users.length} {gateway.users.length === 1 ? "device" : "devices"}</span>
                  </div>
                  <code>{gateway.url ?? "Endpoint stored on device"}</code>
                  <div className="environment-gateway-row__users">
                    <p><Users className="size-3.5" /> Who is using it</p>
                    {gateway.users.length ? (
                      <ul>
                        {gateway.users.map((device) => (
                          <li key={device.id}>
                            <span className="environment-gateway-row__presence" data-online={device.presence?.online || undefined} />
                            <span>{device.label}</span>
                            <small>{device.presence?.online ? "online" : device.presence?.state ?? "offline"}</small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>No devices assigned to this gateway.</span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="environment-workspace-empty environment-gateways__empty">
          <Router className="size-5" />
          <p>No controller gateways found</p>
          <span>Assign a device to this environment or configure a gateway endpoint in Device settings.</span>
        </div>
      )}
    </div>
  );
}

function EnvironmentReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "font-mono" : undefined}>{value}</dd></div>;
}

function EnvironmentModalShell({
  open,
  title,
  eyebrow,
  description,
  headerAction,
  footer,
  size = "default",
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  eyebrow: string;
  description?: string;
  headerAction?: ReactNode;
  footer: ReactNode;
  size?: "default" | "large";
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal((
    <div className="device-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="environment-modal-title" className="device-modal" data-size={size}>
        <header className="device-modal__header">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{eyebrow}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="environment-modal-title" className="truncate font-display text-lg font-semibold">{title}</h2>
              {headerAction}
            </div>
            {description ? <p className="mt-1 truncate text-xs text-ink-muted">{description}</p> : null}
          </div>
          <button ref={closeRef} type="button" className="device-modal__close" aria-label="Close dialog" onClick={onClose}><X className="size-4" /></button>
        </header>
        <div className="device-modal__content">{children}</div>
        <footer className="device-modal__footer">{footer}</footer>
      </div>
    </div>
  ), document.body);
}
