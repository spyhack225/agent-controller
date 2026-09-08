// One browser policy for the Node reference adapter. Cloudflare's edge keeps the same values in
// cloudflare/src/securityHeaders.ts because the Worker package is built and deployed separately.
// Clerk's hosted UI needs its script/connect/frame origins, while camera, microphone, local blobs,
// service workers, same-origin SSE and signed media remain first-party capabilities.
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

export const BROWSER_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "permissions-policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export function browserSecurityHeaders() {
  return { ...BROWSER_SECURITY_HEADERS };
}
