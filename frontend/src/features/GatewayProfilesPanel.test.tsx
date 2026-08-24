import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { GatewayProfile } from "../types";
import { ConfirmProvider } from "../ui";
import { GatewayProfilesPanel, gatewayProfileUrlError } from "./GatewayProfilesPanel";

function controller(profiles: GatewayProfile[] = []) {
  return {
    gatewayProfiles: profiles,
    remoteAccess: {
      gateway: { lanUrls: ["http://192.168.1.25:3996"] },
      tailscale: { connected: true, serve: { active: false } },
    },
    busyAction: null,
    api: vi.fn(async () => ({})),
    refreshAll: vi.fn(async () => undefined),
    loadRemoteAccess: vi.fn(async () => undefined),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

function renderPanel(c: Controller) {
  return render(<ConfirmProvider><GatewayProfilesPanel controller={c} /></ConfirmProvider>);
}

test("rejects credentials, unsafe schemes, paths, and public plain HTTP", () => {
  expect(gatewayProfileUrlError("custom", "javascript:alert(1)")).toMatch(/HTTP or HTTPS/u);
  expect(gatewayProfileUrlError("custom", "https://user:secret@example.com")).toMatch(/Credentials/u);
  expect(gatewayProfileUrlError("custom", "https://example.com/admin?token=secret")).toMatch(/origin only/u);
  expect(gatewayProfileUrlError("lan", "http://example.com")).toMatch(/Plain HTTP/u);
  expect(gatewayProfileUrlError("tailnet", "https://gateway.example.com")).toMatch(/\.ts\.net/u);
  expect(gatewayProfileUrlError("lan", "http://192.168.1.25:3996")).toBeNull();
  expect(gatewayProfileUrlError("tailnet", "https://gateway.example.ts.net")).toBeNull();
});

test("creates and edits an origin-only private Tailnet profile", async () => {
  const existing: GatewayProfile = { id: "gateway_studio", label: "Studio LAN", mode: "lan", baseUrl: "http://192.168.1.25:3996" };
  const c = controller([existing]);
  renderPanel(c);

  fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
  fireEvent.change(screen.getByLabelText("Profile label"), { target: { value: "Private gateway" } });
  fireEvent.change(screen.getByLabelText("Access mode"), { target: { value: "tailnet" } });
  fireEvent.change(screen.getByLabelText("Gateway origin"), { target: { value: "https://gateway.example.ts.net" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/gateway-profiles", {
    method: "POST",
    body: { label: "Private gateway", mode: "tailnet", baseUrl: "https://gateway.example.ts.net" },
  }));

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio LAN" }));
  fireEvent.change(screen.getByLabelText("Profile label"), { target: { value: "Workshop LAN" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/gateway-profiles/gateway_studio", expect.objectContaining({
    method: "PUT",
    body: expect.objectContaining({ label: "Workshop LAN" }),
  })));

  fireEvent.click(screen.getByRole("button", { name: "Delete Studio LAN" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete profile" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/gateway-profiles/gateway_studio", { method: "DELETE" }));
});

test("invokes private Serve from the app without exposing setup credentials", async () => {
  const c = controller();
  renderPanel(c);
  fireEvent.click(screen.getByRole("button", { name: "Enable private Serve" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/settings/remote-access/serve", {
    method: "POST",
    body: { enabled: true },
  }));
  expect(c.loadRemoteAccess).toHaveBeenCalledWith(true);
  expect(document.body.textContent).not.toMatch(/token|secret=/iu);
});
