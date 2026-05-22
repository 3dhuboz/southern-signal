/**
 * CameraFocusPulse — 700ms visual ring at the tap-to-focus point.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * The animation is pure CSS so the gesture feels instant — no React re-
 * render gate. The parent owns the state (focusPulse object with x/y/key);
 * this component just paints the ring at the position it's handed.
 *
 * `key` on the parent's render forces remount on each tap so the animation
 * restarts even when the previous pulse is still visible (operator double-
 * taps in the same spot). Tokens: --focus-ring (Wave 1A).
 */
import s from "./CameraFocusPulse.module.css";

export interface CameraFocusPulseProps {
  /** x coordinate, relative to the camera wrap (clientX − wrap.left). */
  x: number;
  /** y coordinate, relative to the camera wrap (clientY − wrap.top). */
  y: number;
}

export function CameraFocusPulse({ x, y }: CameraFocusPulseProps) {
  return (
    <div
      className={s.focusPulse}
      style={{ left: x, top: y }}
      aria-hidden="true"
    />
  );
}
