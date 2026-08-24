import {
  BellOff,
  BellRing,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  Globe2,
  LogIn,
  LogOut,
  Network,
  Save,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Controller } from "../controller";
import {
  buildGatewayTunnelDisableCommand,
  buildGatewayTunnelSetupCommand,
  remoteAccessOptions,
  type RemoteAccessMode,
} from "../remoteAccess";
import {
  RemoteAccessReadiness,
  remoteAccessReady,
} from "./RemoteAccessReadiness";
import {
  Button,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";
import { T3CompatibilityPanel } from "./T3CompatibilityPanel";
import { GatewayProfilesPanel } from "./GatewayProfilesPanel";

const NOTIFICATION_HINTS: Record<string, string> = {
  unsupported: "This browser cannot raise notifications. Install the console to your home screen, or use a desktop browser.",
  denied: "Notifications are blocked for this site. Re-enable them in your browser's site settings, then try again.",
  default: "Notification permission was dismissed. Choose Allow when the browser asks.",
};

export function SettingsPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [retentionDraft, setRetentionDraft] = useState(
    c.privacyDays === null ? "" : String(c.privacyDays),
  );
  const [notificationHint, setNotificationHint] = useState<string | null>(null);
  const [remoteAccessMode, setRemoteAccessMode] = useState<RemoteAccessMode>("serve");

  useEffect(() => {
    setRetentionDraft(c.privacyDays === null ? "" : String(c.privacyDays));
  }, [c.privacyDays]);

  useEffect(() => {
    if (c.remoteAccess?.tailscale.mode) setRemoteAccessMode(c.remoteAccess.tailscale.mode);
  }, [c.remoteAccess?.tailscale.mode]);

  const toggleApprovalNotifications = async () => {
    if (c.approvalNotificationsEnabled) {
      c.disableApprovalNotifications();
      setNotificationHint(null);
      c.setNotice({ tone: "info", message: "Approval notifications turned off." });
      return;
    }
    const result = await c.enableApprovalNotifications();
    if (result === "granted") {
      setNotificationHint(null);
      c.setNotice({ tone: "success", message: "Approval notifications enabled." });
      return;
    }
    setNotificationHint(NOTIFICATION_HINTS[result] ?? NOTIFICATION_HINTS.default);
  };

  const saveRetention = async () => {
    const value = retentionDraft.trim();
    const mediaRetentionDays = value === "" ? null : Number(value);
    if (
      mediaRetentionDays !== null
      && (!Number.isInteger(mediaRetentionDays) || mediaRetentionDays < 1 || mediaRetentionDays > 365)
    ) {
      c.setNotice({ tone: "danger", message: "Retention must be an integer from 1 to 365 days." });
      return;
    }
    await c.run("save-retention", "Media retention policy saved.", async () => {
      const result = await c.api<{ privacy: { mediaRetentionDays: number | null } }>("/v1/settings/privacy", {
        method: "PUT",
        body: { mediaRetentionDays },
      });
      c.setPrivacyDays(result.privacy.mediaRetentionDays);
      return result;
    });
  };

  const purgeExpired = async () => {
    const accepted = await confirm({
      title: "Purge expired media?",
      description: "All captures past the configured retention window will be permanently deleted.",
      confirmLabel: "Purge expired media",
    });
    if (!accepted) return;
    await c.run("purge-media", "Expired media purged.", async () => {
      const result = await c.api("/v1/media/purge-expired", { method: "POST", body: {} });
      await c.refreshAll();
      return result;
    });
  };

  const copyRemoteAccessCommand = async (command: string, label: string) => {
    try {
      await navigator.clipboard.writeText(command);
      c.setNotice({ tone: "success", message: `${label} copied.` });
    } catch {
      c.setNotice({ tone: "danger", message: "Clipboard access was blocked. Select and copy the command manually." });
    }
  };

  const tunnelCommand = buildGatewayTunnelSetupCommand(remoteAccessMode);
  const disableCommand = buildGatewayTunnelDisableCommand(remoteAccessMode);
  const tunnelReady = remoteAccessReady(c.remoteAccess, remoteAccessMode);

  return (
    <div className="page-stack">
      <T3CompatibilityPanel controller={c} />

      <GatewayProfilesPanel controller={c} />

      <Panel elevated className="overflow-hidden">
        <SectionHeader
          eyebrow="Remote access"
          title="Connect securely from anywhere"
          description="Put this gateway behind a stable Tailscale HTTPS address without opening router ports. Serve is private to your Tailnet; Funnel is an intentionally public option."
          action={
            <StatusBadge
              tone={tunnelReady ? "success" : c.remoteAccess ? "warning" : "neutral"}
              label={tunnelReady ? "Remote access ready" : c.remoteAccess ? "Setup needed" : "Checking"}
            />
          }
        />
        <div className="grid gap-5 border-t border-control p-5 xl:grid-cols-[minmax(0,0.82fr)_minmax(360px,1.18fr)]">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">Choose visibility</p>
            {remoteAccessOptions.map((option) => {
              const selected = remoteAccessMode === option.id;
              const Icon = option.id === "serve" ? Network : Globe2;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  className="flex w-full items-start gap-3 rounded-lg border border-control bg-surface-inset/35 p-4 text-left outline-none transition hover:border-control-strong hover:bg-surface-inset focus-visible:ring-2 focus-visible:ring-focus"
                  data-selected={selected || undefined}
                  onClick={() => setRemoteAccessMode(option.id)}
                >
                  <span className={`grid size-9 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-surface-raised text-ink-muted"}`}>
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{option.label}</strong>
                      <StatusBadge tone={option.id === "serve" ? "success" : "warning"} label={option.visibility} />
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{option.description}</span>
                  </span>
                </button>
              );
            })}
            {remoteAccessMode === "funnel" ? (
              <div className="rounded-lg border border-warning/25 bg-warning/8 p-3 text-xs leading-relaxed text-warning" role="note">
                Funnel exposes the gateway to the public internet. The setup script refuses to enable it unless Clerk is configured, unless you explicitly acknowledge another production authentication layer.
              </div>
            ) : (
              <p className="rounded-lg border border-success/20 bg-success/7 p-3 text-xs leading-relaxed text-ink-muted">
                Serve follows T3 Code’s recommended remote-access model: a trusted private network, stable MagicDNS address, HTTPS, and Tailnet access controls.
              </p>
            )}
          </div>

          <div className="space-y-4">
            <RemoteAccessReadiness
              status={c.remoteAccess}
              mode={remoteAccessMode}
              refreshing={c.busyAction === "refresh-remote-access"}
              onRefresh={() => void c.run(
                "refresh-remote-access",
                "Remote access status refreshed.",
                () => c.loadRemoteAccess(true),
              )}
            />

            {tunnelReady && c.remoteAccess?.tailscale.httpsUrl ? (
              <div className="rounded-lg border border-success/25 bg-success/8 p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">Remote access is configured</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">{c.remoteAccess.tailscale.httpsUrl}</p>
                    <a
                      className="mt-3 inline-flex min-h-8 items-center gap-2 rounded-md border border-success/25 bg-success/10 px-3 text-xs font-semibold text-success outline-none hover:bg-success/15 focus-visible:ring-2 focus-visible:ring-focus"
                      href={c.remoteAccess.tailscale.httpsUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open remote console <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {!c.remoteAccess?.tailscale.installed ? (
                  <a
                    className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3 text-sm font-semibold text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus"
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install Tailscale <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
                <div className="rounded-lg border border-control bg-console p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-xs font-semibold text-console-ink">
                      <SquareTerminal className="size-3.5" aria-hidden="true" /> Run on the gateway host
                    </span>
                    <Button size="sm" onClick={() => void copyRemoteAccessCommand(tunnelCommand, "Tunnel setup command")}>
                      <Clipboard className="size-3.5" /> Copy
                    </Button>
                  </div>
                  <code className="mt-3 block select-all overflow-x-auto whitespace-nowrap font-mono text-xs text-console-ink">{tunnelCommand}</code>
                </div>
              </>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              <button
                type="button"
                className="text-ink-muted underline decoration-control-strong underline-offset-4 hover:text-ink"
                onClick={() => void copyRemoteAccessCommand(disableCommand, "Disable command")}
              >
                Copy disable command
              </button>
              <a className="text-primary hover:underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                Install Tailscale <ExternalLink className="ml-1 inline size-3" />
              </a>
              <a className="text-primary hover:underline" href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">
                Tailscale Serve docs <ExternalLink className="ml-1 inline size-3" />
              </a>
              <a className="text-primary hover:underline" href="https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md" target="_blank" rel="noreferrer">
                T3 Code remote access <ExternalLink className="ml-1 inline size-3" />
              </a>
            </div>

            <p className="border-t border-control pt-4 text-xs leading-relaxed text-ink-muted">
              This tunnel exposes the Agent Controller console. To expose a T3 Code host too, choose <strong className="text-ink">Tailscale Serve</strong> in Initial setup, or run <code className="font-mono text-[11px] text-ink">npx t3 pair --tailscale</code> for an already-running T3 server.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel elevated className="overflow-hidden">
          <SectionHeader
            eyebrow="Access"
            title="Gateway session"
            description="Clerk manages your identity and refreshes secure gateway sessions automatically."
            action={
              <StatusBadge
                tone={c.authenticated ? "success" : "warning"}
                label={c.authenticated ? "authenticated" : "signed out"}
              />
            }
          />
          <div className="space-y-5 border-t border-control p-5">
            {c.authConfig.clerk?.enabled && c.clerk ? (
              <div className="rounded-lg border border-control bg-surface-inset/45 p-4">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <UserRound className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {c.clerk.signedIn ? c.clerk.userLabel ?? "Signed-in Clerk user" : "Clerk account"}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      {c.clerk.signedIn
                        ? "Your active Clerk session is securing gateway requests and live updates."
                        : "Sign in with Clerk to access environments, devices, media, and activity."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!c.clerk.loaded ? (
                        <Button disabled>Checking session…</Button>
                      ) : !c.clerk.signedIn ? (
                        <Button onClick={c.clerk.openSignIn}>
                          <LogIn className="size-4" /> Sign in
                        </Button>
                      ) : (
                        <>
                          <Button onClick={c.clerk.openUserProfile}>
                            <ShieldCheck className="size-4" /> Manage account
                          </Button>
                          <Button variant="danger-ghost" onClick={() => void c.signOut()}>
                            <LogOut className="size-4" /> Sign out
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-danger/20 bg-danger/8 p-4 text-sm text-danger">
                <p className="font-semibold">Clerk authentication is not configured.</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Add the Clerk publishable and secret keys to the gateway environment, then restart the service.
                </p>
              </div>
            )}
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Privacy"
            title="Media retention"
            description="Choose how long images and audio remain available to prompts and support tooling."
          />
          <div className="space-y-4 border-t border-control p-5">
            <Field
              label="Retention days"
              htmlFor="retention-days"
              hint="Leave blank to retain media until manual deletion. Range: 1–365 days."
            >
              <input
                id="retention-days"
                type="number"
                min={1}
                max={365}
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
                placeholder="Manual deletion"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void saveRetention()} busy={c.busyAction === "save-retention"}>
                <Save className="size-4" /> Save retention
              </Button>
              <Button variant="danger-ghost" onClick={() => void purgeExpired()}>
                <Trash2 className="size-4" /> Purge expired
              </Button>
            </div>
            <div className="rounded-lg border border-control bg-surface-inset/45 p-4">
              <dl className="grid grid-cols-2 gap-4">
                <Metric label="Current policy" value={c.privacyDays === null ? "Manual deletion" : `${c.privacyDays} days`} />
                <Metric label="Stored captures" value={c.media.length} />
              </dl>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <SectionHeader
          eyebrow="Alerts"
          title="Approval notifications"
          description="Raise a system notification when a command stops for approval while this tab is in the background. Permission is only requested when you turn this on."
          action={
            <StatusBadge
              tone={c.approvalNotificationsEnabled
                ? "success"
                : c.notificationSupport === "denied" || c.notificationSupport === "unsupported"
                  ? "danger"
                  : "neutral"}
              label={c.approvalNotificationsEnabled ? "on" : c.notificationSupport}
            />
          }
        />
        <div className="space-y-3 border-t border-control p-5">
          <p className="text-xs leading-relaxed text-ink-muted">
            Notifications carry the command type and its summary. Nothing is sent to a push service —
            they are raised locally by this browser while the console is open.
          </p>
          {notificationHint ? (
            <p className="text-xs text-danger" role="alert">{notificationHint}</p>
          ) : null}
          <Button
            variant={c.approvalNotificationsEnabled ? "danger-ghost" : "primary"}
            disabled={c.notificationSupport === "unsupported"}
            onClick={() => void toggleApprovalNotifications()}
          >
            {c.approvalNotificationsEnabled
              ? <><BellOff className="size-4" /> Turn off approval notifications</>
              : <><BellRing className="size-4" /> Enable approval notifications</>}
          </Button>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Support"
            title="Diagnostics"
            description="Export a redacted bundle for troubleshooting without exposing tokens, transcripts, or raw commands."
          />
          <div className="space-y-3 border-t border-control p-5">
            <a
              href="#onboarding"
              className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-control-strong bg-surface-raised px-3 text-sm font-semibold text-ink outline-none hover:bg-surface-inset focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Sparkles className="size-4" />
              {c.onboarding?.status === "completed" ? "Review setup and readiness" : "Continue initial setup"}
            </a>
            <Button className="w-full" onClick={() => void c.downloadDiagnostics()}>
              <Download className="size-4" /> Download redacted diagnostics
            </Button>
            <a
              href="/legacy/"
              className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-control px-3 text-sm font-semibold text-ink-muted outline-none hover:bg-surface-inset focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Wrench className="size-4" /> Open legacy dashboard <ExternalLink className="size-3.5" />
            </a>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Developer console"
            title="Latest operation"
            description="Raw API output remains available for development and support inspection."
            action={<StatusBadge tone={c.connection === "error" ? "danger" : "neutral"} label={c.connection} />}
          />
          <pre className="max-h-[420px] overflow-auto border-t border-control bg-console p-4 font-mono text-xs leading-relaxed text-console-ink">
            {JSON.stringify(c.lastResult, null, 2)}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
