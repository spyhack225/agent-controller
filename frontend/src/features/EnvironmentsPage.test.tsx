import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { ConnectSession, Environment } from "../types";
import { ConfirmProvider } from "../ui";
import { EnvironmentsPage } from "./EnvironmentsPage";

const connected: Environment = {
  id: "env_new",
  label: "Mac T3 Code",
  baseUrl: "https://mac.tailnet.ts.net",
  status: "paired",
};

function controller(environments: Environment[] = []): Controller {
  return {
    environments,
    selectedEnvironmentId: environments[0]?.id ?? "",
    selectedEnvironment: environments[0] ?? null,
    setSelectedEnvironmentId: vi.fn(),
    markEnvironmentCredentialChanged: vi.fn(),
    projects: [],
    threads: [],
    busyAction: null,
    setNotice: vi.fn(),
    refreshAll: vi.fn(async () => undefined),
    loadSnapshot: vi.fn(async () => ({ environment: environments[0] ?? connected })),
    // Console-first pairing: the dialog mints a session, then polls it. The default stub keeps the
    // session pending so the waiting state is what renders unless a test says otherwise.
    createConnectSession: vi.fn(async (input: { accessMode?: string }) => ({
      session: pendingSession,
      code: "ABCDE-FGHIJ",
      gatewayUrl: "https://gateway.example",
      command: `npm run setup:t3 -- --gateway-url 'https://gateway.example' --connect-code 'ABCDE-FGHIJ' --tunnel '${input.accessMode ?? "local"}'`,
    })),
    fetchConnectSession: vi.fn(async () => ({ session: pendingSession, environment: null })),
    api: vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === "/v1/t3/environments" && options?.method === "POST") return { environment: connected };
      return { environment: environments[0] ?? connected };
    }),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

const pendingSession: ConnectSession = {
  id: "cxn_1",
  label: "Mac T3 Code",
  accessMode: "local",
  environmentId: null,
  status: "pending",
  baseUrl: null,
  error: null,
  expiresAt: "2026-08-24T18:15:00.000Z",
  completedAt: null,
};

function renderPage(c: Controller) {
  return render(<ConfirmProvider><EnvironmentsPage controller={c} /></ConfirmProvider>);
}

