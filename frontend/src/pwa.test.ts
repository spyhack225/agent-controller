import { afterEach, vi } from "vitest";

import { registerServiceWorker } from "./pwa";

function installContainer(overrides: Record<string, unknown> = {}) {
  const container = {
    register: vi.fn(async () => ({ scope: "/" })),
    getRegistrations: vi.fn(async () => []),
    getRegistration: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
    writable: true,
  });
  return container;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("service worker registration", () => {
  test("registers the root-scoped worker in production builds", async () => {
    const container = installContainer();

    await registerServiceWorker({ production: true });

    expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(container.getRegistrations).not.toHaveBeenCalled();
  });

  test("never registers during development and clears stale workers instead", async () => {
    const unregister = vi.fn(async () => true);
    const container = installContainer({
      getRegistrations: vi.fn(async () => [{ unregister }]),
    });

    await registerServiceWorker({ production: false });
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());

    expect(container.register).not.toHaveBeenCalled();
  });

  test("is inert in browsers without service worker support", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");

    await expect(registerServiceWorker({ production: true })).resolves.toBeNull();
  });

  test("swallows registration failures so a broken worker cannot block boot", async () => {
    installContainer({ register: vi.fn(async () => { throw new Error("insecure context"); }) });

    await expect(registerServiceWorker({ production: true })).resolves.toBeNull();
  });
});
