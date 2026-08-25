import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { MediaItem } from "../types";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

const MEDIA: MediaItem[] = [
  {
    id: "media_1",
    kind: "image",
    contentType: "image/png",
    originalName: "first.png",
    processing: { visionStatus: "ready" },
  },
  {
    id: "media_2",
    kind: "image",
    contentType: "image/png",
    originalName: "second.png",
    processing: { visionStatus: "pending" },
  },
  {
    id: "media_3",
    kind: "image",
    contentType: "image/jpeg",
    originalName: "third.jpg",
    processing: { visionStatus: "ready" },
  },
];

function controller(overrides: Record<string, unknown> = {}) {
  return {
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedProjectId: "project_1",
    selectedProject: { id: "project_1", title: "Tacs" },
    environments: [{ id: "env_1", label: "Mac T3" }],
    threads: [{ id: "thread_1", label: "Thread", projectId: "project_1" }],
    projects: [{ id: "project_1", title: "Tacs" }],
    harnesses: [],
    harnessCatalogueSource: "registered",
    sessionFailures: [],
    suggestedModelSelection: null,
    commands: [],
    commandEvents: [],
    macros: [],
    media: MEDIA,
    pendingApprovals: [],
    recentCommands: [],
    display: { counts: {} },
    busyAction: null,
    setNotice: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(async () => ({ command: { id: "cmd_1" } })),
    // The Operate view leases a live thread watch while a thread is on screen; without these the
    // page throws in an effect before a single assertion runs.
    liveThread: null,
    watchThread: vi.fn(),
    refreshAll: vi.fn(),
    uploadMedia: vi.fn(),
    loadSnapshot: vi.fn(async () => ({})),
    launchProject: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

// One attachment button, one source menu. The library stays open between picks so several
// uploads can be attached in the order the user wants them sent.
function openLibrary() {
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
}

function attach(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Attach ${name}` }));
}

function chipNames() {
  return within(screen.getByRole("list", { name: "Attachments" }))
    .getAllByRole("listitem")
    .map((chip) => chip.querySelector(".thread-attachment-chip__name")?.textContent);
}

test("several uploads can be attached, and each chip names its kind and state", () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);
  openLibrary();

  attach("first.png");
  attach("second.png");

  expect(chipNames()).toEqual(["first.png", "second.png"]);
  const chips = within(screen.getByRole("list", { name: "Attachments" })).getAllByRole("listitem");
  expect(chips[0].textContent).toContain("image · ready");
  expect(chips[1].textContent).toContain("image · pending");
  // An attached upload is no longer offered a second time.
  expect(screen.queryByRole("button", { name: "Attach first.png" })).toBeNull();
});

test("an attachment can be removed without disturbing the rest of the order", () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);
  openLibrary();

  attach("first.png");
  attach("second.png");
  attach("third.jpg");
  fireEvent.click(screen.getByRole("button", { name: "Remove second.png" }));

  expect(chipNames()).toEqual(["first.png", "third.jpg"]);
});

test("attachments can be reordered and dispatch in the order shown", async () => {
  const c = controller();
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);
  openLibrary();

  attach("first.png");
  attach("second.png");
  attach("third.jpg");
  fireEvent.click(screen.getByRole("button", { name: "Move third.jpg earlier" }));
  expect(chipNames()).toEqual(["first.png", "third.jpg", "second.png"]);

  fireEvent.click(screen.getByRole("button", { name: "Move first.png later" }));
  expect(chipNames()).toEqual(["third.jpg", "first.png", "second.png"]);

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalled());
  const [path, init] = (c.api as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(path).toBe("/v1/intents");
  expect(init.body.intent.mediaUploadIds).toEqual(["media_3", "media_1", "media_2"]);
});

test("the first and last chips cannot be moved out of the list", () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);
  openLibrary();

  attach("first.png");
  attach("second.png");

  expect(screen.getByRole("button", { name: "Move first.png earlier" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move second.png later" })).toBeDisabled();
});

test("attachments alone are enough to send, and the draft clears afterwards", async () => {
  const c = controller();
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);
  openLibrary();

  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeDisabled();

  attach("second.png");
  expect(send).toBeEnabled();
  fireEvent.click(send);

  await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
});
