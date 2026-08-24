import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import type { Controller } from "../controller";
import type { MediaItem } from "../types";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

const IMAGE: MediaItem = {
  id: "media_1",
  kind: "image",
  contentType: "image/png",
  originalName: "diagram.png",
  processing: { visionStatus: "ready" },
};

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
    actions: [],
    commands: [],
    commandEvents: [],
    macros: [],
    media: [IMAGE],
    pendingApprovals: [],
    recentCommands: [],
    display: { counts: {} },
    busyAction: null,
    setNotice: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(async () => ({ command: { id: "cmd_1" } })),
    refreshAll: vi.fn(),
    refreshMedia: vi.fn(),
    uploadMedia: vi.fn(async () => ({ id: "media_new", kind: "image", contentType: "image/png" })),
    loadSnapshot: vi.fn(async () => ({})),
    launchProject: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderOperate(c: Controller) {
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);
}

function openSourceMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
}

function composerShell(): HTMLElement {
  const shell = document.querySelector(".composer-shell");
  if (!shell) throw new Error("composer shell is not rendered");
  return shell as HTMLElement;
}

function chipNames() {
  return within(screen.getByRole("list", { name: "Attachments" }))
    .getAllByRole("listitem")
    .map((chip) => chip.querySelector(".thread-attachment-chip__name")?.textContent);
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

/** Enough of MediaRecorder to drive one push-to-talk round trip in jsdom. */
function stubRecorder() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
  });
  class FakeMediaRecorder {
    state = "inactive";
    private listeners: Record<string, Array<(event: unknown) => void>> = {};
    addEventListener(name: string, handler: (event: unknown) => void) {
      (this.listeners[name] ??= []).push(handler);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      for (const handler of this.listeners.dataavailable ?? []) {
        handler({ data: new Blob(["clip"], { type: "audio/webm" }) });
      }
      for (const handler of this.listeners.stop ?? []) handler({});
    }
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
}

test("one attachment button offers every source, and no mode switcher remains", () => {
  renderOperate(controller());

  // The old Prompt/Image/Audio switcher is gone; only Shell survives as an explicit mode.
  expect(screen.queryByRole("button", { name: "Image" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Audio" })).toBeNull();
  expect(screen.getByRole("button", { name: "Shell" })).toBeVisible();

  openSourceMenu();
  const menu = screen.getByRole("menu", { name: "Attachment source" });
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
    "Upload from this device",
    "Record voice",
    "Take a photo",
    "Choose from media library",
  ]);
});

test("uploading from the source menu stores the file and attaches it", async () => {
  const c = controller();
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Upload from this device" }));
  fireEvent.change(screen.getByLabelText(/Choose an image or audio file/iu), {
    target: { files: [new File(["png"], "shot.png", { type: "image/png" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

  await waitFor(() => expect(c.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
    kind: "image",
    contentType: "image/png",
    originalName: "shot.png",
  })));
  // The capture dialog closes itself once the upload lands on the draft.
  await waitFor(() => expect(chipNames()).toEqual(["media_new"]));
  expect(screen.queryByRole("dialog", { name: "Add attachment" })).toBeNull();
});

test("a recorded voice clip is attached without leaving the composer", async () => {
  stubRecorder();
  const c = controller({
    uploadMedia: vi.fn(async () => ({ id: "media_voice", kind: "audio", contentType: "audio/webm" })),
  });
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Record voice" }));
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));

  const stop = await screen.findByRole("button", { name: "Stop recording" });
  fireEvent.click(stop);

  await waitFor(() => expect(c.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
    kind: "audio",
    contentType: "audio/webm",
  })));
  await waitFor(() => expect(chipNames()).toEqual(["media_voice"]));
});

test("taking a photo opens the shared camera capture, not a second implementation", () => {
  renderOperate(controller());

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Take a photo" }));

  const dialog = screen.getByRole("dialog", { name: "Add attachment" });
  expect(within(dialog).getByRole("tab", { name: "Use camera" })).toHaveAttribute("aria-selected", "true");
  expect(within(dialog).getByText("Camera is off")).toBeVisible();
});

test("pasted and dropped media are uploaded and attached", async () => {
  const c = controller();
  renderOperate(c);

  fireEvent.paste(screen.getByLabelText("Command or prompt"), {
    clipboardData: { files: [new File(["png"], "pasted.png", { type: "image/png" })] },
  });

  await waitFor(() => expect(c.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
    originalName: "pasted.png",
  })));

  fireEvent.drop(composerShell(), {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["wav"], "note.wav", { type: "audio/wav" })],
    },
  });

  await waitFor(() => expect(c.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
    kind: "audio",
    originalName: "note.wav",
  })));
});

