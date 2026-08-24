import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { Device } from "../types";
import { ConfirmProvider } from "../ui";
import { DevicesPage } from "./DevicesPage";

function controller(devices: Device[] = []): Controller {
  const api = vi.fn(async (path: string) => {
    if (path === "/v1/devices") {
      return {
        device: { id: "dev_new", label: "Desk controller", profile: "agent-controller" },
        secret: "secret-once",
      };
    }
    return {};
  });
  return {
    devices,
    deviceProfiles: [],
    environments: [{ id: "env_1", label: "Studio Mac" }],
    threads: [],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedDeviceId: devices[0]?.id ?? "",
    setSelectedDeviceId: vi.fn(),
    deviceSecret: null,
    setDeviceSecret: vi.fn(),
    setNotice: vi.fn(),
    busyAction: null,
    api,
    refreshAll: vi.fn(async () => undefined),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

function renderPage(c: Controller) {
  return render(<ConfirmProvider><DevicesPage controller={c} /></ConfirmProvider>);
}

test("offers all three empty-fleet jobs and guides registration through distinct stages", async () => {
  const c = controller();
  renderPage(c);

  expect(screen.getByRole("heading", { name: "How is this controller arriving?" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: /Pre-provision/u }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: /Register/u }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: /Claim/u }).length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByRole("button", { name: /^Register$/u })[0]);
  expect(screen.getByRole("dialog", { name: "Register a controller" })).toBeVisible();
  expect(screen.getByText("Bring developer hardware online")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(screen.getByLabelText("Device label")).toHaveValue("Desk controller");
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(screen.getByLabelText("Default environment")).toHaveValue("env_1");
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: "Register controller" }));

  await screen.findByText("Identity created");
  expect(c.api).toHaveBeenCalledWith("/v1/devices", {
    method: "POST",
    body: { label: "Desk controller", profile: "agent-controller" },
  });
  expect(c.setDeviceSecret).toHaveBeenCalledWith(expect.objectContaining({ secret: "secret-once" }));
});

