/**
 * usePresentationMode — global Simple/Pro mode preference.
 *
 * Simple (default): amateur-friendly. Plain-English verdicts, hides
 * Bayesian credible intervals, audit-chain hashes, EWVar / z-score
 * readouts, calibration coefficients, log LR math.
 *
 * Pro (opt-in): investigators, technical reviewers, Steve himself.
 * Surfaces the full forensic chain — posterior with sectors, audit log
 * inspector, EVP transients tab, Welford EWVar readouts.
 *
 * Backed by `preferences.experienceMode` (localStorage) so the choice
 * survives reloads. New users land in Simple — verified by the test
 * suite at hooks/usePresentationMode.test.ts.
 *
 * The 8 hard-coded disclaimers are NOT gated by this hook — they're the
 * ethical floor and visible in both modes. The disclaimer-copy.smoke.test
 * pin tests guard against accidental regression.
 */

import { useCallback } from "react";
import { usePreferences, type ExperienceMode } from "../lib/preferences";

export interface PresentationMode {
  /** Current mode — "simple" (default) or "pro". */
  mode: ExperienceMode;
  /** Set the mode; persisted to localStorage. */
  setMode: (next: ExperienceMode) => void;
  /** Convenience: `true` when mode === "pro". */
  isPro: boolean;
}

export function usePresentationMode(): PresentationMode {
  const [prefs, setPrefs] = usePreferences();
  const mode = prefs.experienceMode;
  const setMode = useCallback(
    (next: ExperienceMode) => {
      setPrefs({ experienceMode: next });
    },
    [setPrefs],
  );
  return { mode, setMode, isPro: mode === "pro" };
}
