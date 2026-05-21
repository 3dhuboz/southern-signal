/**
 * EntertainmentOnlyLabel — always-on render-layer banner.
 *
 * Hard constraint #3 from the customer-readiness brief: an
 * Entertainment-only label MUST appear at the render layer of every
 * Case Card / session screen, and it cannot be removed at runtime.
 *
 * Implementation:
 *  - Pulls the canonical sentence from src/lib/legal/disclaimers.ts at
 *    module-load time (the constant is frozen there).
 *  - Renders as a small unobtrusive fixed-position chip that does not
 *    eat the live video frame. The chip uses backdrop-blur so it works
 *    over the camera surface.
 *  - Plays cleanly with the `role="contentinfo"` semantics so screen
 *    readers announce it as a footer-style legal disclosure.
 *
 * Variants:
 *  - `variant="fixed"` (default) — fixed-position chip at the bottom
 *    centre of the viewport. Use on the Camera surface where the live
 *    video must remain visible behind the chip.
 *  - `variant="inline"` — flows inline with surrounding content. Use on
 *    document-flow surfaces like Case Cards, Setup, Review where there
 *    is no live video to overlay.
 *
 * Why a component (not a string in JSX): single chokepoint for tests
 * and i18n. Future "remove the disclaimer in dev mode" pressure
 * doesn't have a knob to twist — the component renders unconditionally.
 */

import { getEntertainmentOnlyLabel } from "../lib/legal/disclaimers";
import s from "./EntertainmentOnlyLabel.module.css";

interface Props {
  /** Layout mode. Defaults to "fixed" for camera surfaces. */
  variant?: "fixed" | "inline";
  /** Optional className passthrough so callers can nudge positioning. */
  className?: string;
}

export function EntertainmentOnlyLabel({ variant = "fixed", className }: Props) {
  const label = getEntertainmentOnlyLabel();
  const wrapClass = [
    variant === "fixed" ? s.fixed : s.inline,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={wrapClass}
      role="contentinfo"
      aria-label="Legal disclosure"
      // data-testid is used by the smoke test to assert the chip is
      // present on every screen that must surface it.
      data-testid="entertainment-only-label"
    >
      {label}
    </div>
  );
}
