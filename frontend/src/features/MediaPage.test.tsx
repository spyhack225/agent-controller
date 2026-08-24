import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { ConfirmProvider } from "../ui";
import { MediaPage } from "./MediaPage";

function controller(overrides: Record<string, unknown> = {}) {
  return {
    media: [],
    busyAction: null,
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ media: {} })),
    refreshAll: vi.fn(),
    refreshMedia: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderMedia() {
  render(
    <ConfirmProvider>
      <MediaPage controller={controller()} />
    </ConfirmProvider>,
  );
}

test("keeps creation controls out of the library until Add media is requested", () => {
  renderMedia();

  expect(screen.getByRole("heading", { name: "Media context" })).toBeVisible();
  expect(screen.getByText("No stored media")).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull();

  fireEvent.click(screen.getAllByRole("button", { name: "Add media" })[0]);

  expect(screen.getByRole("dialog", { name: "Add media" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Upload file" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("Choose an image or audio file")).toBeVisible();
});

test("shows only the selected capture workflow", () => {
  renderMedia();
  fireEvent.click(screen.getAllByRole("button", { name: "Add media" })[0]);

  fireEvent.click(screen.getByRole("tab", { name: "Record audio" }));
  expect(screen.getByRole("button", { name: "Start recording" })).toBeVisible();
  expect(screen.queryByText("Choose an image or audio file")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Use camera" }));
  expect(screen.getByText("Camera is off")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open camera" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();
});

test("reveals transcript input only after an audio file is chosen", () => {
  renderMedia();
  fireEvent.click(screen.getAllByRole("button", { name: "Add media" })[0]);

  expect(screen.queryByLabelText("Audio transcript")).toBeNull();
  const picker = screen.getByLabelText(/Choose an image or audio file/i);
  fireEvent.change(picker, {
    target: { files: [new File(["audio"], "note.webm", { type: "audio/webm" })] },
  });

  expect(screen.getByLabelText("Audio transcript")).toBeVisible();
});

test("Escape closes Add media and returns to the library", () => {
  renderMedia();
  fireEvent.click(screen.getAllByRole("button", { name: "Add media" })[0]);
  expect(screen.getByRole("dialog", { name: "Add media" })).toBeVisible();

  fireEvent.keyDown(window, { key: "Escape" });

  expect(screen.queryByRole("dialog", { name: "Add media" })).toBeNull();
  expect(screen.getByText("No stored media")).toBeVisible();
});
