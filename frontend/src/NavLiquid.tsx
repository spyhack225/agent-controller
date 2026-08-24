/**
 * The travelling pill behind the phone navigation, split into its own module so the liquid engine
 * is a separate chunk.
 *
 * It only ever renders once the bar has real layout, which on a desktop viewport never happens —
 * the bar is `display: none` there, so its buttons measure zero and `motion.tsx` never asks for
 * this module. Loading ~60 kB of surface physics into every desktop session for an element nobody
 * on a desktop can see would be the wrong trade.
 */

import { Liquid } from "liquid-gooey";

export interface NavIndicatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function NavLiquid({ rect }: { rect: NavIndicatorRect }) {
  return (
    <Liquid
      className="nav-liquid"
      aria-hidden="true"
      // The group's own positioning has to travel as inline style: the library sets
      // `position: relative` inline on this element, which a stylesheet rule cannot outrank.
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      blur={7}
      contrast={16}
      // The same fill the static active state already used, so this changes how the selection
      // travels and nothing about how it looks once it arrives.
      fill="var(--ac-surface-inset)"
      filterPadding={18}
    >
      {/*
        The item is a wrapper, not the visible pill — the group paints the merged liquid silhouette
        *behind* whatever the item contains, so the child below is a transparent box that exists
        only to give the surface a rect to chase.

        The child is moved by its own CSS transition rather than by the item's `x`/`y`, which is the
        library's documented second mode: `observe` makes the liquid follow the rendered rect, and
        its spring lagging behind that transition is the whole effect.
      */}
      <Liquid.Item
        effect="move"
        observe
        move={{ springiness: 0.62, wobble: 0.42, stretch: 0.3, trail: 0.5 }}
      >
        <div
          className="nav-liquid__pill"
          style={{
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
          }}
        />
      </Liquid.Item>
    </Liquid>
  );
}