test("renders health tiles and saves label and runtime configuration from the device modal", async () => {
  const device: Device = {
    id: "dev_42",
    label: "Studio dial",
    profile: "agent-controller",
    lastSeenAt: "2026-08-08T12:00:00.000Z",
    presence: { state: "online" },
    status: {
      lastHeartbeatAt: "2026-08-08T12:00:00.000Z",
      uptimeMs: 3_600_000,
      firmwareVersion: "1.4.2",
      hardwareModel: "T190",
      ipAddress: "192.168.1.42",
      batteryPercent: 82,
    },
    config: {
      environmentId: "env_1",
      threadId: "thread_1",
      defaultPrompt: "Review changes",
      shellCommand: "npm test",
      menu: ["status", "prompt"],
    },
  };
  const c = controller([device]);
  renderPage(c);

  for (const label of ["Last seen", "Uptime", "Firmware", "Hardware", "IP address", "Battery"]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(screen.getByText("192.168.1.42")).toBeVisible();
  expect(screen.getByRole("button", { name: "Rotate" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Transfer reset" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio dial" }));
  const dialog = screen.getByRole("dialog", { name: "Studio dial" });
  expect(dialog).toBeVisible();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  fireEvent.change(screen.getByLabelText("Device label"), { target: { value: "Editing bay" } });
  fireEvent.click(screen.getByRole("tab", { name: "configuration" }));
  fireEvent.change(screen.getByLabelText("Default thread ID"), { target: { value: "thread_2" } });
  fireEvent.click(screen.getByRole("radio", { name: /Tailscale/u }));
  expect(screen.getByText(/ESP32 controllers do not join Tailscale directly/u)).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: /Online HTTPS/u }));
  fireEvent.change(screen.getByLabelText("Controller gateway URL"), { target: { value: "https://gateway.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_42/config", {
    method: "PUT",
    body: expect.objectContaining({
      label: "Editing bay",
      environmentId: "env_1",
      threadId: "thread_2",
      gatewayAccessMode: "online",
      gatewayUrl: "https://gateway.example.com",
    }),
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});

test("orders reusable controls and saves the device layout", async () => {
  const device: Device = {
    id: "dev_controls",
    label: "Workshop controller",
    profile: "agent-controller",
    config: { threadId: "thread_1" },
    status: { firmwareVersion: "2.0.0", hardwareModel: "E213", limits: { menuItems: 4, labelCharacters: 14 } },
  };
  const c = controller([device]);
  c.threads.push({ id: "thread_1", label: "Firmware navigation", status: "idle" });
  c.actions = [
    { id: "action_review", label: "Review branch", type: "prompt", intent: { type: "agent_prompt", text: "Review" } },
  ];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/controls") && options?.method === "PUT") {
      return { controls: { revision: 4, acknowledgedRevision: 3, items: [{ kind: "status", label: "Status" }, { kind: "remote_action", actionId: "action_review", label: "Review branch" }] } };
    }
    if (path.endsWith("/controls")) return { controls: { revision: 3, acknowledgedRevision: 3, items: [{ kind: "status", label: "Status" }] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Workshop controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "controls" }));
  await screen.findByText("Physical controls");
  expect(screen.getByText("3 root items")).toBeVisible();
  expect(screen.getByText("1 thread actions")).toBeVisible();
  expect(screen.getByText("AC//MENU 1/3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Threads, 1" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Gateway, NET" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Firmware, CHECK" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview Threads, 1" }));
  expect(screen.getByText("AC//THREADS 1/1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview Firmware navigation, ACTIVE" }));
  expect(screen.getByText("T//ACTIONS 1/2")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Status, VIEW" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("Action to add to opened threads"), { target: { value: "action_review" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("2 thread actions")).toBeVisible();
  expect(screen.getByText("Unsaved")).toBeVisible();
  expect(screen.getByText("T//ACTIONS 1/3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Review branch, CONFIRM" })).toBeVisible();
  expect(screen.getAllByText("Review branch").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Save layout" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_controls/controls", {
    method: "PUT",
    body: { items: expect.arrayContaining([expect.objectContaining({ actionId: "action_review" })]) },
  }));
  expect(await screen.findByText("Waiting for device")).toBeVisible();
});

