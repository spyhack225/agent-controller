import { Check, Circle, LoaderCircle, RefreshCw } from "lucide-react";

import type { RemoteAccessMode } from "../remoteAccess";
import type { RemoteAccessStatus } from "../types";
import { Button, cn } from "../ui";

export interface RemoteAccessReadinessStep {
  id: "install" | "connect" | "enable" | "restart";
  label: string;
  detail: string;
  ready: boolean;
}

export function remoteAccessReadinessSteps(
  status: RemoteAccessStatus | null,
  mode: RemoteAccessMode,
): RemoteAccessReadinessStep[] {
  const tailscale = status?.tailscale;
  const mappingActive = mode === "serve"
    ? Boolean(tailscale?.serve.active)
    : Boolean(tailscale?.funnel.active);
  const otherMode = mode === "serve" ? "Funnel" : "Serve";
  const otherActive = mode === "serve"
    ? Boolean(tailscale?.funnel.active)
    : Boolean(tailscale?.serve.active);

  return [
    {
      id: "install",
      label: "Tailscale installed",
      ready: Boolean(tailscale?.installed),
      detail: !status
        ? "Checking this gateway host…"
        : tailscale?.installed
          ? "Tailscale CLI found on this machine."
          : "Install Tailscale on the machine running Agent Controller.",
    },
    {
      id: "connect",
      label: "Machine signed in",
      ready: Boolean(tailscale?.connected),
      detail: tailscale?.connected
        ? tailscale.dnsName ?? tailscale.ips[0] ?? "Connected to a Tailnet."
        : tailscale?.installed
          ? `Open Tailscale and sign in. Current state: ${tailscale.backendState}.`
          : "This becomes available after Tailscale is installed.",
    },
    {
      id: "enable",
      label: mode === "serve" ? "Private HTTPS enabled" : "Public Funnel enabled",
      ready: mappingActive,
      detail: mappingActive
        ? `${mode === "serve" ? "Serve" : "Funnel"} is proxying this gateway.`
        : otherActive
          ? `${otherMode} is active instead. Select it above or reconfigure the tunnel.`
          : tailscale?.connected
            ? "Run the setup command below on the gateway host."
            : "The tunnel can be enabled after this machine joins a Tailnet.",
    },
    {
      id: "restart",
      label: "Gateway URL loaded",
      ready: Boolean(mappingActive && tailscale?.publicBaseUrlConfigured),
      detail: mappingActive && tailscale?.publicBaseUrlConfigured
        ? tailscale.httpsUrl ?? "The HTTPS origin is active."
        : mappingActive
          ? "Restart Agent Controller after the setup command updates .env."
          : "Setup will update PUBLIC_BASE_URL and Clerk authorized parties.",
    },
  ];
}

export function remoteAccessReady(status: RemoteAccessStatus | null, mode: RemoteAccessMode) {
  return remoteAccessReadinessSteps(status, mode).every((step) => step.ready);
}

export function RemoteAccessReadiness({
  status,
  mode,
  refreshing = false,
  onRefresh,
  compact = false,
}: {
  status: RemoteAccessStatus | null;
  mode: RemoteAccessMode;
  refreshing?: boolean;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const steps = remoteAccessReadinessSteps(status, mode);
  return (
    <div className="rounded-lg border border-control bg-surface-inset/35" aria-live="polite">
      <div className="flex items-center justify-between gap-3 border-b border-control px-3 py-2.5">
        <div>
          <p className="text-xs font-semibold text-ink">This gateway host</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {status ? `Checked ${new Date(status.checkedAt).toLocaleTimeString()}` : "Checking tunnel readiness…"}
          </p>
        </div>
        {onRefresh ? (
          <Button size="sm" variant="ghost" busy={refreshing} onClick={onRefresh}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        ) : null}
      </div>
      <ol className={cn("divide-y divide-control", compact ? "text-xs" : "text-sm")}>
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3 px-3 py-2.5">
            <span className={cn(
              "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
              step.ready
                ? "border-success/30 bg-success/10 text-success"
                : "border-control-strong bg-surface-raised text-ink-faint",
            )}>
              {!status && step.id === "install"
                ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                : step.ready
                  ? <Check className="size-3" />
                  : <Circle className="size-2.5" />}
            </span>
            <span className="min-w-0">
              <strong className="block text-xs text-ink">{step.label}</strong>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
