import { createClerkClient } from "@clerk/backend";

export function createClerkAuthenticator(config) {
  if (!config.clerkSecretKey) return null;
  const clerkClient = createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
  });

  return async function authenticateClerkRequest(req) {
    const request = toWebRequest(req, config);
    const authenticatedRequest = await clerkClient.authenticateRequest(request, {
      authorizedParties: config.clerkAuthorizedParties,
    });
    const auth = authenticatedRequest.toAuth();
    if (!auth?.userId) return null;
    return {
      id: auth.userId,
      clerkUserId: auth.userId,
      sessionId: auth.sessionId ?? null,
      orgId: auth.orgId ?? null,
    };
  };
}

function toWebRequest(req, config) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const proto = headers.get("x-forwarded-proto") ?? (config.publicBaseUrl?.startsWith("https://") ? "https" : "http");
  const host = headers.get("host") ?? "localhost";
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}
