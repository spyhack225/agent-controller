import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { Command } from "../types";
import { ConfirmProvider } from "../ui";
import { QuickPage } from "./QuickPage";

const approval: Command = {
  id: "cmd_1",
  status: "approval_required",
  risk: "high",
  intent: { type: "shell_input", command: "rm -rf build" },
  createdAt: "2026-08-07T09:00:00.000Z",
};

function controller(overrides: Record<string, unknown> = {}) {
  return {
    busyAction: null,
    environments: [{ id: "env_1", label: "Studio Mac", baseUrl: "http://127.0.0.1:3773" }],
    threads: [{ id: "thread_1", label: "Agent Controller", status: "running", messages: [] }],
    actions: [],
    pendingApprovals: [],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ ok: true })),
    refreshAll: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderDashboard(c: Controller, onNavigate = vi.fn()) {
  render(
    <ConfirmProvider>
      <QuickPage controller={c} onNavigate={onNavigate} />
    </ConfirmProvider>,
  );
  return onNavigate;
}

test("keeps the dashboard focused on workspace, attention, and saved actions", () => {
  renderDashboard(controller());

  expect(screen.getByText("Current workspace")).toBeVisible();
  expect(screen.getByText("Needs attention")).toBeVisible();
  expect(screen.getByText("Quick actions")).toBeVisible();
  expect(screen.queryByText(/Speak a prompt/u)).toBeNull();
  expect(screen.queryByText(/Show the agent something/u)).toBeNull();
  expect(screen.queryByText(/Device setup/u)).toBeNull();
});

test("resumes the selected thread in Operations", () => {
  const onNavigate = renderDashboard(controller());

  expect(screen.getByRole("heading", { name: "Agent Controller" })).toBeVisible();
  expect(screen.getByText("Studio Mac · 0 messages")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Open Operations/u }));

  expect(onNavigate).toHaveBeenCalledWith("operate");
});

test("routes an operator without an environment to pairing", () => {
  const onNavigate = renderDashboard(controller({
    environments: [],
    threads: [],
    selectedEnvironmentId: "",
    selectedThreadId: "",
  }));

  expect(screen.getByText("Connect T3 Code to begin")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Pair an environment/u }));

  expect(onNavigate).toHaveBeenCalledWith("environments");
});

test("approves a waiting command from the attention section", async () => {
  const c = controller({ pendingApprovals: [approval] });
  renderDashboard(c);

  expect(screen.getByText("1 approval")).toBeVisible();
  expect(screen.getByText("rm -rf build")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /approve/i }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/commands/cmd_1/approve", {
    method: "POST",
    body: {},
  }));
});

test("runs a saved action against the selected thread", async () => {
  const c = controller({
    actions: [{ id: "action_1", label: "Run the test suite", type: "shell", payload: { command: "npm test" } }],
  });
  renderDashboard(c);

  fireEvent.click(screen.getByRole("button", { name: "Run Run the test suite" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_1/run", {
    method: "POST",
    body: { environmentId: "env_1", threadId: "thread_1" },
  }));
});

test("sends media actions to their dedicated flow", () => {
  renderDashboard(controller({
    actions: [{ id: "action_1", label: "Inspect photo", type: "media", payload: { mediaKind: "image" } }],
  }));

  expect(screen.getByText("Choose media from Actions")).toBeVisible();
  expect(screen.getByRole("button", { name: "Run Inspect photo" })).toBeDisabled();
});
