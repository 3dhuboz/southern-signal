/**
 * CivilTwilightBanner — dismissable suggestion strip shown when the device
 * is past civil twilight and the operator hasn't switched to scotopic mode.
 *
 * Slides in from the top. Auto-dismisses after 12 s if no interaction.
 * Rendered globally just below the AppHeader (wired in App.tsx).
 */

import { useEffect, useRef } from "react";
import { useCivilTwilightSuggestion } from "../hooks/useCivilTwilightSuggestion";
import s from "./CivilTwilightBanner.module.css";

const AUTO_DISMISS_MS = 12_000;

export function CivilTwilightBanner() {
  const { suggested, accept, dismiss } = useCivilTwilightSuggestion();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start (or restart) the auto-dismiss countdown whenever the banner appears.
  useEffect(() => {
    if (!suggested) return;

    timerRef.current = setTimeout(() => {
      dismiss();
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [suggested, dismiss]);

  if (!suggested) return null;

  return (
    <div
      className={s.banner}
      role="status"
      aria-live="polite"
      aria-label="Civil twilight suggestion"
    >
      <span className={s.icon} aria-hidden="true">🌑</span>
      <span className={s.body}>
        It's past civil twilight — switch to Red Mode for field use?
      </span>
      <div className={s.actions}>
        <button
          type="button"
          className={s.accept}
          onClick={accept}
          aria-label="Switch to Red Mode"
        >
          Switch to Red Mode
        </button>
        <button
          type="button"
          className={s.dismiss}
          onClick={dismiss}
          aria-label="Dismiss suggestion"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
