import {
  Cable,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CloudCog,
  FolderGit2,
  KeyRound,
  Link2,
  Network,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Controller } from "../controller";
import { formatRelativeTime } from "../format";
import type { Environment } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";

function environmentTone(environment: Environment) {
  if (environment.status === "token_expired") return "danger" as const;
  if (environment.status === "reachable" || environment.health?.lastReachableAt) return "success" as const;
  if (environment.health?.lastError) return "danger" as const;
  return "neutral" as const;
}

export function EnvironmentsPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [label, setLabel] = useState("Mac T3 Code");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<"pairingToken" | "accessToken">("pairingToken");

  useEffect(() => {
    if (!c.selectedEnvironment) return;
    setLabel(c.selectedEnvironment.label);
    setBaseUrl(c.selectedEnvironment.baseUrl);
    setCredential("");
  }, [c.selectedEnvironment]);

  const pairEnvironment = async () => {
    if (!baseUrl.trim() || !credential.trim()) {
      c.setNotice({ tone: "danger", message: "Enter the T3 base URL and credential." });
      return;
    }
    await c.run("pair-environment", "T3 environment connected.", async () => {
      const body = {
        label: label.trim() || "T3 Code",
        baseUrl: baseUrl.trim(),
        [credentialType]: credential.trim(),
      };
      const result = await c.api<{ environment: Environment }>("/v1/t3/environments", {
        method: "POST",
        body,
      });
      setCredential("");
      await c.refreshAll();
      c.setSelectedEnvironmentId(result.environment.id);
      return result;
    });
  };

  const updateEnvironment = async () => {
    if (!c.selectedEnvironment) return;
    await c.run("update-environment", "Environment settings updated.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(c.selectedEnvironment!.id)}`, {
        method: "PUT",
        body: {
          label: label.trim() || c.selectedEnvironment!.label,
          baseUrl: baseUrl.trim() || c.selectedEnvironment!.baseUrl,
          accessToken: credential.trim() || undefined,
        },
      });
      setCredential("");
      await c.refreshAll();
      return result;
    });
  };

  const checkEnvironment = async (environment = c.selectedEnvironment) => {
    if (!environment) return;
    await c.run(`check-environment-${environment.id}`, "Reachability check complete.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/check`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const unpairEnvironment = async () => {
    if (!c.selectedEnvironment) return;
    const accepted = await confirm({
      title: `Unpair ${c.selectedEnvironment.label}?`,
      description: "Devices using this environment will have their default environment cleared. Stored access credentials will be removed.",
      confirmLabel: "Unpair environment",
    });
    if (!accepted) return;
    await c.run("unpair-environment", "Environment unpaired.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(c.selectedEnvironment!.id)}`, {
        method: "DELETE",
      });
      await c.refreshAll();
      return result;
    });
  };

  return (
    <div className="page-stack">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(350px,0.62fr)]">
        <Panel elevated className="overflow-hidden">
          <SectionHeader
            eyebrow="Connections"
            title="T3 environments"
            description="Paired workstations and their orchestration health."
            action={<StatusBadge label={`${c.environments.length} paired`} />}
          />
          {c.environments.length ? (
            <div className="divide-y divide-control border-t border-control">
              {c.environments.map((environment) => {
                const selected = environment.id === c.selectedEnvironmentId;
                return (
                  <button
                    key={environment.id}
                    type="button"
                    className="inventory-row"
                    data-selected={selected || undefined}
                    onClick={() => c.setSelectedEnvironmentId(environment.id)}
                  >
                    <div className="grid size-10 place-items-center rounded-lg border border-control bg-surface-inset">
                      <Server className="size-4.5 text-primary" />
                    </div>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-display text-sm font-semibold">{environment.label}</span>
                        <StatusBadge
                          tone={environmentTone(environment)}
                          label={environment.status ?? (environment.health?.lastReachableAt ? "reachable" : "unchecked")}
                        />
                      </span>
                      <span className="mt-1 block truncate text-xs text-ink-muted">{environment.baseUrl}</span>
                      <span className="mt-1 block truncate font-mono text-[11px] text-ink-faint">
                        Last reachable {formatRelativeTime(environment.health?.lastReachableAt)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-ink-faint" />
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={Network}
              title="No T3 environments"
              description="Pair a T3 Code workstation to load projects, select sessions, and dispatch agent work."
            />
          )}
        </Panel>

        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow={c.selectedEnvironment ? "Edit connection" : "New connection"}
            title={c.selectedEnvironment ? c.selectedEnvironment.label : "Pair T3 Code"}
            description="Credentials are encrypted at rest and never returned by the API."
          />
          <div className="space-y-4 border-t border-control p-5">
            <Field label="Environment label" htmlFor="environment-label">
              <input id="environment-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="T3 base URL" htmlFor="environment-url" hint="Use the reachable local, Tailnet, or tunnel URL.">
              <input
                id="environment-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://mac.tailnet.ts.net"
              />
            </Field>
            {!c.selectedEnvironment ? (
              <div className="intent-switcher w-full" aria-label="Credential type">
                <button
                  type="button"
                  className="intent-switcher__item flex-1"
                  data-active={credentialType === "pairingToken" || undefined}
                  aria-pressed={credentialType === "pairingToken"}
                  onClick={() => setCredentialType("pairingToken")}
                >
                  <Link2 className="size-3.5" /> Pairing token
                </button>
                <button
                  type="button"
                  className="intent-switcher__item flex-1"
                  data-active={credentialType === "accessToken" || undefined}
                  aria-pressed={credentialType === "accessToken"}
                  onClick={() => setCredentialType("accessToken")}
                >
                  <KeyRound className="size-3.5" /> Access token
                </button>
              </div>
            ) : null}
            <Field
              label={c.selectedEnvironment ? "Replacement access token" : credentialType === "pairingToken" ? "Pairing token" : "Access token"}
              htmlFor="environment-token"
              hint={c.selectedEnvironment ? "Leave blank to keep the encrypted credential." : "The credential is sent only when this form is submitted."}
            >
              <textarea
                id="environment-token"
                rows={3}
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder={c.selectedEnvironment ? "Unchanged" : "Paste credential"}
              />
            </Field>
            {c.selectedEnvironment ? (
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => void updateEnvironment()} busy={c.busyAction === "update-environment"}>
                  <Save className="size-4" /> Update
                </Button>
                <Button onClick={() => void checkEnvironment()} busy={c.busyAction?.startsWith("check-environment")}>
                  <RefreshCw className="size-4" /> Check
                </Button>
              </div>
            ) : (
              <Button className="w-full" variant="primary" onClick={() => void pairEnvironment()}>
                <Cable className="size-4" /> Connect environment
              </Button>
            )}
          </div>
        </Panel>
      </div>

      {c.selectedEnvironment ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <Panel className="overflow-hidden">
            <SectionHeader
              eyebrow="Health"
              title="Connection telemetry"
              action={
                <StatusBadge
                  tone={environmentTone(c.selectedEnvironment)}
                  label={c.selectedEnvironment.status ?? "paired"}
                />
              }
            />
            <div className="border-t border-control p-5">
              <dl className="grid grid-cols-2 gap-x-5 gap-y-5">
                <Metric label="Environment ID" value={c.selectedEnvironment.id} />
                <Metric label="Last checked" value={formatRelativeTime(c.selectedEnvironment.health?.lastCheckedAt)} />
                <Metric label="Last reachable" value={formatRelativeTime(c.selectedEnvironment.health?.lastReachableAt)} />
                <Metric
                  label="Credential expires"
                  value={c.selectedEnvironment.accessTokenExpiresAt
                    ? formatRelativeTime(c.selectedEnvironment.accessTokenExpiresAt)
                    : "No known expiry"}
                />
                <Metric label="Snapshot" value={c.selectedEnvironment.health?.snapshot?.line1 ?? "Not loaded"} />
                <Metric label="Threads" value={c.selectedEnvironment.health?.snapshot?.line2 ?? "Not loaded"} />
              </dl>
              {c.selectedEnvironment.health?.lastError ? (
                <div className="mt-5 rounded-lg border border-danger/20 bg-danger/8 p-3 text-sm text-danger">
                  {c.selectedEnvironment.health.lastError}
                </div>
              ) : null}
            </div>
            <div className="border-t border-danger/20 p-5">
              <Button variant="danger-ghost" onClick={() => void unpairEnvironment()}>
                <Unplug className="size-4" /> Unpair environment
              </Button>
            </div>
          </Panel>

          <Panel elevated className="overflow-hidden">
            <SectionHeader
              eyebrow="Workspace snapshot"
              title="Projects and sessions"
              description="Load the live T3 snapshot without leaving this environment."
              action={
                <Button
                  size="sm"
                  busy={c.busyAction === "environment-snapshot"}
                  onClick={() => void c.run("environment-snapshot", "Workspace snapshot loaded.", () => c.loadSnapshot())}
                >
                  <RefreshCw className="size-4" /> Load snapshot
                </Button>
              }
            />
            {c.projects.length || c.threads.length ? (
              <div className="grid border-t border-control md:grid-cols-2">
                <div className="border-b border-control md:border-b-0 md:border-r">
                  <div className="flex items-center gap-2 px-4 py-3 text-xs font-semibold text-ink-muted">
                    <FolderGit2 className="size-4" /> {c.projects.length} projects
                  </div>
                  <div className="divide-y divide-control">
                    {c.projects.map((project) => (
                      <div key={project.id} className="px-4 py-3">
                        <p className="truncate text-sm font-semibold">{project.title ?? project.name ?? project.id}</p>
                        <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
                          {project.workspaceRoot ?? project.id}
                        </p>
                        {project.defaultModelSelection ? (
                          <p className="mt-1 text-xs text-ink-muted">
                            {project.defaultModelSelection.instanceId} · {project.defaultModelSelection.model}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-2 px-4 py-3 text-xs font-semibold text-ink-muted">
                    <Clock3 className="size-4" /> {c.threads.length} sessions
                  </div>
                  <div className="divide-y divide-control">
                    {c.threads.map((thread) => (
                      <div key={thread.id} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-semibold">{thread.label}</p>
                          {thread.status ? <StatusBadge label={thread.status} /> : null}
                        </div>
                        <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{thread.id}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={CloudCog}
                title="Snapshot not loaded"
                description="Fetch the current projects and sessions to verify orchestration access."
              />
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
