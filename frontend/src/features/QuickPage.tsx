import { ArrowRight, Check, CheckCircle2, CircleAlert, Play, X, Zap } from "lucide-react";

import type { Controller } from "../controller";
import { commandSummary, commandType, formatRelativeTime } from "../format";
import type { Command, PageId, SavedAction } from "../types";
import { Button, StatusBadge, useConfirm } from "../ui";

interface QuickPageProps {
  controller: Controller;
  onNavigate: (page: PageId) => void;
}

export function QuickPage({ controller: c, onNavigate }: QuickPageProps) {
  const confirm = useConfirm();
  const selectedEnvironment = c.environments.find(
    (environment) => environment.id === c.selectedEnvironmentId,
  ) ?? null;
  const selectedThread = c.threads.find((thread) => thread.id === c.selectedThreadId) ?? null;
  const savedActions = (c.actions ?? []).slice(0, 5);

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

  const runAction = async (action: SavedAction) => {
    await c.run(`action-${action.id}`, "Action dispatched.", async () => {
      const result = await c.api(`/v1/actions/${encodeURIComponent(action.id)}/run`, {
        method: "POST",
        body: {
          environmentId: c.selectedEnvironmentId || undefined,
          threadId: c.selectedThreadId || undefined,
        },
      });
      await c.refreshAll();
      return result;
    });
  };

  const workspaceTitle = !selectedEnvironment
    ? "Connect T3 Code to begin"
    : selectedThread?.label ?? "Choose a thread to continue";
  const workspaceDescription = !selectedEnvironment
    ? "Pair a workspace once, then resume agent work from this dashboard."
    : selectedThread
      ? `${selectedEnvironment.label} · ${selectedThread.messages?.length ?? 0} messages`
      : `${selectedEnvironment.label} is selected, but no thread is active.`;

  return (
    <div className="dashboard-home">
      <section className="dashboard-home__workspace" aria-labelledby="dashboard-workspace-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow">Current workspace</p>
            <h2 id="dashboard-workspace-title">{workspaceTitle}</h2>
          </div>
          <StatusBadge
            tone={!selectedEnvironment ? "warning" : selectedThread?.status === "running" ? "live" : "success"}
            label={!selectedEnvironment ? "not connected" : selectedThread?.status ?? (selectedThread ? "ready" : "no thread")}
          />
        </div>
        <p className="dashboard-home__description">{workspaceDescription}</p>
        <div className="dashboard-home__workspace-actions">
          <Button
            variant="primary"
            onClick={() => onNavigate(selectedEnvironment ? "operate" : "environments")}
          >
            {selectedEnvironment ? "Open Operations" : "Pair an environment"}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
          {selectedEnvironment && selectedThread ? (
            <span className="dashboard-home__context">
              Follow-up messages stay in this thread.
            </span>
          ) : null}
        </div>
      </section>

      <section className="dashboard-home__attention" aria-labelledby="dashboard-attention-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow">Needs attention</p>
            <h2 id="dashboard-attention-title">
              {c.pendingApprovals.length
                ? `${c.pendingApprovals.length} ${c.pendingApprovals.length === 1 ? "approval" : "approvals"}`
                : "All clear"}
            </h2>
          </div>
          {c.pendingApprovals.length
            ? <CircleAlert className="size-5 text-warning" aria-hidden="true" />
            : <CheckCircle2 className="size-5 text-success" aria-hidden="true" />}
        </div>

        {c.pendingApprovals.length ? (
          <div className="dashboard-approval-list">
            {c.pendingApprovals.slice(0, 4).map((command) => (
              <article key={command.id} className="dashboard-approval-row">
                <div className="dashboard-approval-row__copy">
                  <div>
                    <StatusBadge tone="warning" label={command.risk ?? "review"} />
                    <span>{commandType(command)}</span>
                    <time>{formatRelativeTime(command.createdAt)}</time>
                  </div>
                  <p>{commandSummary(command)}</p>
                </div>
                <div className="dashboard-approval-row__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    busy={c.busyAction === `approve-${command.id}`}
                    onClick={() => void decide(command, "approve")}
                  >
                    <Check className="size-3.5" aria-hidden="true" /> Approve
                  </Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => void decide(command, "reject")}>
                    <X className="size-3.5" aria-hidden="true" /> Reject
                  </Button>
                </div>
              </article>
            ))}
            {c.pendingApprovals.length > 4 ? (
              <Button variant="ghost" onClick={() => onNavigate("activity")}>
                View all approvals <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="dashboard-home__empty-row">
            <span>No commands are waiting for a decision.</span>
            <Button variant="ghost" onClick={() => onNavigate("activity")}>Open Activity</Button>
          </div>
        )}
      </section>

      <section className="dashboard-home__actions" aria-labelledby="dashboard-actions-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow">Quick actions</p>
            <h2 id="dashboard-actions-title">Saved actions</h2>
          </div>
          <StatusBadge tone="neutral" label={`${c.actions?.length ?? 0} saved`} />
        </div>

        {savedActions.length ? (
          <div className="dashboard-action-list">
            {savedActions.map((action) => {
              const requiresMedia = action.type === "media";
              const enabled = Boolean(c.selectedEnvironmentId && c.selectedThreadId && !requiresMedia);
              return (
                <div key={action.id} className="dashboard-action-row">
                  <span className="dashboard-action-row__icon" aria-hidden="true"><Zap className="size-4" /></span>
                  <span>
                    <strong>{action.label}</strong>
                    <small>{requiresMedia ? "Choose media from Actions" : action.type}</small>
                  </span>
                  <Button
                    size="sm"
                    busy={c.busyAction === `action-${action.id}`}
                    disabled={!enabled}
                    aria-label={`Run ${action.label}`}
                    onClick={() => void runAction(action)}
                  >
                    <Play className="size-3.5" aria-hidden="true" /> Run
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="dashboard-home__empty-row">
            <span>Create reusable prompts and commands for one-click access.</span>
            <Button onClick={() => onNavigate("actions")}>Create an action</Button>
          </div>
        )}
      </section>
    </div>
  );
}
