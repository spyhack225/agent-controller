import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { OnboardingReadiness, OnboardingState } from "../types";
import { OnboardingPage } from "./OnboardingPage";

const baseOnboarding: OnboardingState = {
  version: 2,
  status: "in_progress",
  currentStep: "host",
  networkMode: "local",
  networkUrl: null,
  provider: { harness: "auto", instanceId: null, model: null },
  workspace: { path: null, title: null, projectId: null },
  environmentId: null,
  firstThreadId: null,
  device: { mode: null, deviceId: null, credentialConfirmed: false },
  startedAt: "2026-07-24T10:00:00.000Z",
  pausedAt: null,
  completedAt: null,
  updatedAt: "2026-07-24T10:00:00.000Z",
};

const baseReadiness: OnboardingReadiness = {
  checks: {
    account: true,
    hostPlan: false,
    environmentPaired: false,
    environmentReachable: false,
    workspaceSelected: false,
    providerConfigured: false,
    firstRunDispatched: false,
    deviceReady: false,
  },
  ready: false,
  environment: null,
  device: null,
};

function controller(overrides: Record<string, unknown> = {}) {
  const saveOnboarding = vi.fn(async () => ({
    onboarding: baseOnboarding,
    readiness: baseReadiness,
  }));
  return {
    authenticated: true,
    onboardingLoaded: true,
    onboarding: baseOnboarding,
    onboardingReadiness: baseReadiness,
    environments: [],
    projects: [],
    devices: [],
    deviceProfiles: [{ id: "agent-controller", label: "Agent Controller" }],
    deviceSecret: null,
    busyAction: null,
    clerk: { userLabel: "person@example.test" },
    setNotice: vi.fn(),
    setDeviceSecret: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(),
    refreshAll: vi.fn(),
    refreshCommands: vi.fn(),
    loadSnapshot: vi.fn(),
    saveOnboarding,
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

test("keeps host validation errors inline and does not discard the current step", async () => {
  const c = controller();
  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  const continueButton = await screen.findByRole("button", { name: /ready to connect/i });
  fireEvent.click(continueButton);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter the workspace path on the T3 host.",
  );
  expect(c.saveOnboarding).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "T3 host" })).toBeVisible();
});

test("recovers a pending one-time device registration without silently duplicating it", async () => {
  const pendingRegistration: OnboardingState = {
    ...baseOnboarding,
    currentStep: "device",
    networkMode: "local",
    networkUrl: "http://127.0.0.1:3773",
    provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
    workspace: {
      path: "/work/agent-controller",
      title: "Agent Controller",
      projectId: "project_1",
    },
    environmentId: "env_1",
    firstThreadId: "thread_1",
    device: {
      mode: "register",
      deviceId: "device_1",
      credentialConfirmed: false,
    },
  };
  const readiness: OnboardingReadiness = {
    ...baseReadiness,
    checks: {
      account: true,
      hostPlan: true,
      environmentPaired: true,
      environmentReachable: true,
      workspaceSelected: true,
      providerConfigured: true,
      firstRunDispatched: true,
      deviceReady: false,
    },
  };
  const saveOnboarding = vi.fn(async (input: Partial<OnboardingState>) => ({
    onboarding: {
      ...pendingRegistration,
      ...input,
      device: input.device ?? pendingRegistration.device,
    },
    readiness: { ...readiness, checks: { ...readiness.checks, deviceReady: true }, ready: true },
  }));
  const c = controller({
    onboarding: pendingRegistration,
    onboardingReadiness: readiness,
    devices: [{
      id: "device_1",
      label: "Desk controller",
      profile: "agent-controller",
      config: { environmentId: "env_1", threadId: "thread_1" },
    }],
    saveOnboarding,
  });

  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  expect(await screen.findByText("One-time credential is no longer visible")).toBeVisible();
  const continueButton = screen.getByRole("button", { name: /copied it/i });
  expect(continueButton).toBeDisabled();

  fireEvent.click(screen.getByRole("checkbox", { name: /saved the credential/i }));
  expect(continueButton).toBeEnabled();
  fireEvent.click(continueButton);

  await waitFor(() => expect(saveOnboarding).toHaveBeenCalledWith(expect.objectContaining({
    currentStep: "ready",
    device: {
      mode: "register",
      deviceId: "device_1",
      credentialConfirmed: true,
    },
  })));
});
