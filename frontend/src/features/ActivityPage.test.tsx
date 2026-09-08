import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import type { Controller } from "../controller";
import type { UserNotification } from "../types";
import { ConfirmProvider } from "../ui";
import { ActivityPage } from "./ActivityPage";

function notification(overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: "notification_1",
    kind: "provider.approval_required",
    severity: "attention",
    title: "Provider approval required",
    environmentId: "env_1",
    threadId: "thread_1",
    commandId: null,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    cursor: "000000000001",
    ...overrides,
  };
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    notifications: [notification()],
    notificationUnreadCount: 1,
    notificationsHaveMore: false,
    notificationsLoaded: true,
    notificationsError: null,
    backgroundLiveness: {
      scheduledWorker: {
        status: "healthy",
        lastAttemptAt: "2026-08-27T12:00:00.000Z",
        lastSuccessAt: "2026-08-27T12:00:00.000Z",
        lastFailureAt: null,
        nextExpectedBy: "2026-08-27T12:01:00.000Z",
        failureCode: null,
        expectedIntervalMs: 60_000,
      },
      observedAt: "2026-08-27T12:00:01.000Z",
    },
    backgroundLivenessError: null,
    pendingApprovals: [],
    recentCommands: [],
    commands: [],
    audit: [],
    commandEvents: [],
    timelineCommand: null,
    environments: [{ id: "env_1", label: "Studio Mac" }],
    connection: "live",
    busyAction: null,
    refreshAll: vi.fn(),
    refreshNotifications: vi.fn(),
    refreshBackgroundLiveness: vi.fn(),
    loadOlderNotifications: vi.fn(),
    markNotificationRead: vi.fn(async () => undefined),
    dismissNotification: vi.fn(async () => undefined),
    markAllNotificationsRead: vi.fn(async () => undefined),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    loadCommandTimeline: vi.fn(),
    api: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderPage(c = controller()) {
  render(
    <ConfirmProvider>
      <ActivityPage controller={c} />
    </ConfirmProvider>,
  );
  return c;
}

afterEach(() => {
  window.location.hash = "";
});

test("renders the durable notification center and keeps scheduler health separate", async () => {
  window.location.hash = "activity?view=notifications";
  const c = renderPage();

  expect(screen.getByText("Provider approval required")).toBeVisible();
  expect(screen.getByText("Studio Mac · thread thread_1")).toBeVisible();
  expect(screen.getByText(/This is scheduler evidence, separate from connector, T3, and provider health/u)).toBeVisible();
  expect(screen.getByText("healthy")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(c.markNotificationRead).toHaveBeenCalledWith("notification_1"));

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(c.dismissNotification).toHaveBeenCalledWith("notification_1"));
});

test("shows replay-aware error and reconnect states without claiming push delivery", () => {
  window.location.hash = "activity?view=notifications";
  renderPage(controller({
    notifications: [],
    notificationUnreadCount: 0,
    notificationsError: "Gateway unavailable.",
    backgroundLiveness: null,
    backgroundLivenessError: "Scheduler evidence unavailable.",
    connection: "reconnecting",
  }));

  expect(screen.getByRole("heading", { name: "Notifications are unavailable" })).toBeVisible();
  expect(screen.getByText(/Durable records will replay/u)).toBeVisible();
  expect(screen.getByText("Scheduler evidence unavailable.")).toBeVisible();
  expect(screen.getByRole("button", { name: /Retry/u })).toBeVisible();
});
