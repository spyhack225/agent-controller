/**
 * Approval notifications.
 *
 * A command that stops on `approval_required` is blocking real work on the operator's
 * machine, so the phone build raises an OS notification when the console is not the
 * foreground tab. Permission is requested lazily — only when the operator opts in from
 * Settings — never on page load.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { commandSummary, commandType } from "./format";
import { serviceWorkerRegistration } from "./pwa";
import type { Command } from "./types";

export const APPROVAL_NOTIFICATION_STORAGE_KEY = "agentControllerApprovalNotifications";

/** `unsupported` is distinct from `denied`: the operator can still fix `denied` in browser settings. */
export type NotificationSupportState = "unsupported" | "default" | "granted" | "denied";

export interface ApprovalNotificationPayload {
  tag: string;
  title: string;
  body: string;
  url: string;
}

export interface ApprovalNotificationPlan {
  notifications: ApprovalNotificationPayload[];
  /** The ids to carry forward as "already announced". Pruned to what is still pending. */
  seen: string[];
}

export function readNotificationSupport(): NotificationSupportState {
  if (typeof window === "undefined") return "unsupported";
  const api = (window as { Notification?: typeof Notification }).Notification;
  if (typeof api !== "function") return "unsupported";
  const permission = api.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

export function readApprovalNotificationPreference(): boolean {
  try {
    return localStorage.getItem(APPROVAL_NOTIFICATION_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeApprovalNotificationPreference(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(APPROVAL_NOTIFICATION_STORAGE_KEY, "on");
    else localStorage.removeItem(APPROVAL_NOTIFICATION_STORAGE_KEY);
  } catch {
    // Preference persistence is a convenience; the in-memory toggle still works.
  }
}

/**
 * Decides what to announce for the current pending-approval set.
 *
 * Approvals seen while the tab was in the foreground are recorded as announced without
 * firing anything, so backgrounding the tab later never replays a queue the operator
 * has already looked at.
 */
export function planApprovalNotifications(options: {
  pending: readonly Command[];
  seen: readonly string[];
  enabled: boolean;
  permission: NotificationSupportState;
  hidden: boolean;
}): ApprovalNotificationPlan {
  const seen = options.pending.map((command) => command.id);
  const active = options.enabled && options.permission === "granted" && options.hidden;
  if (!active) return { notifications: [], seen };

  const previous = new Set(options.seen);
  const fresh = options.pending.filter((command) => !previous.has(command.id));
  if (fresh.length === 0) return { notifications: [], seen };

  if (fresh.length > 2) {
    return {
      notifications: [{
        tag: "agent-controller-approvals",
        title: `${fresh.length} commands need approval`,
        body: "Open Agent Controller to review the approval queue.",
        url: "/#activity",
      }],
      seen,
    };
  }

  return {
    notifications: fresh.map((command) => ({
      tag: `agent-controller-approval-${command.id}`,
      title: `Approval required: ${commandType(command)}`,
      body: commandSummary(command),
      url: "/#activity",
    })),
    seen,
  };
}

export async function deliverApprovalNotification(payload: ApprovalNotificationPayload): Promise<boolean> {
  const options: NotificationOptions = {
    body: payload.body,
    tag: payload.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    data: { url: payload.url },
  };

  // Android Chrome throws on `new Notification()`; the worker registration is the
  // supported path there and also gives us the notificationclick handler.
  const registration = await serviceWorkerRegistration();
  if (registration?.showNotification) {
    try {
      await registration.showNotification(payload.title, options);
      return true;
    } catch {
      // Fall through to the page-level constructor.
    }
  }

  try {
    const api = (window as { Notification?: typeof Notification }).Notification;
    if (typeof api !== "function") return false;
    const notification = new api(payload.title, options);
    notification.onclick = () => {
      window.focus();
      window.location.hash = payload.url.replace(/^\/?#?/, "");
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

export interface ApprovalNotificationsController {
  /** Whether the operator has opted in (independent of the browser permission). */
  approvalNotificationsEnabled: boolean;
  notificationSupport: NotificationSupportState;
  /** Lazily prompts for permission. Returns the resulting permission state. */
  enableApprovalNotifications: () => Promise<NotificationSupportState>;
  disableApprovalNotifications: () => void;
}

export function useApprovalNotifications(
  pendingApprovals: readonly Command[],
): ApprovalNotificationsController {
  const [enabled, setEnabled] = useState(readApprovalNotificationPreference);
  const [permission, setPermission] = useState<NotificationSupportState>(readNotificationSupport);
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  const seenRef = useRef<string[]>([]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    const plan = planApprovalNotifications({
      pending: pendingApprovals,
      seen: seenRef.current,
      enabled,
      permission,
      hidden,
    });
    seenRef.current = plan.seen;
    for (const payload of plan.notifications) void deliverApprovalNotification(payload);
  }, [enabled, hidden, pendingApprovals, permission]);

  const enableApprovalNotifications = useCallback(async () => {
    const support = readNotificationSupport();
    if (support === "unsupported") {
      setPermission("unsupported");
      return "unsupported" as const;
    }
    let result: NotificationSupportState = support;
    if (support === "default") {
      try {
        const requested = await Notification.requestPermission();
        result = requested === "granted" || requested === "denied" ? requested : "default";
      } catch {
        result = "default";
      }
    }
    setPermission(result);
    const granted = result === "granted";
    setEnabled(granted);
    writeApprovalNotificationPreference(granted);
    return result;
  }, []);

  const disableApprovalNotifications = useCallback(() => {
    setEnabled(false);
    writeApprovalNotificationPreference(false);
  }, []);

  return {
    approvalNotificationsEnabled: enabled && permission === "granted",
    notificationSupport: permission,
    enableApprovalNotifications,
    disableApprovalNotifications,
  };
}