test("hands an empty account a copyable connect command and waits for the host to redeem it", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const c = controller();
  renderPage(c);

  expect(screen.getByRole("heading", { name: "Where does your agent work run?" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));

  const dialog = screen.getByRole("dialog", { name: "Connect T3 Code" });
  expect(dialog).toBeVisible();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByText("Connect the machine where T3 Code runs")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.change(screen.getByLabelText("Environment label"), { target: { value: "Studio Mac" } });
  fireEvent.click(screen.getByRole("radio", { name: /Tailscale/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  // The mode the user picked scopes the command the gateway mints.
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledWith({
    label: "Studio Mac",
    accessMode: "tailscale",
    environmentId: null,
  }));

  const command = "npm run setup:t3 -- --gateway-url 'https://gateway.example' --connect-code 'ABCDE-FGHIJ' --tunnel 'tailscale'";
  expect(await screen.findByText(command)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy connect command" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  expect(screen.getByRole("button", { name: "Copied connect command" })).toBeVisible();

  // Nothing is pasted back: the dialog polls until the host lands the pairing.
  expect(screen.getByText("Waiting for the T3 host…")).toBeVisible();
  await waitFor(() => expect(c.fetchConnectSession).toHaveBeenCalledWith("cxn_1"));
  expect(within(dialog).queryByRole("button", { name: /Connect environment/u })).toBeNull();
});

test("closes the connect flow when the polled session reports the pairing landed", async () => {
  const c = controller();
  Object.assign(c, {
    fetchConnectSession: vi.fn(async () => ({
      session: { ...pendingSession, status: "completed", environmentId: "env_new" },
      environment: connected,
    })),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  await screen.findByText("Host paired successfully");
  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_new");
  expect(c.refreshAll).toHaveBeenCalled();
  // The access path shown is the one inferred from the endpoint the host reported, not the guess
  // made before the host was reachable.
  expect(screen.getByText("Tailscale")).toBeVisible();
});

test("surfaces a pairing that failed on the host instead of spinning forever", async () => {
  const c = controller();
  Object.assign(c, {
    fetchConnectSession: vi.fn(async () => ({
      session: { ...pendingSession, status: "failed", error: "T3 token exchange failed with HTTP 400." },
      environment: null,
    })),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  expect(await screen.findByText(/T3 token exchange failed with HTTP 400/u)).toBeVisible();
  const retry = screen.getByRole("button", { name: "Get a new command" });
  fireEvent.click(retry);
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledTimes(2));
});

test("keeps manual credential paste as the fallback and still requires HTTPS for online hosts", async () => {
  const c = controller();
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("radio", { name: /Online HTTPS/u }));
  expect(screen.getByText("Public internet endpoint")).toBeVisible();
  expect(screen.getByText("Never enter a plain HTTP URL for an internet-accessible host.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  const dialog = screen.getByRole("dialog", { name: "Connect T3 Code" });
  // The fallback is collapsed by default — a host that can reach the gateway never needs it.
  expect(within(dialog).queryByLabelText("T3 base URL")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Paste a credential manually instead/u }));

  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "http://t3.example.com" } });
  fireEvent.change(screen.getByLabelText("Pairing token"), { target: { value: "pair_once" } });
  expect(within(dialog).getByRole("button", { name: "Connect environment" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "https://t3.example.com" } });
  const connect = within(dialog).getByRole("button", { name: "Connect environment" });
  expect(connect).toBeEnabled();
  fireEvent.click(connect);

  await screen.findByText("Host paired successfully");
  expect(c.api).toHaveBeenCalledWith("/v1/t3/environments", {
    method: "POST",
    body: {
      label: "Mac T3 Code",
      baseUrl: "https://t3.example.com",
      pairingToken: "pair_once",
    },
  });
  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_new");
});

test("re-pairing an existing host reuses the same flow and updates it in place", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "token_expired",
  };
  const c = controller([environment]);
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Studio Mac" })).getByRole("button", { name: "credential" }));
  fireEvent.click(screen.getByRole("button", { name: "Re-pair from the host" }));

  const dialog = await screen.findByRole("dialog", { name: "Re-pair Studio Mac" });
  // Label and access mode are pre-filled from the environment, and the session names it so the
  // redemption updates that row rather than adding a second one for the same machine.
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledWith({
    label: "Studio Mac",
    accessMode: "tailscale",
    environmentId: "env_42",
  }));
  expect(within(dialog).getByText("Run this on the T3 host")).toBeVisible();

  // The manual fallback of a re-pair is a PUT, never a POST.
  fireEvent.click(within(dialog).getByRole("button", { name: /Paste a credential manually instead/u }));
  fireEvent.change(within(dialog).getByLabelText("Pairing token"), { target: { value: "pair_again" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save credential" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", {
    method: "PUT",
    body: {
      label: "Studio Mac",
      baseUrl: "https://studio.tailnet.ts.net",
      pairingToken: "pair_again",
    },
  }));
});

test("renders environment health tiles and edits connection details in a focused modal", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
    accessTokenExpiresAt: "2026-12-01T12:00:00.000Z",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    health: {
      lastCheckedAt: "2026-08-08T12:00:00.000Z",
      lastReachableAt: "2026-08-08T12:00:00.000Z",
      lastError: null,
      snapshot: { line1: "3 projects", line2: "8 threads" },
    },
  };
  const c = controller([environment]);
  renderPage(c);

  for (const label of ["Last checked", "Last reachable", "Credential", "Snapshot age", "Projects", "Sessions"]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(screen.getByText("3 projects")).toBeVisible();
  expect(screen.getByRole("button", { name: "Load snapshot" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Check" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  expect(screen.getByRole("dialog", { name: "Studio Mac" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /Tailscale/u })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Environment label"), { target: { value: "Editing Mac" } });
  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "https://editing.tailnet.ts.net" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", {
    method: "PUT",
    body: {
      label: "Editing Mac",
      baseUrl: "https://editing.tailnet.ts.net",
    },
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});

