import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  History,
  ListChecks,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Controller } from "../controller";
import { commandSummary, commandType, formatRelativeTime, renderEventResult } from "../format";
import type { Command } from "../types";
import {
  Button,
  EmptyState,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";

type ActivityView = "approvals" | "commands" | "audit";

function tone(status: string) {
  if (status === "approval_required") return "warning" as const;
  if (["failed", "rejected"].includes(status)) return "danger" as const;
  if (["completed", "approved"].includes(status)) return "success" as const;
  if (["running", "dispatched"].includes(status)) return "live" as const;
  return "neutral" as const;
}

export function ActivityPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [view, setView] = useState<ActivityView>(c.pendingApprovals.length ? "approvals" : "commands");
  const [query, setQuery] = useState("");
  const [traceOpen, setTraceOpen] = useState(false);

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const source = view === "approvals" ? c.pendingApprovals : c.recentCommands;
    if (!normalized) return source;
    return source.filter((command) =>
      [command.id, command.status, command.risk, commandSummary(command), commandType(command)]
        .some((value) => String(value ?? "").toLowerCase().includes(normalized))
    );
  }, [c.pendingApprovals, c.recentCommands, query, view]);

  const decide = async (command: Command, decision: "approve" | "reject") => {
    if (decision === "reject") {
      const accepted = await confirm({
        title: "Reject this command?",
        description: commandSummary(command),
        confirmLabel: "Reject command",
      });
      if (!accepted) return;
    }
    await c.run(`${decision}-${command.id}`, `Command ${decision}d.`, async () => {
      const result = await c.api(`/v1/commands/${encodeURIComponent(command.id)}/${decision}`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const openTimeline = (command: Command) => {
    setTraceOpen(true);
    void c.run(`timeline-${command.id}`, "Timeline loaded.", () => c.loadCommandTimeline(command));
  };

  return (
    <div
      className="activity-workspace"
      data-has-trace={c.timelineCommand ? true : undefined}
      data-trace-open={traceOpen || undefined}
    >
      <Panel elevated className="activity-list">
        <SectionHeader
          eyebrow="Audit trail"
          title="Activity and decisions"
          description="Review work that needs attention, inspect command history, and trace account changes."
          action={
            <Button size="sm" onClick={() => void c.refreshAll()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          }
        />
        <div className="flex flex-col gap-3 border-y border-control bg-surface-inset/45 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="intent-switcher" aria-label="Activity view">
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "approvals" || undefined}
              onClick={() => setView("approvals")}
            >
              <ShieldAlert className="size-3.5" /> Approvals
              {c.pendingApprovals.length ? <span className="nav-count nav-count--warning">{c.pendingApprovals.length}</span> : null}
            </button>
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "commands" || undefined}
              onClick={() => setView("commands")}
            >
              <ListChecks className="size-3.5" /> Commands
            </button>
            <button
              type="button"
              className="intent-switcher__item"
              data-active={view === "audit" || undefined}
              onClick={() => setView("audit")}
            >
              <ScrollText className="size-3.5" /> Audit
            </button>
          </div>
          {view !== "audit" ? (
            <label className="relative block">
              <span className="sr-only">Filter activity</span>
              <input
                className="min-w-56 pl-3"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter commands"
              />
            </label>
          ) : null}
        </div>

        <div className="activity-list__body">
          {view === "audit" ? (
            c.audit.length ? (
              <div className="divide-y divide-control">
                {c.audit.map((event, index) => (
                  <article key={event.id ?? `${event.createdAt}-${index}`} className="grid grid-cols-[12px_1fr_auto] gap-3 px-5 py-4">
                    <span className="mt-1.5 size-2 rounded-full bg-accent ring-4 ring-accent/10" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{event.action}</p>
                      <p className="mt-1 truncate text-xs text-ink-muted">
                        {event.actorType ?? "system"} {event.actorId ?? ""} → {event.targetId ?? "account"}
                      </p>
                    </div>
                    <time className="font-mono text-[10px] text-ink-faint">{formatRelativeTime(event.createdAt)}</time>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState icon={ScrollText} title="No audit events" description="Account and device changes will be recorded here." />
            )
          ) : filteredCommands.length ? (
            <div className="divide-y divide-control">
              {filteredCommands.map((command) => (
                <article key={command.id} className="grid gap-4 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                  <button
                    type="button"
                    className="min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => openTimeline(command)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-sm font-semibold capitalize">{commandType(command)}</span>
                      <StatusBadge tone={tone(command.status)} label={command.status.replaceAll("_", " ")} />
                      <span className="text-xs font-semibold capitalize text-ink-muted">{command.risk ?? "unknown"} risk</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-ink-muted">{commandSummary(command)}</p>
                    <p className="mt-2 truncate font-mono text-[11px] text-ink-faint">
                      {command.id} · {command.threadId ?? "no thread"} · {formatRelativeTime(command.createdAt)}
                    </p>
                  </button>
                  <div className="flex items-center gap-2">
                    {command.status === "approval_required" ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => void decide(command, "approve")}>
                          <Check className="size-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="danger-ghost" onClick={() => void decide(command, "reject")}>
                          <X className="size-3.5" /> Reject
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openTimeline(command)}
                      >
                        Timeline <ChevronRight className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={view === "approvals" ? ShieldAlert : History}
              title={view === "approvals" ? "No pending approvals" : "No matching commands"}
              description={view === "approvals"
                ? "The queue is clear. Supervised actions will appear here and beside the Operations composer."
                : "Adjust the filter or dispatch a command from Operations."}
            />
          )}
        </div>
      </Panel>

      {c.timelineCommand ? (
        <aside
          className="activity-trace"
          aria-label="Command trace"
        >
          <Panel className="activity-trace__panel">
            <SectionHeader
              compact
              eyebrow="Command trace"
              title={commandType(c.timelineCommand)}
              action={
                <>
                  <Button
                    className="activity-trace__back"
                    size="sm"
                    variant="ghost"
                    onClick={() => setTraceOpen(false)}
                  >
                    <ChevronLeft className="size-3.5" /> Activity
                  </Button>
                  <StatusBadge tone={tone(c.timelineCommand.status)} label={c.timelineCommand.status} />
                </>
              }
            />
            <div className="activity-trace__body">
              <div className="border-t border-control bg-console p-4 text-console-ink">
                <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {commandSummary(c.timelineCommand)}
                </p>
              </div>
              <div className="divide-y divide-control">
                {c.commandEvents.length ? c.commandEvents.map((event) => (
                  <div key={event.id} className="grid grid-cols-[12px_1fr] gap-3 px-4 py-4">
                    <span className="mt-1.5 size-2 rounded-full bg-primary ring-4 ring-primary/10" />
                    <div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold capitalize">{event.status.replaceAll("_", " ")}</p>
                        <time className="font-mono text-[10px] text-ink-faint">{formatRelativeTime(event.createdAt)}</time>
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        {event.actorType ?? "system"}{event.actorId ? `:${event.actorId}` : ""} · from {event.previousStatus ?? "created"}
                      </p>
                      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{renderEventResult(event.result)}</p>
                    </div>
                  </div>
                )) : (
                  <EmptyState compact icon={Clock3} title="No transitions" description="This command has no recorded events." />
                )}
              </div>
            </div>
          </Panel>
        </aside>
      ) : null}
    </div>
  );
}
