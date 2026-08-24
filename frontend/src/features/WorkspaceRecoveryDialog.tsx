import { AlertTriangle, Cable, Check, Clipboard, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui";

const T3_SETUP_COMMAND = "npm run setup:t3";

interface WorkspaceRecoveryDialogProps {
  open: boolean;
  message: string;
  retrying?: boolean;
  checking?: boolean;
  onClose: () => void;
  onRetry: () => void;
  onOpenEnvironments: () => void;
}

export function WorkspaceRecoveryDialog({
  open,
  message,
  retrying = false,
  checking = false,
  onClose,
  onRetry,
  onOpenEnvironments,
}: WorkspaceRecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const copySetupCommand = async () => {
    try {
      await navigator.clipboard.writeText(T3_SETUP_COMMAND);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  useEffect(() => {
    if (!open) setCopyState("idle");
  }, [open]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    retryButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] grid place-items-center overflow-y-auto bg-black/65 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-recovery-title"
        aria-describedby="workspace-recovery-description"
        className="w-full max-w-lg rounded-xl border border-control-strong bg-surface-raised shadow-raised"
      >
        <div className="flex items-start gap-3 border-b border-control px-5 py-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-warning/20 bg-warning/10 text-warning">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="eyebrow text-warning-strong">Connection interrupted</p>
            <h2 id="workspace-recovery-title" className="font-display text-lg font-semibold">
              Restart and reconnect T3 Code
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-md text-ink-muted outline-none hover:bg-surface-inset hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="Close recovery instructions"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p
            id="workspace-recovery-description"
            className="rounded-md border border-danger/20 bg-danger/8 px-3 py-2 font-mono text-xs text-danger"
            role="alert"
          >
            {message}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-muted">
            Agent Controller cannot read the selected workspace from its T3 host. The T3 process may
            have stopped, or its saved connection may no longer be reachable.
          </p>
          <ol className="mt-4 grid gap-4 text-sm">
            <li className="grid grid-cols-[1.5rem_1fr] gap-2">
              <span className="font-mono text-xs text-ink-faint">01</span>
              <div>
                <p className="font-semibold text-ink">Restart T3 Code on the workspace computer</p>
                <p className="mt-1 leading-relaxed text-ink-muted">
                  From the Agent Controller project, run the guided setup again:
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-control bg-console p-1.5 pl-3">
                  <code className="min-w-0 flex-1 overflow-x-auto text-xs text-console-ink">
                    {T3_SETUP_COMMAND}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="border-control-strong text-console-ink"
                    onClick={() => void copySetupCommand()}
                    aria-label={copyState === "copied" ? "Setup command copied" : "Copy setup command"}
                  >
                    {copyState === "copied"
                      ? <Check className="size-3.5 text-success" aria-hidden="true" />
                      : <Clipboard className="size-3.5" aria-hidden="true" />}
                    <span aria-live="polite">
                      {copyState === "copied" ? "Copied" : copyState === "error" ? "Try copy again" : "Copy"}
                    </span>
                  </Button>
                </div>
              </div>
            </li>
            <li className="grid grid-cols-[1.5rem_1fr] gap-2">
              <span className="font-mono text-xs text-ink-faint">02</span>
              <div>
                <p className="font-semibold text-ink">Confirm the connection</p>
                <p className="mt-1 leading-relaxed text-ink-muted">
                  Wait until setup reports that T3 Code is listening and paired. If its URL or
                  credential changed, update the environment connection before trying again.
                </p>
              </div>
            </li>
          </ol>
          <div
            className="mt-4 flex items-start gap-3 rounded-md border border-info/20 bg-info/8 px-3 py-2.5"
            role="status"
            aria-busy={checking}
          >
            {checking
              ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-info motion-reduce:animate-none" aria-hidden="true" />
              : <RefreshCw className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />}
            <div>
              <p className="text-sm font-semibold text-ink">Checking automatically</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                Operations will reload as soon as T3 Code is available.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-control px-5 py-4 sm:flex-row sm:justify-end">
          <Button onClick={onOpenEnvironments}>
            <Cable className="size-4" aria-hidden="true" /> Connection settings
          </Button>
          <Button ref={retryButtonRef} variant="primary" busy={retrying} disabled={checking} onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden="true" /> Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
