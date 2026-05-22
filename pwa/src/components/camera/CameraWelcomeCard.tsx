/**
 * CameraWelcomeCard — first-run helper card.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * Surfaces the four gestures that aren't discoverable from chrome alone
 * (double-tap markers, swipe scenes, the shutter, the watchdog). The parent
 * owns the dismissed-flag persistence to localStorage; this component is
 * pure presentation.
 *
 * A11y: traps focus while open so an external-keyboard user can't tab into
 * the camera chrome behind. The hook returns the ref the parent threads
 * into the wrap div. Escape dismisses via the parent's `onDismiss` callback.
 *
 * Tokens: --hud-glass-bg-strong / --chip-rim / --text-primary /
 * --accent-strong / --text-on-accent (Wave 1A).
 */
import { type RefObject } from "react";
import s from "./CameraWelcomeCard.module.css";

export interface CameraWelcomeCardProps {
  /** Fires when the dismiss ✕ or Got-it button is tapped, or Escape pressed. */
  onDismiss: () => void;
  /** Focus-trap ref from `useFocusTrap`. Threaded through so the parent's
   *  hook lifecycle controls focus capture + restore. */
  trapRef: RefObject<HTMLDivElement | null>;
}

export function CameraWelcomeCard({ onDismiss, trapRef }: CameraWelcomeCardProps) {
  return (
    <div
      className={s.welcomeCard}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ss-welcome-title"
      ref={trapRef}
      tabIndex={-1}
    >
      <header className={s.welcomeHead}>
        <span id="ss-welcome-title" className={s.welcomeEyebrow}>Welcome</span>
        <button
          type="button"
          className={s.welcomeDismiss}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Dismiss welcome card"
        >
          ✕
        </button>
      </header>
      <ul className={s.welcomeList}>
        <li><strong>Double-tap</strong> the viewport to drop a moment marker.</li>
        <li><strong>Swipe left/right</strong> to cycle scenes (or tap the pill ↗).</li>
        <li><strong>BIG SHUTTER</strong> below begins / ends a session.</li>
        <li>The watchdog warns if battery or storage drops mid-session.</li>
      </ul>
      <button
        type="button"
        className={s.welcomeGotIt}
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        Got it
      </button>
    </div>
  );
}
