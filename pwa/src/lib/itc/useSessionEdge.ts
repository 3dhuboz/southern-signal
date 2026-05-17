/**
 * useSessionEdge — shared session-running edge handling for ITC dock tools.
 *
 * Both useSpiritBox and useOvilus need the same three behaviours:
 *
 *   • Rising edge of `sessionRunning` + `autoStart` → setActive(true).
 *     Scene-driven kick-on (e.g. Spirit Box Session scene); manual toggle-off
 *     mid-session stays off because the next rising edge requires a fresh
 *     session start.
 *   • Falling edge of `sessionRunning` → setActive(false). Hard-stop so the
 *     tool doesn't cycle silently after the operator presses End.
 *   • Tab hidden (visibilitychange) → setActive(false). Don't cycle while the
 *     phone is in a pocket or another app is foregrounded.
 */

import { useEffect, useRef } from "react";

export function useSessionEdge(
  sessionRunning: boolean,
  autoStart: boolean,
  setActive: (v: boolean) => void,
): void {
  const prevRunningRef = useRef(sessionRunning);
  useEffect(() => {
    const prev = prevRunningRef.current;
    prevRunningRef.current = sessionRunning;
    if (!sessionRunning) {
      setActive(false);
      return;
    }
    if (!prev && autoStart) setActive(true);
  }, [sessionRunning, autoStart, setActive]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") setActive(false);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [setActive]);
}
