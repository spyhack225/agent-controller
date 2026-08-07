/**
 * Service worker lifecycle for the installable console.
 *
 * The worker is only registered from production builds. Under `npm run dev:app` a
 * previously installed worker would intercept navigations and shadow Vite's module
 * graph, so development actively unregisters anything it finds instead.
 */

export interface ServiceWorkerRegistrationOptions {
  /** Defaults to `import.meta.env.PROD`. Injected in tests. */
  production?: boolean;
  /** Defaults to `/sw.js`. */
  scriptUrl?: string;
}

function container(): ServiceWorkerContainer | null {
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker ?? null;
}

async function unregisterAll(serviceWorker: ServiceWorkerContainer): Promise<void> {
  try {
    const registrations = await serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // A browser that refuses to enumerate registrations has nothing for us to clean up.
  }
}

export function registerServiceWorker(
  options: ServiceWorkerRegistrationOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const serviceWorker = container();
  if (!serviceWorker) return Promise.resolve(null);

  const production = options.production ?? import.meta.env.PROD;
  if (!production) {
    void unregisterAll(serviceWorker);
    return Promise.resolve(null);
  }

  return serviceWorker
    .register(options.scriptUrl ?? "/sw.js", { scope: "/" })
    .catch(() => null);
}

/** Resolves the active registration, or null when the app is not running under a worker. */
export async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  const serviceWorker = container();
  if (!serviceWorker?.getRegistration) return null;
  try {
    return await serviceWorker.getRegistration() ?? null;
  } catch {
    return null;
  }
}
