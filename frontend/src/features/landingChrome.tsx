import { TerminalSquare, type LucideIcon } from "lucide-react";

import type { MarketingRoute } from "../marketingRoute";

/**
 * Placeholder frames for product photography that does not exist yet. Deliberately captioned
 * rather than blank, so an empty slot reads as "shot pending" and not as a broken image.
 */
export function Shot({
  icon: Icon,
  caption,
  ratio,
}: {
  icon: LucideIcon;
  caption: string;
  ratio: string;
}) {
  return (
    <div className="landing__shot" style={{ aspectRatio: ratio }}>
      <Icon className="size-5" aria-hidden="true" />
      <p>{caption}</p>
    </div>
  );
}

export function LandingBrand({ badge = "NIGHTLY" }: { badge?: string | null }) {
  return (
    <div className="landing__brand">
      <div className="brand-mark" aria-hidden="true">
        <TerminalSquare className="size-4" />
      </div>
      <div className="brand-copy">
        <p className="brand-copy__name">Agent Controller</p>
        {badge ? <p className="brand-copy__meta">{badge}</p> : null}
      </div>
    </div>
  );
}

const MARKETING_PAGES: Array<{ route: MarketingRoute; href: string; label: string }> = [
  { route: "home", href: "#/", label: "Overview" },
  { route: "developers", href: "#/developers", label: "For developers" },
  { route: "early-access", href: "#/early-access", label: "Hardware" },
];

/**
 * Cross-links between the three signed-out pages. Without this each page is only reachable by
 * typing its hash, which makes two thirds of the marketing site invisible.
 */
export function MarketingSwitch({ current }: { current: MarketingRoute }) {
  return (
    <nav className="landing__switch" aria-label="Other pages">
      {MARKETING_PAGES.filter((page) => page.route !== current).map((page) => (
        <a key={page.route} href={page.href}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}
