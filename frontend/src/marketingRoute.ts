export type MarketingRoute = "home" | "developers" | "early-access";

const BY_PATH: Record<string, MarketingRoute> = {
  "/developers": "developers",
  "/early-access": "early-access",
};

/**
 * Which signed-out page the hash asks for.
 *
 * Only the `#/name` form is a route. The landing pages use bare `#anchor` hashes for their own
 * in-page nav (`#hardware`, `#pricing`, `#faq`), and one of those collides by name with a page —
 * so the leading slash is what separates "scroll to the hardware section" from "open the hardware
 * page". Anything unrecognised, including the signed-in `#/operate` left over from a previous
 * session, falls back to the main landing page.
 */
export function readMarketingRoute(hash: string = window.location.hash): MarketingRoute {
  if (!hash.startsWith("#/")) return "home";
  const path = hash.slice(1).replace(/[?#].*$/u, "").replace(/\/$/u, "");
  return BY_PATH[path] ?? "home";
}
