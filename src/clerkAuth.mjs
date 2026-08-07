import { createClerkClient } from "@clerk/backend";

const USER_CACHE_TTL_MS = 5 * 60 * 1000;

export function createClerkAuthenticator(config) {
  if (!config.clerkSecretKey) return null;
  const clerkClient = createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
  });
  const userCache = new Map();

  return async function authenticateClerkRequest(req) {
    const request = toWebRequest(req, config);
    const authenticatedRequest = await clerkClient.authenticateRequest(request, {
      authorizedParties: config.clerkAuthorizedParties,
    });
    const auth = authenticatedRequest.toAuth();
    if (!auth?.userId) return null;
    const profile = await getClerkUserProfile(clerkClient, userCache, auth.userId);
    return {
      id: auth.userId,
      clerkUserId: auth.userId,
      sessionId: auth.sessionId ?? null,
      orgId: auth.orgId ?? null,
      email: profile.email,
      name: profile.name,
    };
  };
}

async function getClerkUserProfile(clerkClient, cache, userId) {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const user = await clerkClient.users.getUser(userId);
  const primaryEmail = user.emailAddresses?.find(
    (candidate) => candidate.id === user.primaryEmailAddressId,
  )?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
  const profile = { email: primaryEmail, name: fullName };
  cache.set(userId, {
    profile,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
  return profile;
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
