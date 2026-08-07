import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { T3Harness, T3SessionFailure } from "../types";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

// Mirrors the real catalogue registered from a T3 host: codex and claudeAgent ready, cursor
// disabled, grok not installed.
const HARNESSES: T3Harness[] = [
  {
    instanceId: "codex",
    label: "Codex",
    version: "0.146.0",
    status: "ready",
    available: true,
    unavailableReason: null,
    models: [
      { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, options: [] },
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, options: [] },
    ],
  },
  {
    instanceId: "claudeAgent",
    label: "Claude",
    status: "ready",
    available: true,
    unavailableReason: null,
    models: [{ slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false, options: [] }],
  },
  {
    instanceId: "grok",
    label: "Grok",
    status: "error",
    available: false,
    unavailableReason: "Not installed on the T3 host.",
    models: [],
  },
];

const FAILURE: T3SessionFailure = {
  threadId: "thread_1",
  title: "Verify Workspace and Current Branch",
  status: "stopped",
  instanceId: "codex",
  model: "gpt-5..6",
  message: "The 'gpt-5..6' model is not supported when using Codex with a ChatGPT account.",
  code: "invalid_request_error",
  updatedAt: "2026-07-24T19:27:48.334Z",
};

function controller(overrides: Record<string, unknown> = {}) {
  return {
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedProjectId: "project_1",
    selectedProject: { id: "project_1", title: "Tacs", defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" } },
    environments: [{ id: "env_1", label: "Mac T3" }],
    threads: [{ id: "thread_1", label: "Thread" }],
    projects: [{ id: "project_1", title: "Tacs" }],
    harnesses: HARNESSES,
    harnessCatalogueSource: "registered",
    sessionFailures: [],
    suggestedModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    // Every collection OperatePage iterates; a missing one throws before assertions run.
    commands: [],
    commandEvents: [],
    macros: [],
    media: [],
    pendingApprovals: [],
    recentCommands: [],
    display: { counts: {} },
    busyAction: null,
    setNotice: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(),
    refreshAll: vi.fn(),
    loadSnapshot: vi.fn(),
    launchProject: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

test("the model field is a list of real models, not free text", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);

  const modelSelect = await screen.findByLabelText("Model");
  expect(modelSelect.tagName).toBe("SELECT");

  const slugs = Array.from(modelSelect.querySelectorAll("option")).map((option) => option.value);
  expect(slugs).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
  // The slug that silently failed on the real environment is not offerable.
  expect(slugs).not.toContain("gpt-5..6");
});

test("the harness field lists usable harnesses and disables unavailable ones with a reason", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);

  const harnessSelect = await screen.findByLabelText("Agent harness");
  const options = Array.from(harnessSelect.querySelectorAll("option"));

  const usable = options.filter((option) => !option.disabled).map((option) => option.value);
  expect(usable).toEqual(["codex", "claudeAgent"]);

  const grok = options.find((option) => option.value === "grok");
  expect(grok?.disabled).toBe(true);
  expect(grok?.textContent).toContain("Not installed on the T3 host.");
});

test("a project default that T3 still offers is preselected", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);
  await waitFor(() => {
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.4");
  });
});

test("a project default T3 no longer offers falls back to the resolved selection", async () => {
  const c = controller({
    selectedProject: {
      id: "project_1",
      title: "Tacs",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5..6" },
    },
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  await waitFor(() => {
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
  });
});

test("stopped sessions surface T3's provider error instead of staying silent", async () => {
  render(
    <ConfirmProvider><OperatePage controller={controller({ sessionFailures: [FAILURE] })} /></ConfirmProvider>,
  );
  expect(await screen.findByText(/not supported when using Codex/u)).toBeTruthy();
  expect(screen.getByText(/Verify Workspace and Current Branch/u)).toBeTruthy();
});

test("an unregistered catalogue tells the user how to register it", async () => {
  render(
    <ConfirmProvider>
      <OperatePage controller={controller({ harnessCatalogueSource: "snapshot-only" })} />
    </ConfirmProvider>,
  );
  expect(await screen.findByText(/setup:t3/u)).toBeTruthy();
});

test("launch is blocked when no model can be selected", async () => {
  const c = controller({ harnesses: [], suggestedModelSelection: null, selectedProject: { id: "project_1", title: "Tacs" } });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  const launch = await screen.findByRole("button", { name: /Launch/u });
  await waitFor(() => expect((launch as HTMLButtonElement).disabled).toBe(true));
});