test("lists controller gateways, marks the active endpoint, and names its devices", () => {
  const environment: Environment = {
    id: "env_gateway",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
  };
  const c = controller([environment]);
  Object.assign(c, {
    devices: [
      {
        id: "dev_desk",
        label: "Desk Controller",
        profile: "agent-controller",
        presence: { online: true, state: "online" },
        gatewaySelection: {
          revision: 3,
          state: "stable",
          activeProfileId: "gateway_tailnet",
        },
        config: {
          environmentId: environment.id,
          gatewayAccessMode: "tailscale",
          gatewayUrl: "https://gateway.tailnet.ts.net",
        },
      },
    ],
    gatewayProfiles: [
      {
        id: "gateway_lan",
        label: "Studio LAN",
        mode: "lan",
        baseUrl: "http://192.168.1.25:3996",
      },
      {
        id: "gateway_tailnet",
        label: "Private Tailnet",
        mode: "tailnet",
        baseUrl: "https://gateway.tailnet.ts.net",
      },
    ],
    remoteAccess: {
      checkedAt: "2026-08-08T18:00:00.000Z",
      gateway: {
        host: "0.0.0.0",
        port: 3996,
        loopbackUrl: "http://127.0.0.1:3996",
        lanUrls: ["http://192.168.1.25:3996"],
        publicBaseUrl: null,
      },
      tailscale: {
        installed: true,
        connected: true,
        backendState: "Running",
        dnsName: "gateway.tailnet.ts.net",
        ips: ["100.64.0.4"],
        httpsUrl: "https://gateway.tailnet.ts.net",
        serve: { active: true, statusAvailable: true },
        funnel: { active: false, statusAvailable: true },
        mode: "serve",
        publicBaseUrlConfigured: true,
        ready: true,
        error: null,
        nextStep: "ready",
      },
    },
  });
  renderPage(c);

  expect(screen.getByText("Controller gateways")).toBeVisible();
  expect(screen.getByText("1 active")).toBeVisible();
  expect(screen.getByText("Desk Controller")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  const dialog = screen.getByRole("dialog", { name: "Studio Mac" });
  fireEvent.click(within(dialog).getByRole("button", { name: "gateways" }));

  expect(within(dialog).getByText("https://gateway.tailnet.ts.net")).toBeVisible();
  expect(within(dialog).getAllByText("Who is using it")).toHaveLength(2);
  expect(within(dialog).getByText("Desk Controller")).toBeVisible();
  expect(within(dialog).getByText("online")).toBeVisible();
});

test("removes an environment only after showing what still points at it", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
  };
  const c = controller([environment]);
  Object.assign(c, {
    api: vi.fn(async (path: string) => {
      if (path.endsWith("/dependencies")) {
        return {
          environmentId: "env_42",
          dependencies: {
            devices: [{ id: "dev_desk", label: "Desk Controller" }],
            actions: [{ id: "action_ship", label: "Ship it" }],
            macros: [],
            onboarding: true,
          },
          counts: { devices: 1, actions: 1, macros: 0, onboarding: 1 },
        };
      }
      return { environment };
    }),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  const dialog = screen.getByRole("dialog", { name: "Studio Mac" });
  fireEvent.click(within(dialog).getByRole("button", { name: "health" }));
  expect(within(dialog).queryByRole("button", { name: /Unpair/u })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove environment" }));

  const confirmation = await screen.findByRole("alertdialog");
  expect(within(confirmation).getByText("Remove Studio Mac?")).toBeVisible();
  expect(within(confirmation).getByText(/1 device default, 1 saved action and your onboarding selection/u)).toBeVisible();
  expect(within(confirmation).getByText(/disabled until you re-save them/u)).toBeVisible();

  fireEvent.click(within(confirmation).getByRole("button", { name: "Remove environment" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", { method: "DELETE" }));
  expect(c.run).toHaveBeenCalledWith("remove-environment", "Environment removed.", expect.any(Function));
});
