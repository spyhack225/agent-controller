import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { WorkspaceRecoveryDialog } from "./WorkspaceRecoveryDialog";

test("shows T3 restart and reconnection guidance", () => {
  render(
    <WorkspaceRecoveryDialog
      open
      message="T3 snapshot is unavailable."
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onOpenEnvironments={vi.fn()}
    />,
  );

  expect(screen.getByRole("dialog", { name: /Restart and reconnect T3 Code/u })).toBeVisible();
  expect(screen.getByText("T3 snapshot is unavailable.")).toBeVisible();
  expect(screen.getByText("npm run setup:t3")).toBeVisible();
  expect(screen.getByRole("button", { name: /Copy setup command/u })).toBeVisible();
  expect(screen.getByRole("button", { name: /Connection settings/u })).toBeVisible();
  expect(screen.getByRole("button", { name: /Try again/u })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Operations will reload as soon as T3 Code is available.");
});

test("shows the active automatic check and prevents an overlapping manual retry", () => {
  render(
    <WorkspaceRecoveryDialog
      open
      checking
      message="T3 snapshot is unavailable."
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onOpenEnvironments={vi.fn()}
    />,
  );

  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: /Try again/u })).toBeDisabled();
});

test("copies the setup command and confirms success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <WorkspaceRecoveryDialog
      open
      message="T3 snapshot is unavailable."
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onOpenEnvironments={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Copy setup command/u }));

  expect(writeText).toHaveBeenCalledWith("npm run setup:t3");
  expect(await screen.findByRole("button", { name: /Setup command copied/u })).toHaveTextContent("Copied");
});

test("supports retry, settings, and keyboard dismissal", () => {
  const onClose = vi.fn();
  const onRetry = vi.fn();
  const onOpenEnvironments = vi.fn();
  render(
    <WorkspaceRecoveryDialog
      open
      message="T3 snapshot is unavailable."
      onClose={onClose}
      onRetry={onRetry}
      onOpenEnvironments={onOpenEnvironments}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Try again/u }));
  fireEvent.click(screen.getByRole("button", { name: /Connection settings/u }));
  fireEvent.keyDown(window, { key: "Escape" });

  expect(onRetry).toHaveBeenCalledOnce();
  expect(onOpenEnvironments).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
