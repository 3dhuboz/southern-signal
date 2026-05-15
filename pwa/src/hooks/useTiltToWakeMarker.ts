/**
 * useTiltToWakeMarker — hands-free evidence marker via shake gesture.
 *
 * When the investigator shakes the phone, the hook:
 *   1. Reads the most recent compass heading → converts to 16-point cardinal.
 *   2. Reads screen orientation type.
 *   3. Fires navigator.vibrate(80) if available (Android only; iOS: silent skip).
 *   4. Plays an 80ms 800Hz chime so the investigator gets audio confirmation.
 *   5. Writes a 'marker' evidence event + audit chain entry.
 *   6. Updates lastDrop state so the UI can show a confirmation flash.
 *
 * iOS requires DeviceMotionEvent.requestPermission() to be called from a user
 * gesture. Expose requestPermission() on the returned object and bind it to a
 * button tap. On Android/desktop no gesture is needed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent } from "../lib/db/repo";
import { playChime } from "../lib/audio/chime";
import { ShakeDetector, type MotionPermissionResult } from "../lib/sensors/shakeDetector";

// ---- 16-point cardinal lookup ------------------------------------------

const CARDINALS_16 = [
  "N", "NNE", "NE", "ENE",
  "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW",
  "W", "WNW", "NW", "NNW",
] as const;

type Cardinal16 = typeof CARDINALS_16[number];

function headingToCardinal(headingDeg: number): Cardinal16 {
  const idx = Math.round(headingDeg / 22.5) % 16;
  return CARDINALS_16[idx];
}

// ---- Public types -------------------------------------------------------

export interface TiltToWakeOptions {
  investigationId: string | null;
  /** Whether the shake-to-mark feature is enabled. Defaults to true. */
  enabled?: boolean;
  /** Called after a marker is written with its generated id. */
  onMarkerDropped?: (markerId: string) => void;
}

export interface LastDrop {
  id: string;
  timestamp: string;
  cardinal: Cardinal16;
}

export type TiltToWakePermissionState =
  | "unknown"      // not yet requested
  | "granted"      // permission granted (or not required on this platform)
  | "denied"       // user denied, or an error occurred
  | "unavailable"; // DeviceMotionEvent not supported at all

export interface TiltToWakeReturn {
  lastDrop: LastDrop | null;
  permissionState: TiltToWakePermissionState;
  /** Request iOS motion permission. Must be called from a user-gesture handler. */
  requestPermission: () => Promise<void>;
}

// ---- Hook ---------------------------------------------------------------

