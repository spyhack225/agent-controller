import { useEffect, useRef, useState } from "react";

interface WorkspaceRecoveryMonitorOptions {
  environmentId: string | null;
  /**
   * False for a failure the owner has to act on. Polling a rejected credential or an incompatible
   * host cannot succeed, so the watch pauses instead of hammering the gateway.
   */
  retryable?: boolean;
  /** Changes when the owner replaces this environment's credential, which re-arms a paused watch. */
  credentialKey?: string;
  checkAvailability: (environmentId: string) => Promise<boolean>;
  reloadWorkspace: (environmentId: string) => Promise<void>;
  onRecovered: () => void;
  initialDelayMs?: number;
  intervalMs?: number;
  maxIntervalMs?: number;
}

export function useWorkspaceRecoveryMonitor({
  environmentId,
  retryable = true,
  credentialKey = "",
  checkAvailability,
  reloadWorkspace,
  onRecovered,
  initialDelayMs = 1500,
  intervalMs = 4000,
  maxIntervalMs = 30000,
}: WorkspaceRecoveryMonitorOptions) {
  const callbacksRef = useRef({ checkAvailability, reloadWorkspace, onRecovered });
  const armedRef = useRef<{ environmentId: string; credentialKey: string } | null>(null);
  const [checking, setChecking] = useState(false);
  callbacksRef.current = { checkAvailability, reloadWorkspace, onRecovered };

  useEffect(() => {
    setChecking(false);
    if (!environmentId) {
      armedRef.current = null;
      return;
    }

    // A replaced credential earns exactly one probe: if it is still wrong the watch pauses again
    // rather than restarting the loop against a credential that cannot work.
    const armed = armedRef.current;
    const probeOnce = !retryable
      && armed !== null
      && armed.environmentId === environmentId
      && armed.credentialKey !== credentialKey;
    armedRef.current = { environmentId, credentialKey };
    if (!retryable && !probeOnce) return;

    let cancelled = false;
    let timer: number | null = null;
    let attempt = 0;

    const check = async () => {
      if (cancelled) return;
      setChecking(true);
      let recovered = false;
      try {
        const available = await callbacksRef.current.checkAvailability(environmentId);
        if (cancelled || !available) return;
        await callbacksRef.current.reloadWorkspace(environmentId);
        recovered = true;
        callbacksRef.current.onRecovered();
      } catch {
        // T3 may remain unavailable while its setup command is running. Keep watching quietly.
      } finally {
        if (cancelled) return;
        setChecking(false);
        if (!recovered && !probeOnce) {
          timer = window.setTimeout(check, Math.min(intervalMs * 2 ** attempt, maxIntervalMs));
          attempt += 1;
        }
      }
    };

    timer = window.setTimeout(check, initialDelayMs);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [credentialKey, environmentId, initialDelayMs, intervalMs, maxIntervalMs, retryable]);

  return { checking: Boolean(environmentId) && checking };
}
