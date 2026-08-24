/**
 * Loading the selected environment's projects and threads, for whichever page the operator happens
 * to land on.
 *
 * This used to live inside Operations, which made Operations the only place a workspace could come
 * from: the Dashboard is the default page, but until someone visited Operations it had no threads
 * and could only tell them to go there. The snapshot fetch is the same either way, and
 * `loadSnapshot` already selects a thread out of what it finds, so sharing the loader is what makes
 * landing on the Dashboard enough.
 *
 * Only one page is mounted at a time, and the effect skips the fetch when threads or projects are
 * already in hand, so moving between pages does not re-fetch a workspace that is already loaded.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Controller } from "./controller";

export type WorkspaceLoadStatus = "loading" | "loaded" | "failed";

export interface WorkspaceLoader {
  /** The status of the *currently selected* environment, or null when none is selected. */
  status: WorkspaceLoadStatus | null;
  /** Re-run the fetch by hand — the Retry and Refresh affordances. */
  loadWorkspace: (environmentId: string) => Promise<void>;
}

export function useWorkspaceLoader(c: Controller): WorkspaceLoader {
  // Which environment the in-flight load belongs to. A load that finishes after the operator has
  // moved on must not report its result over the newer selection.
  const loadingEnvironmentRef = useRef<string | null>(null);
  const [state, setState] = useState<{
    environmentId: string;
    status: WorkspaceLoadStatus;
  } | null>(null);

  const loadWorkspace = useCallback(async (environmentId: string) => {
    if (!environmentId) return;
    loadingEnvironmentRef.current = environmentId;
    setState({ environmentId, status: "loading" });
    try {
      await c.loadSnapshot(environmentId);
      if (loadingEnvironmentRef.current === environmentId) {
        setState({ environmentId, status: "loaded" });
      }
    } catch {
      if (loadingEnvironmentRef.current === environmentId) {
        setState({ environmentId, status: "failed" });
      }
    }
  }, [c.loadSnapshot]);

  useEffect(() => {
    const environmentId = c.selectedEnvironmentId;
    if (!environmentId) {
      loadingEnvironmentRef.current = null;
      setState(null);
      return;
    }
    if (c.threads.length > 0 || c.projects.length > 0) {
      setState({ environmentId, status: "loaded" });
      return;
    }
    if (loadingEnvironmentRef.current === environmentId) return;
    void loadWorkspace(environmentId);
  }, [c.projects.length, c.selectedEnvironmentId, c.threads.length, loadWorkspace]);

  return {
    status: state?.environmentId === c.selectedEnvironmentId ? state.status : null,
    loadWorkspace,
  };
}
