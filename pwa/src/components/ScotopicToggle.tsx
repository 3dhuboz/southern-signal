/**
 * ScotopicToggle — one-tap control surfaced in the AppHeader.
 *
 *   • Theme is "phosphor"  → tap once: switches to scotopic at level "mid".
 *   • Theme is "scotopic"  → tap cycles brightness dim → mid → max → off.
 *
 * The button label shows the current state. Long-press is reserved for
 * future "auto-engage" toggling.
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
    if (prefs.theme !== "scotopic") {
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
      setPrefs({ theme: "phosphor", scotopicLevel: "mid" });
      applyTheme("phosphor");
    }
  }, [prefs.theme, prefs.scotopicLevel, setPrefs]);

  const isOn = prefs.theme === "scotopic";

  return (
    <button
      type="button"
      className={`${s.toggle} ${isOn ? s.on : s.off}`.trim()}
      aria-label={isOn ? `Scotopic ${prefs.scotopicLevel} — tap to cycle` : "Switch to scotopic mode"}
      onClick={handleTap}
    >
      <span className={s.dot} aria-hidden="true" />
      <span className={s.label}>
        {isOn ? `RED · ${LEVEL_LABELS[prefs.scotopicLevel]}` : "RED OFF"}
      </span>
    </button>
  );
}
