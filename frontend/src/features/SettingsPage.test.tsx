import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { ConfirmProvider } from "../ui";
import { SettingsPage } from "./SettingsPage";

function controller(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    authConfig: { clerk: { enabled: true } },
    clerk: {
      loaded: true,
      signedIn: true,
      userLabel: "owner@example.test",
      openUserProfile: vi.fn(),
      openSignIn: vi.fn(),
    },
    busyAction: null,
    environments: [],
    privacyDays: 30,
    setPrivacyDays: vi.fn(),
    media: [],
    approvalNotificationsEnabled: false,
    notificationSupport: "default",
    enableApprovalNotifications: vi.fn(async () => "granted"),
    disableApprovalNotifications: vi.fn(),
    setNotice: vi.fn(),
    api: vi.fn(async () => undefined),
    refreshAll: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    onboarding: { status: "completed" },
    downloadDiagnostics: vi.fn(),
    connection: "connected",
    lastResult: { message: "ready" },
    signOut: vi.fn(),
    remoteAccess: null,
    loadRemoteAccess: vi.fn(),
    ...overrides,
  } as unknown as Controller;
}

function renderSettings(c = controller()) {
  render(
    <ConfirmProvider>
      <SettingsPage controller={c} />
    </ConfirmProvider>,
  );
  return c;
}

test("recommends private Serve and gives a runnable setup command", () => {
  renderSettings();

  expect(screen.getByRole("heading", { name: "Connect securely from anywhere" })).toBeVisible();
  expect(screen.getByRole("button", { name: /Tailscale Serve/i })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("npm run setup:tunnel -- --mode serve --write-env")).toBeVisible();
  expect(screen.getByText(/trusted private network/i)).toBeVisible();
});

test("makes public Funnel exposure explicit before showing its command", () => {
  renderSettings();

  fireEvent.click(screen.getByRole("button", { name: /Tailscale Funnel/i }));

  expect(screen.getByRole("button", { name: /Tailscale Funnel/i })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("npm run setup:tunnel -- --mode funnel --write-env")).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent(/public internet/i);
  expect(screen.getByRole("note")).toHaveTextContent(/Clerk/i);
});

test("recognizes an existing tunnel and stops presenting setup as unfinished", () => {
  renderSettings(controller({
    remoteAccess: {
      checkedAt: "2026-08-08T17:00:00.000Z",
      gateway: {
        host: "0.0.0.0",
        port: 3996,
        loopbackUrl: "http://127.0.0.1:3996",
        lanUrls: ["http://192.168.1.162:3996"],
        publicBaseUrl: "https://studio.example.ts.net",
      },
      tailscale: {
        installed: true,
        connected: true,
        backendState: "Running",
        dnsName: "studio.example.ts.net",
        ips: ["100.64.0.4"],
        httpsUrl: "https://studio.example.ts.net",
        serve: { active: true, statusAvailable: true },
        funnel: { active: false, statusAvailable: true },
        mode: "serve",
        publicBaseUrlConfigured: true,
        ready: true,
        error: null,
        nextStep: "ready",
      },
    },
  }));

  expect(screen.getByText("Remote access is configured")).toBeVisible();
  expect(screen.getByRole("link", { name: /Open remote console/i })).toHaveAttribute(
    "href",
    "https://studio.example.ts.net",
  );
  expect(screen.queryByText("npm run setup:tunnel -- --mode serve --write-env")).toBeNull();
});
