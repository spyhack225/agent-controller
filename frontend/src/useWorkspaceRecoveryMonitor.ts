import { useEffect, useRef, useState } from "react";

interface WorkspaceRecoveryMonitorOptions {
  environmentId: string | null;
  checkAvailability: (environmentId: string) => Promise<boolean>;
  reloadWorkspace: (environmentId: string) => Promise<void>;
  onRecovered: () => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

export function useWorkspaceRecoveryMonitor({
  environmentId,
  checkAvailability,
  reloadWorkspace,
  onRecovered,
  initialDelayMs = 1500,
  intervalMs = 4000,
}: WorkspaceRecoveryMonitorOptions) {
  const callbacksRef = useRef({ checkAvailability, reloadWorkspace, onRecovered });
  const [checking, setChecking] = useState(false);
  callbacksRef.current = { checkAvailability, reloadWorkspace, onRecovered };

  useEffect(() => {
    setChecking(false);
    if (!environmentId) return;

    let cancelled = false;
    let timer: number | null = null;

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
        if (!recovered) timer = window.setTimeout(check, intervalMs);
      }
    };

    timer = window.setTimeout(check, initialDelayMs);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [environmentId, initialDelayMs, intervalMs]);

  return { checking: Boolean(environmentId) && checking };
}
