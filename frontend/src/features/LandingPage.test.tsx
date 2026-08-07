import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AuthConfig, ClerkBridge } from "../types";
import { LandingPage } from "./LandingPage";

function clerkBridge(overrides: Partial<ClerkBridge> = {}): ClerkBridge {
  return {
    loaded: true,
    signedIn: false,
    userLabel: null,
    getToken: vi.fn(async () => null),
    openSignIn: vi.fn(),
    openSignUp: vi.fn(),
    openUserProfile: vi.fn(),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

const clerkEnabled: AuthConfig = { clerk: { enabled: true, publishableKey: "pk_test_x" } };

test("offers sign-up and sign-in as separate doors", () => {
  const clerk = clerkBridge();
  render(<LandingPage authConfig={clerkEnabled} clerk={clerk} />);

  fireEvent.click(screen.getByRole("button", { name: /Create your account/u }));
  expect(clerk.openSignUp).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /I already have one/u }));
  expect(clerk.openSignIn).toHaveBeenCalled();
});

test("says what the product does before asking for an account", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/never runs the agent itself/u)).toBeInTheDocument();
  expect(screen.getByText(/Pair your T3 Code host/u)).toBeInTheDocument();
  expect(screen.getByText(/Add a controller, or don't/u)).toBeInTheDocument();
});

// A self-hoster who has not finished wiring Clerk needs the reason. A sign-up button that
// silently does nothing is the worst version of this screen.
test("explains a gateway with no sign-in configured instead of showing a dead button", () => {
  render(<LandingPage authConfig={{ clerk: { enabled: false, publishableKey: null } }} clerk={null} />);

  expect(screen.getByText(/Sign-in is not configured/u)).toBeInTheDocument();
  expect(screen.getByText("CLERK_SECRET_KEY")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Create your account/u })).not.toBeInTheDocument();
});

test("holds the CTAs disabled while Clerk is still resolving the session", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge({ loaded: false })} />);

  expect(screen.getByRole("button", { name: /Checking session/u })).toBeDisabled();
  expect(screen.getByRole("button", { name: /I already have one/u })).toBeDisabled();
});
