// Keep this policy aligned with src/securityHeaders.mjs. The Worker is a separately built package,
// so the edge owns its copy and applies it to both static assets and proxied API responses.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.com https://*.clerk.accounts.dev",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk-telemetry.com wss://*.clerk.accounts.dev wss://*.clerk.com",
  "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

export const BROWSER_SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "permissions-policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function hardenResponse(response: Response): Response {
  // A reconstructed 101 would lose the WebSocket object. The upgrade carries no document or media
  // content and is governed by the authenticated, single-use connector-ticket boundary instead.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
