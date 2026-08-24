/**
 * The console's motion primitives.
 *
 * Three third-party effects sit behind this file and nowhere else, so that what the console
 * animates stays a design decision rather than a per-page impulse:
 *
 *   - `ThinkingOrb` (thinking-orbs) renders `Activity` from `activity.ts`. What each state means is
 *     decided there; this file only draws it.
 *   - `BorderBeam` (border-beam) frames a container that is genuinely live right now — a command
 *     waiting on a decision, a turn in flight. It is deliberately rare: if more than one thing on
 *     screen glows, none of them is urgent any more.
 *   - `Liquid` (liquid-gooey) drives one indicator, the phone nav pill, where a surface that
 *     actually travels between destinations tells a thumb where it came from.
 *
 * All three respect `prefers-reduced-motion` internally — the orb holds a static frame, the beam
 * stops travelling — so nothing here re-implements that.
 */

import { BorderBeam } from "border-beam";
import { ThinkingOrb, type OrbSize } from "thinking-orbs";
import {
  Suspense,
  lazy,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { Activity } from "./activity";
import type { NavIndicatorRect } from "./NavLiquid";
import { cn } from "./ui";

const NavLiquid = lazy(() => import("./NavLiquid"));

/**
 * The theme the console is actually painted in, which is not the same question as the OS setting:
 * the topbar toggle writes `data-theme` on the document, and a beam told to auto-detect would read
 * `prefers-color-scheme` and get it wrong for anyone who overrode it.
 */
export function useConsoleTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document === "undefined" || document.documentElement.dataset.theme !== "light"
      ? "dark"
      : "light");

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme === "light" ? "light" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

interface ActivityOrbProps {
  /** `null` renders nothing at all — see the rules in `activity.ts`. */
  activity: Activity | null;
  /** 64 is the panel/dialog scale, 20 sits inline in a line of text. Nothing in between exists. */
  size?: OrbSize;
  className?: string;
}

/**
 * Draws an `Activity`, or nothing.
 *
 * The label is both the accessible name and the tooltip, and it lives on a wrapper rather than on
 * the canvas so that a screen reader announces one status per orb instead of announcing the canvas
 * and its role separately.
 */
export function ActivityOrb({ activity, size = 20, className }: ActivityOrbProps) {
  if (!activity) return null;
  return (
    <span className={cn("activity-orb", className)} title={activity.label}>
      <ThinkingOrb
        state={activity.state}
        size={size}
        speed={activity.speed ?? 1}
        paused={activity.paused ?? false}
        aria-label={activity.label}
      />
    </span>
  );
}

/**
 * An orb with its label spelled out beside it — the replacement for a spinner followed by "Loading…".
 */
export function ActivityStatus({
  activity,
  size = 20,
  className,
  label,
  announce = false,
}: ActivityOrbProps & { label?: string; announce?: boolean }) {
  if (!activity) return null;
  return (
    <span
      className={cn("activity-status", className)}
      role={announce ? "status" : undefined}
      aria-live="polite"
    >
      <ActivityOrb activity={activity} size={size} />
      <span>{label ?? activity.label}</span>
    </span>
  );
}

/**
 * `attention` is something waiting on the person reading the screen; `live` is the machine working.
 * Neither is the library's default rainbow — a colour that carries no meaning would undo the point
 * of using colour at all here.
 */
export type LiveFrameTone = "attention" | "live";

interface LiveFrameProps {
  active: boolean;
  tone?: LiveFrameTone;
  /** `md` frames a card, `line` underscores a dock without boxing it in. */
  variant?: "md" | "line";
  className?: string;
  children: ReactNode;
}

export function LiveFrame({
  active,
  tone = "attention",
  variant = "md",
  className,
  children,
}: LiveFrameProps) {
  const theme = useConsoleTheme();
  return (
    <BorderBeam
      className={className}
      size={variant}
      active={active}
      theme={theme}
      colorVariant={tone === "attention" ? "sunset" : "ocean"}
      staticColors={tone === "attention"}
      strength={variant === "line" ? 0.9 : 0.55}
      duration={tone === "attention" ? 3.2 : 2.2}
    >
      {children}
    </BorderBeam>
  );
}

/**
 * Where the active item sits inside `containerRef`, in the container's own coordinates.
 *
 * Measured rather than computed from an index: the phone bar's items are `flex: 1 0 auto` with a
 * minimum width, so their widths are a function of the viewport and the longest label, not of how
 * many there are.
 */
function useActiveItemRect(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  key: string,
): NavIndicatorRect | null {
  const [rect, setRect] = useState<NavIndicatorRect | null>(null);

  // Passive, not layout: this hook is used by a child of the element it measures, and a child's
  // layout effect runs before its parent's ref has been attached. Measuring after the commit is
  // the only point at which `containerRef.current` is guaranteed to exist.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const target = container.querySelector<HTMLElement>(selector);
      // Zero width means the container is not laid out — a hidden bar, or a test environment with
      // no layout engine. There is nothing to place, and the static styling stays in charge.
      if (!target || target.offsetWidth === 0) {
        setRect(null);
        return;
      }
      // Measured against the container's *padding box*, because that is the origin an absolutely
      // positioned overlay resolves against. Using `offsetLeft` would double-count the bar's own
      // horizontal padding.
      const containerBox = container.getBoundingClientRect();
      const style = getComputedStyle(container);
      const originX = containerBox.left + parseFloat(style.borderLeftWidth || "0");
      const originY = containerBox.top + parseFloat(style.borderTopWidth || "0");
      const targetBox = target.getBoundingClientRect();
      setRect({
        x: targetBox.left - originX,
        y: targetBox.top - originY,
        width: targetBox.width,
        height: targetBox.height,
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, key, selector]);

  return rect;
}

/**
 * The travelling pill behind the phone navigation.
 *
 * It renders the same fill the static active state used, so this changes how the selection moves
 * and nothing about how it looks at rest. Until the bar has been laid out — first paint, or a test
 * environment with no layout — there is no rect and nothing is drawn, which leaves the plain
 * `[data-active]` styling in charge.
 */
export function NavLiquidIndicator({
  containerRef,
  activeKey,
}: {
  containerRef: RefObject<HTMLElement | null>;
  activeKey: string;
}) {
  const rect = useActiveItemRect(containerRef, "button[data-active]", activeKey);
  if (!rect) return null;
  return (
    <Suspense fallback={null}>
      <NavLiquid rect={rect} />
    </Suspense>
  );
}
