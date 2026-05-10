/**
 * ScotopicToggle — one-tap theme control surfaced in the AppHeader.
 *
 * Cycle (chosen to follow real field-use rhythm — bright daytime planning →
 * normal night-time operating → deep red-shift for low-light fieldwork):
 *
 *   • daylight  → tap once: switch to phosphor (default dark).
 *   • phosphor  → tap once: switch to scotopic at level "mid".
 *   • scotopic  → tap cycles brightness dim → mid → max → daylight.
 *
 * Long-press is reserved for future "auto-engage" toggling.
 *
 * Filename and exported name unchanged for AppHeader.tsx import compatibility.
 */

import { useCallback } from "react";
import { applyTheme, usePreferences, type ScotopicLevel } from "../lib/preferences";
import s from "./ScotopicToggle.module.css";

const LEVEL_LABELS: Record<ScotopicLevel, string> = {
  dim: "DIM",
  mid: "MID",
  max: "MAX",
};

export function ScotopicToggle() {
  const [prefs, setPrefs] = usePreferences();

  const handleTap = useCallback(() => {
    if (prefs.theme === "daylight") {
      // Sun → dusk: drop to default dark.
      setPrefs({ theme: "phosphor", scotopicLevel: "mid" });
      applyTheme("phosphor");
      return;
    }
    if (prefs.theme !== "scotopic") {
      // phosphor → scotopic at mid.
      setPrefs({ theme: "scotopic", scotopicLevel: "mid" });
      applyTheme("scotopic", "mid");
      return;
    }
    if (prefs.scotopicLevel === "dim") {
      setPrefs({ scotopicLevel: "mid" });
      applyTheme("scotopic", "mid");
    } else if (prefs.scotopicLevel === "mid") {
      setPrefs({ scotopicLevel: "max" });
      applyTheme("scotopic", "max");
    } else {
      // scotopic max → wrap to daylight (the brightest end of the cycle).
      setPrefs({ theme: "daylight", scotopicLevel: "mid" });
      applyTheme("daylight");
    }
  }, [prefs.theme, prefs.scotopicLevel, setPrefs]);

  const isScotopic = prefs.theme === "scotopic";
  const isDaylight = prefs.theme === "daylight";

  let stateClass = s.off;
  if (isScotopic) stateClass = s.on;
  else if (isDaylight) stateClass = s.day;

  let label: string;
  let aria: string;
  if (isScotopic) {
    label = `RED · ${LEVEL_LABELS[prefs.scotopicLevel]}`;
    aria = `Scotopic ${prefs.scotopicLevel} — tap to cycle (next: ${prefs.scotopicLevel === "max" ? "daylight" : prefs.scotopicLevel === "dim" ? "scotopic mid" : "scotopic max"})`;
  } else if (isDaylight) {
    label = "SUN";
    aria = "Daylight mode — tap to switch to phosphor (default dark)";
  } else {
    label = "RED OFF";
    aria = "Phosphor mode — tap to switch to scotopic (red-shifted night)";
  }

  return (
    <button
      type="button"
      className={`${s.toggle} ${stateClass}`.trim()}
      aria-label={aria}
      title={aria}
      onClick={handleTap}
    >
      <span className={s.dot} aria-hidden="true" />
      <span className={s.label}>{label}</span>
    </button>
  );
}
