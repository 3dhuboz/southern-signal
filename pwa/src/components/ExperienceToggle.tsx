/**
 * ExperienceToggle — switches the app between Simple (amateur-friendly,
 * plain-English) and Pro (full instrument with posterior, log LR,
 * sector dial, Merkle root). The same data is collected either way; only
 * the presentation changes.
 */

import { useCallback } from "react";
import { usePreferences } from "../lib/preferences";
import s from "./ExperienceToggle.module.css";

export function ExperienceToggle() {
  const [prefs, setPrefs] = usePreferences();
  const isPro = prefs.experienceMode === "pro";

  const handle = useCallback(() => {
    setPrefs({ experienceMode: isPro ? "simple" : "pro" });
  }, [isPro, setPrefs]);

  return (
    <button
      type="button"
      className={`${s.toggle} ${isPro ? s.pro : s.simple}`.trim()}
      aria-label={isPro ? "Switch to simple view" : "Switch to pro view"}
      onClick={handle}
      title={isPro ? "Pro view — switch to Simple" : "Simple view — switch to Pro"}
    >
      <span className={s.label}>{isPro ? "PRO" : "SIMPLE"}</span>
    </button>
  );
}
