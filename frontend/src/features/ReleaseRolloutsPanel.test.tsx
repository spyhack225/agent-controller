import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { ReleaseRolloutsPanel } from "./ReleaseRolloutsPanel";

function controller(overrides: Record<string, unknown> = {}) {
  const api = vi.fn(async (path: string, input?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === "/v1/firmware/releases") return { releases: [] };
    if (path === "/v1/release-rollouts" && !input?.method) return { rollouts: [] };
    if (path === "/v1/release-rollouts" && input?.method === "POST") return { rollout: {
      id: "rol_1", name: input.body?.name, targetKind: "connector", targetVersion: "0.2.0",
      rollbackVersion: null, releaseId: null, channel: "stable", state: "draft", evidenceRef: null,
      cohort: { type: "percentage", percentage: 10 }, minimumProtocolVersion: 1,
      requiredCapabilities: [], progress: { total: 0, counts: {} }, updatedAt: "2026-08-27T00:00:00Z",
    } };
    if (path.endsWith("/actions")) return { rollout: {
      id: "rol_1", name: "Connector canary", targetKind: "connector", targetVersion: "0.2.0",
      rollbackVersion: null, releaseId: null, channel: "stable", state: "running", evidenceRef: input?.body?.evidenceRef,
      cohort: { type: "percentage", percentage: 10 }, minimumProtocolVersion: 1,
      requiredCapabilities: [], progress: { total: 1, counts: { awaiting_operator_update: 1 } }, updatedAt: "2026-08-27T00:00:00Z",
    }, assignments: [{ id: "ras_1", targetId: "ctr_1", status: "awaiting_operator_update",
      reasonCode: "connector_update_requires_local_cli", observedVersion: "0.1.0", progress: null,
      attempts: 0, updatedAt: "2026-08-27T00:00:00Z" }] };
    throw new Error(`unexpected ${path}`);
  });
  return {
    api,
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    busyAction: null,
    connectors: [{ id: "ctr_1", label: "Studio Mac", connectorVersion: "0.1.0", status: "online" }],
    devices: [],
    ...overrides,
  } as unknown as Controller;
}

test("covers rollout loading, empty, explicit evidence, start, and per-target failure truth", async () => {
  const c = controller();
  render(<ReleaseRolloutsPanel controller={c} />);
  expect(screen.getByText("Loading release rollouts…")).toBeVisible();
  expect(await screen.findByText(/No staged rollout exists/u)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "New rollout" }));
  fireEvent.change(screen.getByLabelText("Rollout name"), { target: { value: "Connector canary" } });
  fireEvent.change(screen.getByLabelText("Target version"), { target: { value: "0.2.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
  expect(await screen.findByText("Connector canary")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/evidence reference/u);
  fireEvent.change(screen.getByLabelText("Evidence reference"), { target: { value: "test:pack-smoke" } });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/release-rollouts/rol_1/actions", {
    method: "POST", body: { action: "start", evidenceRef: "test:pack-smoke" },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Targets" }));
  expect(await screen.findByText("awaiting operator update")).toBeVisible();
  expect(screen.getByText("connector update requires local cli")).toBeVisible();
});

test("shows a retryable error without inventing fleet state", async () => {
  const c = controller({ api: vi.fn(async () => { throw new Error("control plane unavailable"); }) });
  render(<ReleaseRolloutsPanel controller={c} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("control plane unavailable");
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(screen.queryByText("No staged rollout exists.")).toBeNull();
});