export function useTiltToWakeMarker(opts: TiltToWakeOptions): TiltToWakeReturn {
  const { investigationId, enabled = true, onMarkerDropped } = opts;

  const [lastDrop, setLastDrop] = useState<LastDrop | null>(null);
  const [permissionState, setPermissionState] = useState<TiltToWakePermissionState>(() => {
    // If DeviceMotionEvent doesn't exist, mark unavailable immediately.
    if (typeof DeviceMotionEvent === "undefined") return "unavailable";
    // If the platform doesn't gate the API (Android/desktop), treat as granted.
    const M = DeviceMotionEvent as unknown as { requestPermission?: unknown };
    if (typeof M.requestPermission !== "function") return "granted";
    return "unknown";
  });

  // Rolling compass heading — updated by a lightweight deviceorientation listener.
  const latestHeadingRef = useRef<number | null>(null);

  // Stable refs so the shake callback closure doesn't stale-capture state.
  const investigationIdRef = useRef<string | null>(investigationId);
  const enabledRef = useRef<boolean>(enabled);
  const onMarkerDroppedRef = useRef<typeof onMarkerDropped>(onMarkerDropped);
  useEffect(() => { investigationIdRef.current = investigationId; }, [investigationId]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onMarkerDroppedRef.current = onMarkerDropped; }, [onMarkerDropped]);

  // Detector is created once.
  const detectorRef = useRef<ShakeDetector | null>(null);

  const dropMarker = useCallback(async () => {
    const invId = investigationIdRef.current;
    if (!invId || !enabledRef.current) return;

    const headingDeg = latestHeadingRef.current;
    const cardinal: Cardinal16 = headingDeg != null
      ? headingToCardinal(headingDeg)
      : "N"; // fallback when compass unavailable

    const screenOrientation =
      typeof window !== "undefined" && window.screen?.orientation?.type
        ? window.screen.orientation.type
        : "unknown";

    // Haptic — silent on iOS (navigator.vibrate is undefined there).
    try { navigator.vibrate?.(80); } catch { /* ignore */ }

    // Audio confirmation — non-fatal if Web Audio unavailable.
    try { playChime(); } catch { /* ignore */ }

    const ts = new Date().toISOString();
    const tsMs = Date.now();

    let event;
    try {
      event = await recordEvent({
        investigation_id: invId,
        source: "user",
        event_type: "marker",
        title: "Quick marker (shake)",
        timestamp: ts,
        metadata: {
          trigger: "shake",
          cardinal,
          heading_deg: headingDeg,
          screen_orientation: screenOrientation,
          ts: tsMs,
        },
      });
    } catch (err) {
      console.error("[tiltToWake] recordEvent failed", err);
      return;
    }

    try {
      await appendAuditEntry({
        actor: "user",
        kind: "marker.quick",
        payload: { id: event.id, cardinal, heading_deg: headingDeg },
        ts,
      });
    } catch (err) {
      console.warn("[tiltToWake] appendAuditEntry failed", err);
    }

    const drop: LastDrop = { id: event.id, timestamp: ts, cardinal };
    setLastDrop(drop);
    onMarkerDroppedRef.current?.(event.id);
  }, []); // stable — all mutable values via refs

  // Create + start / stop the shake detector whenever permissionState changes.
  useEffect(() => {
    if (permissionState !== "granted") {
      detectorRef.current?.stop();
      return;
    }

    // Build the detector.
    const detector = new ShakeDetector({ onShake: () => { void dropMarker(); } });

    // On Android/desktop the permission is already considered granted from the
    // constructor's perspective — we need to set the internal flag by calling
    // requestPermission() (which returns "not-needed" immediately) OR by calling
    // start() directly since the API is ungated. We call start() directly here;
    // on iOS this path is only reached after requestPermission() granted above,
    // at which point the detector's own internal permissionGranted flag is still
    // false unless we re-call requestPermission on the instance. We handle this
    // by calling the instance requestPermission on iOS inside requestPermission()
    // below, which sets the flag before start() is reached. For the "granted"
    // path reached on Android from the initial useState, we need to mark the
    // instance as permitted. The cleanest way is to call the instance's own
    // requestPermission (which returns "not-needed" for Android immediately with
    // no user-gesture requirement) before starting.
    void detector.requestPermission().then(() => {
      detector.start();
    });

    detectorRef.current = detector;

    return () => {
      detector.stop();
      detectorRef.current = null;
    };
  }, [permissionState, dropMarker]);

  // Orientation listener — keep the latest compass heading.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: DeviceOrientationEvent) => {
      const evt = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (typeof evt.webkitCompassHeading === "number") {
        latestHeadingRef.current = evt.webkitCompassHeading;
      } else if (event.alpha != null) {
        latestHeadingRef.current = (360 - event.alpha) % 360;
      }
    };
    window.addEventListener("deviceorientationabsolute", handler as EventListener, true);
    window.addEventListener("deviceorientation", handler);
    return () => {
      window.removeEventListener("deviceorientationabsolute", handler as EventListener, true);
      window.removeEventListener("deviceorientation", handler);
    };
  }, []);

  // requestPermission — must be called from a user-gesture handler on iOS.
  const requestPermission = useCallback(async (): Promise<void> => {
    if (permissionState === "unavailable" || permissionState === "granted") return;

    // Build a temporary detector just to call its requestPermission, which
    // handles the iOS API correctly. Then update our hook state so the effect
    // above starts the real detector.
    const tempDetector = new ShakeDetector();
    const result: MotionPermissionResult = await tempDetector.requestPermission();

    if (result === "granted" || result === "not-needed") {
      setPermissionState("granted");
    } else if (result === "unavailable") {
      setPermissionState("unavailable");
    } else {
      setPermissionState("denied");
    }
  }, [permissionState]);

  return { lastDrop, permissionState, requestPermission };
}
