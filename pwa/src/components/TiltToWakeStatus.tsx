/**
 * TiltToWakeStatus — compact chip showing the shake-to-mark state.
 *
 * States:
 *   - "unknown"     → tappable prompt; tapping calls requestPermission()
 *   - "granted"     → green pulsing chip ("Shake-to-mark: ON")
 *   - "denied"      → muted chip ("Motion denied")
 *   - "unavailable" → grey chip ("Unavailable")
 *
 * When lastDrop changes, a 1.5s "✓ Marker dropped — [cardinal]" confirmation
 * replaces the chip briefly.
 */

import { useEffect, useRef, useState } from "react";
import { useTiltToWakeMarker } from "../hooks/useTiltToWakeMarker";
import s from "./TiltToWakeStatus.module.css";

interface TiltToWakeStatusProps {
  investigationId: string | null;
  className?: string;
}

export function TiltToWakeStatus({ investigationId, className }: TiltToWakeStatusProps) {
  const { lastDrop, permissionState, requestPermission } = useTiltToWakeMarker({
    investigationId,
  });

  // Track previous lastDrop.id so we only flash when it actually changes.
  const prevDropIdRef = useRef<string | null>(null);
  const [flashKey, setFlashKey] = useState<number>(0);
  const [flashContent, setFlashContent] = useState<string | null>(null);

  useEffect(() => {
    if (!lastDrop) return;
    if (lastDrop.id === prevDropIdRef.current) return;
    prevDropIdRef.current = lastDrop.id;
    setFlashContent(`Marker dropped — ${lastDrop.cardinal}`);
    setFlashKey((k) => k + 1);

    // Clear the confirmation after 1.5s + a small buffer for the fade.
    const id = window.setTimeout(() => setFlashContent(null), 1600);
    return () => window.clearTimeout(id);
  }, [lastDrop]);

  // Build chip class.
  let chipClass = s.chip;
  if (permissionState === "granted") chipClass += ` ${s.chipActive}`;
  else if (permissionState === "unknown") chipClass += ` ${s.chipTappable}`;
  else if (permissionState === "unavailable") chipClass += ` ${s.chipUnavailable}`;
  else if (permissionState === "denied") chipClass += ` ${s.chipDenied}`;
  if (className) chipClass += ` ${className}`;

  const handleChipClick = permissionState === "unknown"
    ? () => { void requestPermission(); }
    : undefined;

  return (
    <div className={s.wrap}>
      {/* Confirmation flash — rendered as a separate element so it can
          fade out while the main chip stays in place. */}
      {flashContent && (
        <div key={flashKey} className={s.confirm} aria-live="polite" aria-atomic="true">
          <span>✓</span>
          <span>{flashContent}</span>
        </div>
      )}

      {/* Main chip */}
      {permissionState === "unavailable" ? (
        <div
          className={chipClass}
          aria-label="Shake-to-mark unavailable on this device"
          title="DeviceMotion not supported on this device or browser"
        >
          <span className={s.dot} aria-hidden="true" />
          <span>Shake-to-mark unavailable</span>
        </div>
      ) : permissionState === "denied" ? (
        <div
          className={chipClass}
          aria-label="Motion permission denied"
          title="Motion permission was denied. Reload the page and grant access to enable shake-to-mark."
        >
          <span className={s.dot} aria-hidden="true" />
          <span>Motion denied</span>
        </div>
      ) : permissionState === "unknown" ? (
        <button
          type="button"
          className={chipClass}
          onClick={handleChipClick}
          aria-label="Enable shake-to-mark — tap to grant motion permission"
          title="Tap to enable hands-free shake-to-mark"
        >
          <span className={s.dot} aria-hidden="true" />
          <span>Shake-to-mark</span>
        </button>
      ) : (
        /* granted */
        <div
          className={chipClass}
          aria-label="Shake-to-mark active"
          title="Shake the phone twice quickly to drop a hands-free marker"
        >
          <span className={s.dot} aria-hidden="true" />
          <span>Shake-to-mark: ON</span>
        </div>
      )}
    </div>
  );
}
