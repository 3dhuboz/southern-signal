/**
 * useCivilTwilightSuggestion — fires once per session when the device is
 * past civil twilight (sun ≤ -6°) and the operator hasn't already switched
 * to a scotopic/phosphor-red theme.
 *
 * Returns:
 *   suggested  — true when the banner should be visible
 *   accept()   — applies "scotopic / mid" and hides the banner
 *   dismiss()  — sets a sessionStorage flag and hides the banner permanently
 *                for this tab's lifetime
 *
 * Constraints honoured:
 *   • Async geolocation + civil-twilight check runs once via useEffect; it
 *     never re-runs on subsequent renders.
 *   • Respects prefs.scotopicAutoEngage — if the user has turned that off,
 *     the hook is a no-op.
 *   • Geolocation permission is checked first (permissions API) — never
 *     prompts if the user hasn't granted it yet.
 *   • If the tab's session already dismissed the banner (sessionStorage),
 *     the effect short-circuits immediately.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isPastCivilTwilight } from "../lib/sensors/civilTwilight";
import { getCurrentPoint } from "../lib/sensors/geolocation";
import { applyTheme, getPreferences, setPreferences } from "../lib/preferences";

const SESSION_KEY = "ss-civil-twilight-dismissed-v1";

export interface CivilTwilightSuggestion {
  suggested: boolean;
  accept: () => void;
  dismiss: () => void;
}

export function useCivilTwilightSuggestion(): CivilTwilightSuggestion {
  const [suggested, setSuggested] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    // Only ever run once per component lifetime.
    if (ran.current) return;
    ran.current = true;

    // Already dismissed in this browser session.
    if (sessionStorage.getItem(SESSION_KEY)) return;

    // Read prefs synchronously — this is localStorage, no async needed.
    const prefs = getPreferences();

    // User has opted out of auto-engage suggestions.
    if (!prefs.scotopicAutoEngage) return;

    // Already in a night-use theme — no need to suggest.
    if (prefs.theme === "scotopic" || prefs.theme === "phosphor") {
      // phosphor is the default dark mode; we only suggest if theme is the
      // literal daylight mode OR phosphor. Wait — per the spec: "NOT scotopic
      // or phosphor". Phosphor is already the dark default, so skip for it too.
      return;
    }

    // Run the async check without blocking the render.
    void (async () => {
      // Verify geolocation permission without triggering a prompt.
      try {
        const status = await (
          navigator.permissions?.query?.({ name: "geolocation" as PermissionName }) ??
          Promise.resolve({ state: "prompt" } as PermissionStatus)
        );
        if (status.state !== "granted") return;
      } catch {
        return;
      }

      const point = await getCurrentPoint(8000);
      if (!point) return;

      const past = isPastCivilTwilight(new Date(), point.latitude, point.longitude);
      if (past) {
        setSuggested(true);
      }
    })();
  }, []); // intentionally empty — run once on mount

  const accept = useCallback(() => {
    setPreferences({ theme: "scotopic", scotopicLevel: "mid" });
    applyTheme("scotopic", "mid");
    setSuggested(false);
    sessionStorage.setItem(SESSION_KEY, "1");
  }, []);

  const dismiss = useCallback(() => {
    setSuggested(false);
    sessionStorage.setItem(SESSION_KEY, "1");
  }, []);

  return { suggested, accept, dismiss };
}
