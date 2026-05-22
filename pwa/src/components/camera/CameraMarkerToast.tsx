/**
 * CameraMarkerToast — "MARKED" confirmation toast.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * Top-centre, 1.5s fade-out. role="status" (implicit aria-live="polite")
 * announces to a screen reader without interrupting whatever it was
 * narrating — the actual marker is already in the audit chain via
 * recordEvent, so the toast is purely confirmatory.
 *
 * Visibility gating ("visible only when marker dropped in the last 1.5s")
 * lives in the parent — this component renders whenever it's mounted.
 *
 * Tokens consumed: --chip-bg / --accent-strong (Wave 1A).
 */
import s from "./CameraMarkerToast.module.css";

export function CameraMarkerToast() {
  return (
    <div className={s.markerToast} role="status" aria-live="polite">
      ✓ MARKED
    </div>
  );
}
