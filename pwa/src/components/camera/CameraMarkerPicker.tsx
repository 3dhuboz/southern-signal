/**
 * CameraMarkerPicker — quick-tag chips + category chips after a double-tap.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * Fires when the operator double-taps the viewport to drop a moment marker;
 * auto-commits as untagged after the parent's MARKER_PICKER_MS timeout if
 * no chip is tapped. Each chip stops pointer propagation so tapping a chip
 * doesn't also re-trigger the swipe / long-press handlers underneath.
 *
 * A11y (Wave 3): promoted from role="group" to role="dialog" + aria-modal=
 * "false" so screen readers announce the picker as an interactive surface
 * with a label, not just a styled group. The auto-commit timeout is
 * announced via aria-live="polite" on the root — the operator who can't
 * see the chips gets a hint that they've got ~2.2s to pick. The picker is
 * focused on mount via tabIndex={-1} + the useEffect ref dance.
 *
 * Tokens: --chip-bg / --chip-rim / --chip-text / --hud-glass-bg-strong /
 * --hud-rim-strong / --marker-sound / --marker-movement / --marker-felt
 * (Wave 1A).
 */
import { useEffect, useRef } from "react";
import { PICKER_CATEGORIES, QUICK_TAGS, type MarkerCategory } from "../../views/cameraScreen/constants";
import s from "./CameraMarkerPicker.module.css";

export interface CameraMarkerPickerProps {
  /** Quick-tag chip handler. Fires `commitMarker(cat, label)` upstream. */
  onPickQuickTag: (label: string, cat: Exclude<MarkerCategory, null>) => void;
  /** Category chip handler. Fires `commitMarker(cat)` upstream — no note. */
  onPickCategory: (cat: Exclude<MarkerCategory, null>) => void;
}

export function CameraMarkerPicker({ onPickQuickTag, onPickCategory }: CameraMarkerPickerProps) {
  // a11y: focus the first chip on mount so a keyboard user can tag without
  // a mouse. The parent controls mount/unmount via the markerPicker state,
  // so this effect runs exactly once per picker session.
  const firstChipRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    firstChipRef.current?.focus();
  }, []);

  return (
    <div
      className={s.markerPickerWrap}
      role="dialog"
      aria-modal="false"
      aria-label="Tag this marker"
      aria-live="polite"
      tabIndex={-1}
    >
      <div className={s.markerQuickTags} aria-label="Quick tags — commit a marker with a pre-filled note">
        {QUICK_TAGS.map((q, idx) => (
          <button
            key={q.label}
            ref={idx === 0 ? firstChipRef : undefined}
            type="button"
            className={s.markerQuickTagBtn}
            data-category={q.category}
            onClick={(e) => { e.stopPropagation(); onPickQuickTag(q.label, q.category); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className={s.markerPicker}>
        {PICKER_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={s.markerPickerBtn}
            onClick={(e) => { e.stopPropagation(); onPickCategory(c.id); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