test("updates firmware channel, update mode, and desired release", async () => {
  const device: Device = {
    id: "dev_firmware",
    label: "Release controller",
    profile: "agent-controller",
    status: { firmwareVersion: "1.0.0", hardwareModel: "E213", protocolVersion: 2 },
  };
  const c = controller([device]);
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path.endsWith("/firmware-policy") && options?.method === "PUT") return { policy: { ...(options.body as object), currentVersion: "1.0.0", latestVersion: "1.2.0", availableVersions: ["1.2.0"] } };
    if (path.endsWith("/firmware-policy")) return {
      policy: { channel: "stable", updateMode: "manual" },
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      availableVersions: ["1.2.0"],
      releaseNotes: "Signed stable release.",
    };
    if (path.endsWith("/controls")) return { controls: { revision: 1, items: [] } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Release controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "firmware" }));
  await screen.findByText("Installed release");
  expect(screen.getByText("Signed stable release.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Queue update" })).toBeEnabled();
  expect(screen.getByText("Queues 1.2.0; the controller installs it on its next firmware check.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Flash a local build/u }));
  expect(screen.getByRole("dialog", { name: "Flash a local build" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Compile the OTA-enabled image" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Add the binary to the stable catalog" })).toBeVisible();
  expect(screen.getByText(/One-time USB bootstrap may be required/u)).toBeVisible();
  expect(screen.getAllByText(/AGENT_CONTROLLER_FIRMWARE_VERSION=1.0.1/u)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Back to firmware" }));
  await screen.findByText("Installed release");
  fireEvent.change(screen.getByLabelText("Release channel"), { target: { value: "beta" } });
  fireEvent.change(screen.getByLabelText("Update mode"), { target: { value: "automatic" } });
  fireEvent.change(screen.getByLabelText("Desired version"), { target: { value: "1.2.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_firmware/firmware-policy", {
    method: "PUT",
    body: { channel: "beta", updateMode: "automatic", desiredVersion: "1.2.0" },
  }));
});

test("treats a never-acknowledged control revision as waiting for the device", async () => {
  const device: Device = { id: "dev_pending", label: "Offline controller", profile: "agent-controller" };
  const c = controller([device]);
  vi.mocked(c.api).mockImplementation(async (path: string) => {
    if (path.endsWith("/controls")) return {
      controls: [{ id: "system_status", kind: "status", label: "Status", enabled: true }],
      layout: { revision: 2, appliedRevision: null, items: [{ id: "system_status", kind: "status", label: "Status" }] },
    };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Offline controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "controls" }));
  expect(await screen.findByText("Waiting for device")).toBeVisible();
  expect(screen.queryByText("Applied r2")).not.toBeInTheDocument();
});

test("stages a revisioned gateway profile switch and keeps the current route pending acknowledgement", async () => {
  const device: Device = { id: "dev_gateway", label: "Field controller", profile: "agent-controller" };
  const c = controller([device]);
  c.gatewayProfiles = [
    { id: "gateway_lan", label: "Studio LAN", mode: "lan", baseUrl: "http://192.168.1.25:3996" },
    { id: "gateway_tailnet", label: "Private Tailnet", mode: "tailnet", baseUrl: "https://gateway.example.ts.net" },
  ];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/gateway") && options?.method === "PUT") return {
      deviceId: "dev_gateway",
      revision: 3,
      state: "pending",
      activeProfile: c.gatewayProfiles[0],
      pendingProfile: c.gatewayProfiles[1],
      requestedAt: "2026-08-08T10:00:00.000Z",
    };
    if (path.endsWith("/gateway")) return { deviceId: "dev_gateway", revision: 2, state: "stable", activeProfile: c.gatewayProfiles[0] };
    if (path.endsWith("/controls")) return { controls: [], layout: { revision: 1, appliedRevision: 1, items: [] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Field controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "gateway" }));
  await screen.findByText("Controller gateway");
  expect(screen.getByText("Studio LAN")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Requested profile"), { target: { value: "gateway_tailnet" } });
  fireEvent.click(screen.getByRole("button", { name: "Stage switch" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_gateway/gateway", {
    method: "PUT",
    body: { profileId: "gateway_tailnet" },
  }));
  expect(screen.getByText(/Revision 3 is waiting/u)).toBeVisible();
  expect(screen.getByText("Keep current")).toBeVisible();
});

test("surfaces a failed gateway switch and allows rollback to the confirmed profile", async () => {
  const device: Device = { id: "dev_failed_gateway", label: "Remote controller", profile: "agent-controller" };
  const c = controller([device]);
  const active = { id: "gateway_lan", label: "Office LAN", mode: "lan" as const, baseUrl: "http://10.0.0.8:3996" };
  const failed = { id: "gateway_custom", label: "External gateway", mode: "custom" as const, baseUrl: "https://gateway.example.com" };
  c.gatewayProfiles = [active, failed];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/gateway/rollback")) return { deviceId: device.id, revision: 5, state: "stable", activeProfile: active };
    if (path.endsWith("/gateway")) return { deviceId: device.id, revision: 5, state: "failed", activeProfile: active, pendingProfile: failed, lastError: "TLS certificate verification failed." };
    if (path.endsWith("/controls")) return { controls: [], layout: { revision: 1, appliedRevision: 1, items: [] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Remote controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "gateway" }));
  expect(await screen.findByText("TLS certificate verification failed.")).toBeVisible();
  expect(screen.getByText("Controller kept the previous route")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel switch" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_failed_gateway/gateway/rollback", { method: "POST", body: {} }));
});