test("a dropped file that is not image or audio is refused rather than uploaded", async () => {
  const c = controller();
  renderOperate(c);

  fireEvent.drop(composerShell(), {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["zip"], "bundle.zip", { type: "application/zip" })],
    },
  });

  await waitFor(() => expect(c.setNotice).toHaveBeenCalledWith({
    tone: "danger",
    message: "Only image and audio files can be attached.",
  }));
  expect(c.uploadMedia).not.toHaveBeenCalled();
});

test("Cmd+Enter sends the free-form request as a plain agent prompt", async () => {
  const c = controller();
  renderOperate(c);

  const textarea = screen.getByLabelText("Command or prompt");
  fireEvent.change(textarea, { target: { value: "Summarise the diff" } });
  fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Summarise the diff" },
    },
  }));
});

test("attaching audio alone keeps the audio intent so the transcript keeps its provenance", async () => {
  const c = controller({
    media: [{ id: "media_clip", kind: "audio", contentType: "audio/webm", originalName: "note.webm" }],
  });
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach note.webm" }));
  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Here is the note" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      intent: {
        type: "audio_prompt",
        transcript: "Here is the note",
        mediaUploadIds: ["media_clip"],
      },
    },
  }));
});

test("the draft stops accepting attachments at the server's ceiling", () => {
  const media = Array.from({ length: 9 }, (_, index) => ({
    id: `media_${index}`,
    kind: "image",
    contentType: "image/png",
    originalName: `shot-${index}.png`,
  }));
  renderOperate(controller({ media }));

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
  for (let index = 0; index < 8; index += 1) {
    fireEvent.click(screen.getByRole("button", { name: `Attach shot-${index}.png` }));
  }

  expect(chipNames()).toHaveLength(8);
  const attach = screen.getByRole("button", { name: "Add attachment" });
  expect(attach).toBeDisabled();
  expect(attach).toHaveAttribute("title", "Attachment limit reached (8)");
});

test("shell stays a deliberate mode: it cannot carry attachments and dispatches shell_input", async () => {
  const c = controller();
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach diagram.png" }));
  expect(chipNames()).toEqual(["diagram.png"]);

  fireEvent.click(screen.getByRole("button", { name: "Shell" }));

  expect(screen.getByRole("button", { name: "Shell" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "npm test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
    },
  }));
});

/*
 * One file, one name.
 *
 * The gateway derives a media name from the device that recorded it, the thread it was headed for
 * and when it was taken, and every surface renders that same string. A picker that said
 * "controller.wav" while the library said "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32"
 * would be two names for one clip, which is worse than one bad name.
 */
test("the picker and the attachment chip both show the gateway's derived name", () => {
  const recording: MediaItem = {
    id: "media_voice",
    kind: "audio",
    contentType: "audio/wav",
    originalName: "controller.wav",
    displayName: "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32",
    origin: {
      source: "device",
      deviceLabel: "Hosyond Touch screen",
      threadId: "thread_voice",
      threadTitle: "Verify Workspace",
    },
    processing: { transcriptionStatus: "ready" },
  };
  const c = controller({ media: [recording] });
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));

  const attach = screen.getByRole("button", {
    name: "Attach Hosyond Touch screen · Verify Workspace · 24 Aug 19:32",
  });
  expect(within(attach).getByText("Hosyond Touch screen · Verify Workspace · 24 Aug 19:32")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Attach controller.wav" })).toBeNull();

  fireEvent.click(attach);
  expect(chipNames()).toEqual(["Hosyond Touch screen · Verify Workspace · 24 Aug 19:32"]);
});

test("a record served without a derived name still falls back to what was uploaded", () => {
  const c = controller({ media: [{ ...IMAGE, displayName: null }] });
  renderOperate(c);

  openSourceMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach diagram.png" }));

  expect(chipNames()).toEqual(["diagram.png"]);
});
