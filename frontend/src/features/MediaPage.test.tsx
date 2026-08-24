import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { ConfirmProvider } from "../ui";
import { MediaPage } from "./MediaPage";

function controller(overrides: Record<string, unknown> = {}) {
  return {
    media: [],
    mediaJobs: [],
    busyAction: null,
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ media: {} })),
    refreshAll: vi.fn(),
    refreshMedia: vi.fn(),
    uploadMedia: vi.fn(async () => ({ id: "media_1", kind: "image", contentType: "image/png" })),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderMedia(overrides: Record<string, unknown> = {}) {
  const c = controller(overrides);
  render(
    <ConfirmProvider>
      <MediaPage controller={c} />
    </ConfirmProvider>,
  );
  return c;
}

const AUDIO = {
  id: "media_1",
  kind: "audio",
  contentType: "audio/webm",
  sizeBytes: 16,
  originalName: "clip.webm",
  transcript: null,
  createdAt: "2026-06-14T23:00:00.000Z",
  processing: { transcriptionStatus: "processing", transcriptSource: "openai" },
};

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

test("a queued transcription reports the job stage, not just the media status", () => {
  renderMedia({
    media: [AUDIO],
    mediaJobs: [{
      id: "mjob_1",
      mediaId: "media_1",
      kind: "transcription",
      stage: "transcribing",
      provider: "openai",
      attempts: 2,
      maxAttempts: 3,
      createdAt: "2026-06-14T23:00:01.000Z",
    }],
  });

  // A retry is visible: the media record only ever says "processing".
  expect(screen.getByText(/Transcribing · via openai · attempt 2\/3/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /Approve transcript/ })).toBeNull();
});

test("a job waiting on review offers approval and posts the reviewed version", async () => {
  const api = vi.fn(async () => ({ job: { id: "mjob_1", stage: "ready" } }));
  const c = renderMedia({
    media: [{ ...AUDIO, transcript: "Deploy the staging branch." }],
    mediaJobs: [{
      id: "mjob_1",
      mediaId: "media_1",
      kind: "transcription",
      stage: "review_required",
      provider: "openai",
      attempts: 1,
      maxAttempts: 3,
      createdAt: "2026-06-14T23:00:01.000Z",
    }],
    api,
  });

  expect(screen.getByText(/Needs review/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Approve transcript/ }));

  await vi.waitFor(() => expect(api).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith("/v1/media/jobs/mjob_1/transcript", {
    method: "POST",
    body: { transcript: "Deploy the staging branch." },
  });
  expect(c.refreshMedia).toHaveBeenCalled();
});

test("the newest job describes a re-transcribed clip", () => {
  renderMedia({
    media: [AUDIO],
    mediaJobs: [
      {
        id: "mjob_old",
        mediaId: "media_1",
        kind: "transcription",
        stage: "failed",
        lastError: "Transcription provider returned HTTP 429.",
        createdAt: "2026-06-14T23:00:01.000Z",
      },
      {
        id: "mjob_new",
        mediaId: "media_1",
        kind: "transcription",
        stage: "queued",
        createdAt: "2026-06-14T23:05:00.000Z",
      },
    ],
  });

  expect(screen.getByText("Queued")).toBeVisible();
  expect(screen.queryByText(/HTTP 429/)).toBeNull();
});

test("a cleanup that changed the wording is shown as a diff, never applied silently", () => {
  renderMedia({
    media: [AUDIO],
    mediaJobs: [{
      id: "mjob_1",
      mediaId: "media_1",
      kind: "transcription",
      stage: "review_required",
      provider: "parakeet",
      rawTranscript: "deploy the staging branch",
      normalizedTranscript: "Deploy the stating branch.",
      createdAt: "2026-06-14T23:00:01.000Z",
      transcriptChange: {
        changed: true,
        contentPreserved: false,
        rawLength: 25,
        normalizedLength: 26,
        firstDivergenceIndex: 12,
      },
    }],
  });

  expect(screen.getByText("Cleanup changed the wording")).toBeVisible();
  // Both versions are on screen, because the point is that the speaker can tell them apart.
  expect(screen.getByText("deploy the staging branch")).toBeVisible();
  expect(screen.getByText("Deploy the stating branch.")).toBeVisible();
  expect(screen.getByRole("button", { name: /Approve transcript/ })).toBeVisible();
});

test("an untouched transcript carries no diff notice", () => {
  renderMedia({
    media: [AUDIO],
    mediaJobs: [{
      id: "mjob_1",
      mediaId: "media_1",
      kind: "transcription",
      stage: "dispatched",
      provider: "parakeet",
      rawTranscript: "Deploy the staging branch.",
      normalizedTranscript: "Deploy the staging branch.",
      createdAt: "2026-06-14T23:00:01.000Z",
      transcriptChange: {
        changed: false,
        contentPreserved: true,
        rawLength: 26,
        normalizedLength: 26,
        firstDivergenceIndex: null,
      },
    }],
  });

  expect(screen.queryByText("Cleanup changed the wording")).toBeNull();
});

/*
 * The reported bug: two recordings from two moments, both listed as `controller.wav`, separable
 * only by byte count and a raw id. The gateway now derives a name from the device, the destination
 * thread and the minute — and the row leads with that, while still recording what was uploaded.
 */
test("a controller recording is listed under its derived name, not controller.wav", () => {
  renderMedia({
    media: [
      {
        ...AUDIO,
        id: "media_1",
        originalName: "controller.wav",
        displayName: "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32",
      },
      {
        ...AUDIO,
        id: "media_2",
        originalName: "controller.wav",
        displayName: "Hosyond Touch screen · Verify Workspace · 24 Aug 19:48",
      },
    ],
  });

  expect(screen.getByText("Hosyond Touch screen · Verify Workspace · 24 Aug 19:32")).toBeVisible();
  expect(screen.getByText("Hosyond Touch screen · Verify Workspace · 24 Aug 19:48")).toBeVisible();

  // originalName is not destroyed: it stays on the row beside the id, as the record of the upload.
  expect(screen.getByText("controller.wav · media_1")).toBeVisible();
  expect(screen.getByText("controller.wav · media_2")).toBeVisible();
});

test("the delete confirmation names the capture the way the row does", async () => {
  renderMedia({
    media: [{ ...AUDIO, displayName: "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32" }],
  });

  fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

  expect(
    await screen.findByText("Delete Hosyond Touch screen · Verify Workspace · 24 Aug 19:32?"),
  ).toBeVisible();
});

test("a record with no derived name falls back to what was uploaded", () => {
  renderMedia({ media: [{ ...AUDIO, displayName: null }] });

  expect(screen.getByText("clip.webm")).toBeVisible();
  expect(screen.getByText("clip.webm · media_1")).toBeVisible();
});
