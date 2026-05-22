/**
 * CameraMarkerPill — session-scoped marker tally + breakdown popover.
 *
 * Extracted from CameraHud.tsx as part of the 2026-05-22 camera overhaul.
 * The pill displays the live count; tap to open the popover with a
 * per-category breakdown + an "Open Review" jump link. The popover uses
 * useFocusTrap so an external-keyboard user can't tab out of it without
 * dismissing first.
 *
 * Layout (UX spec): bottom-left of the shutter band, NOT under the shutter,
 * well clear of the BroadcastTimestamp slate. The pill sits inside the
 * CameraHud grid at row 4 / col 1, anchored bottom-left so the popover
 * opens upward into row 3 without crowding the lower third.
 *
 * Wave 3 landmine fix: the popover used to use `bottom: calc(100% + 6px)`
 * unconditionally, which clipped on tall content. We now set
 * `max-height: 40vh; overflow-y: auto;` so a runaway category list scrolls
 * inside the popover instead of overflowing the viewport.
 *
 * Tokens: --chip-bg / --chip-rim / --chip-text / --hud-glass-bg-strong /
 * --marker-sound / --marker-movement / --marker-felt / --marker-other /
 * --signal / --signal-wash (Wave 1A).
 */
import { type RefObject } from "react";
import s from "./CameraMarkerPill.module.css";

// Marker breakdown rows for the popover. Mirrors the priority used in
// CameraScreen so reviewers see the same order on both surfaces.
const MARKER_BREAKDOWN: ReadonlyArray<{ id: "sound" | "movement" | "felt" | "untagged"; label: string }> = [
  { id: "sound",    label: "sound" },
  { id: "movement", label: "movement" },
  { id: "felt",     label: "felt" },
  { id: "untagged", label: "untagged" },
];

export interface CameraMarkerPillProps {
  /** Total markers landed this session. Parent gates rendering on > 0. */
  count: number;
  /** Popover open-state, owned by the parent. */
  open: boolean;
  /** Per-category breakdown for the popover list. */
  byCategory: { sound: number; movement: number; felt: number; untagged: number };
  /** Toggle handler — flips popover open/closed. */
  onToggle: () => void;
  /** Navigation handler — fires on "Open Review →". */
  onNavigateReview: () => void;
  /** Outer wrap ref so the parent's outside-click effect can ignore the wrap. */
  wrapRef: RefObject<HTMLDivElement | null>;
  /** Focus-trap ref from useFocusTrap. Threaded through so the parent's hook
   *  lifecycle controls focus capture + restore when the popover toggles. */
  trapRef: RefObject<HTMLDivElement | null>;
}

export function CameraMarkerPill({
  count,
  open,
  byCategory,
  onToggle,
  onNavigateReview,
  wrapRef,
  trapRef,
}: CameraMarkerPillProps) {
  return (
    <div className={s.markerPillWrap} ref={wrapRef}>
      <button
        type="button"
        className={s.markerCountPill}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Tap to see this session's marker breakdown"
        aria-expanded={open}
        aria-label={`${count} marker${count === 1 ? "" : "s"} this session — tap for breakdown`}
      >
        <span className={s.markerCountIcon} aria-hidden="true">●</span>
        <span className={s.markerCountValue}>{count}</span>
        <span className={s.markerCountLabel}>marker{count === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div
          className={s.markerCountPopover}
          role="dialog"
          aria-modal="true"
          aria-label="Marker breakdown by category"
          ref={trapRef}
          tabIndex={-1}
        >
          <ul className={s.markerCountList}>
            {MARKER_BREAKDOWN.filter((row) => byCategory[row.id] > 0).map((row) => (
              <li key={row.id}>
                <span className={s.markerCountDot} data-category={row.id} aria-hidden="true">●</span>
                {byCategory[row.id]} {row.label}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={s.markerCountReviewLink}
            onClick={(e) => { e.stopPropagation(); onNavigateReview(); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Open Review →
          </button>
        </div>
      )}
    </div>
  );
}
