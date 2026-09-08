import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { SavedAction } from "../types";
import { ConfirmProvider } from "../ui";
import { ActionsPage } from "./ActionsPage";

function controller(actions: SavedAction[] = []) {
  return {
    actions,
    environments: [{ id: "env_1", label: "Studio Mac" }],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    media: [],
    busyAction: null,
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ action: { id: "action_new" } })),
    refreshAll: vi.fn(async () => undefined),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

function renderPage(c: Controller) {
  return render(<ConfirmProvider><ActionsPage controller={c} /></ConfirmProvider>);
}

test("creates a policy-screened shell action", async () => {
  const c = controller();
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "New action" }));
  expect(screen.getByRole("dialog", { name: "Create action" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /ShellA policy-screened command/u }));
  fireEvent.change(screen.getByLabelText("Display label"), { target: { value: "Run checks" } });
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npm test" } });
  fireEvent.click(screen.getByRole("dialog", { name: "Create action" }).querySelector("footer button:last-child")!);

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions", {
    method: "POST",
    body: expect.objectContaining({
      label: "Run checks",
      type: "shell",
      payload: { command: "npm test" },
      targetMode: "device-current",
    }),
  }));
});

test("runs, edits, and duplicates an existing action", async () => {
  const action: SavedAction = {
    id: "action_review",
    label: "Review branch",
    type: "prompt",
    intent: { type: "agent_prompt", text: "Review the current branch" },
  };
  const c = controller([action]);
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_review/run", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      clientRequestId: expect.stringMatching(/^web:/u),
    },
  }));

  fireEvent.click(screen.getByRole("button", { name: "Duplicate Review branch" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions", expect.objectContaining({
    method: "POST",
    body: expect.objectContaining({ label: "Review branch copy" }),
  })));

  fireEvent.click(screen.getByRole("button", { name: "Edit Review branch" }));
  fireEvent.change(screen.getByLabelText("Display label"), { target: { value: "Review release" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_review", expect.objectContaining({
    method: "PUT",
    body: expect.objectContaining({ label: "Review release" }),
  })));
});

test("builds an ordered macro from reusable actions", async () => {
  const step: SavedAction = {
    id: "action_test",
    label: "Run tests",
    type: "shell",
    intent: { type: "shell_input", command: "npm test" },
  };
  const mediaAction: SavedAction = {
    id: "action_photo",
    label: "Inspect photo",
    type: "media",
    payload: { mediaKind: "image", prompt: "Inspect this image" },
  };
  const c = controller([step, mediaAction]);
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "New action" }));
  fireEvent.click(screen.getByRole("button", { name: /MacroAn ordered sequence/u }));
  fireEvent.change(screen.getByLabelText("Display label"), { target: { value: "Release check" } });
  fireEvent.change(screen.getByLabelText("Action to add"), { target: { value: "action_test" } });
  expect(screen.getByRole("option", { name: "Run tests" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "Inspect photo" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add step" }));
  fireEvent.click(screen.getByRole("button", { name: "Create action" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions", expect.objectContaining({
    method: "POST",
    body: expect.objectContaining({
      type: "macro",
      steps: [{ actionId: "action_test", continueOnFailure: false, position: 0 }],
    }),
  })));
});

test("requires and dispatches a compatible media upload when testing a media action", async () => {
  const action: SavedAction = {
    id: "action_photo",
    label: "Inspect photo",
    type: "media",
    payload: { mediaKind: "image", prompt: "Inspect this image" },
  };
  const c = controller([action]);
  c.media = [
    { id: "media_audio", kind: "audio", contentType: "audio/webm", originalName: "note.webm" },
    { id: "media_image", kind: "image", contentType: "image/jpeg", originalName: "board.jpg" },
  ];
  renderPage(c);

  const run = screen.getByRole("button", { name: "Run" });
  expect(run).toBeDisabled();
  const mediaSelect = screen.getByLabelText("Media for Inspect photo");
  expect(screen.getByRole("option", { name: "board.jpg" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "note.webm" })).not.toBeInTheDocument();
  fireEvent.change(mediaSelect, { target: { value: "media_image" } });
  expect(run).toBeEnabled();
  fireEvent.click(run);

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_photo/run", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      mediaUploadId: "media_image",
      clientRequestId: expect.stringMatching(/^web:/u),
    },
  }));
});

test("explains why a media action cannot run without a compatible upload", () => {
  const action: SavedAction = {
    id: "action_voice",
    label: "Transcribe note",
    type: "media",
    payload: { mediaKind: "audio", prompt: "Transcribe and summarize" },
  };
  const c = controller([action]);
  c.media = [{ id: "media_image", kind: "image", contentType: "image/jpeg" }];
  renderPage(c);

  expect(screen.getByText("Upload a compatible audio to test this action.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});
