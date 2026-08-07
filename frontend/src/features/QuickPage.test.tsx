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
    authenticated: true,
    busyAction: null,
    environments: [{ id: "env_1", label: "Studio Mac", baseUrl: "http://127.0.0.1:3773" }],
    threads: [{ id: "thread_1", label: "Agent Controller" }],
    macros: [],
    devices: [],
    media: [],
    pendingApprovals: [],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    setSelectedEnvironmentId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    approvalNotificationsEnabled: false,
    notificationSupport: "default",
    enableApprovalNotifications: vi.fn(async () => "granted"),
    disableApprovalNotifications: vi.fn(),
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ ok: true })),
    refreshAll: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderQuick(c: Controller, onNavigate = vi.fn()) {
  render(
    <ConfirmProvider>
      <QuickPage controller={c} onNavigate={onNavigate} />
    </ConfirmProvider>,
  );
  return onNavigate;
}

test("approves a waiting command straight from the phone surface", async () => {
  const c = controller({ pendingApprovals: [approval] });
  renderQuick(c);

  expect(screen.getByText("1 waiting on you")).toBeVisible();
  expect(screen.getByText("rm -rf build")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /approve/i }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/commands/cmd_1/approve", {
    method: "POST",
    body: {},
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});

test("only asks for notification permission when the operator opts in", async () => {
  const c = controller({ pendingApprovals: [approval] });
  renderQuick(c);

  expect(c.enableApprovalNotifications).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /enable approval notifications/i }));

  await waitFor(() => expect(c.enableApprovalNotifications).toHaveBeenCalledTimes(1));
});

test("explains a blocked permission instead of silently doing nothing", async () => {
  const c = controller({
    notificationSupport: "denied",
    enableApprovalNotifications: vi.fn(async () => "denied"),
  });
  renderQuick(c);

  fireEvent.click(screen.getByRole("button", { name: /enable approval notifications/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/blocked for this site/i);
});

test("hides the opt-in once notifications are already on", () => {
  renderQuick(controller({ approvalNotificationsEnabled: true }));

  expect(screen.queryByRole("button", { name: /enable approval notifications/i })).toBeNull();
});

test("runs a saved macro with one tap against the selected target", async () => {
  const c = controller({ macros: [{ id: "macro_1", label: "Run the test suite" }] });
  renderQuick(c);

  fireEvent.click(screen.getByRole("button", { name: /run the test suite/i }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/macros/macro_1/run", {
    method: "POST",
    body: { environmentId: "env_1", threadId: "thread_1" },
  }));
});

test("offers push-to-talk and camera controls sized for a handset", () => {
  renderQuick(controller());

  expect(screen.getByRole("button", { name: /hold to record a voice prompt/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^open$/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/question about the frame/i)).toBeInTheDocument();
});

test("routes an operator with no paired environment to pairing instead of dead controls", () => {
  const c = controller({ environments: [], selectedEnvironmentId: "", threads: [] });
  const onNavigate = renderQuick(c);

  expect(screen.getByText("no environment")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /pair an environment/i }));

  expect(onNavigate).toHaveBeenCalledWith("environments");
});

test("keeps macros disabled until a target environment exists", () => {
  const c = controller({
    environments: [],
    selectedEnvironmentId: "",
    threads: [],
    macros: [{ id: "macro_1", label: "Run the test suite" }],
  });
  renderQuick(c);

  expect(screen.getByRole("button", { name: /run the test suite/i })).toBeDisabled();
});
