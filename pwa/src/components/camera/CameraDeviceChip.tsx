/**
 * CameraDeviceChip — always-on device-state chip (battery % + storage free).
 *
 * Extracted from CameraHud.tsx as part of the 2026-05-22 camera overhaul.
 * The chip is fed by the watchdog tick in CameraScreen: every 60s the
 * preflight checks re-run, and the battery / storage readings push through
 * to props here. Tone shifts to warn when either crosses the watchdog
 * threshold; both readings render side-by-side so the operator can clock
 * device state at a glance without opening Setup.
 *
 * Visibility gating ("show only when running AND at least one reading is
 * present") lives in the parent — this component renders whatever it's
 * handed. Passing both null returns null so the parent can pass the same
 * props unconditionally if that's cleaner.
 *
 * Tokens: --chip-bg / --chip-rim / --chip-text + --chip-warn-* (Wave 1A).
 */
import s from "./CameraDeviceChip.module.css";

export interface CameraDeviceChipProps {
  /** Latest battery percentage (0..100). Null when the reading is unavailable. */
  batteryPct: number | null;
  /** True when the device reports it's charging — shows a ⚡ glyph. */
  batteryCharging: boolean;
  /** Latest storage_free in MB. Null when unavailable. */
  storageMb: number | null;
  /** True when battery is below the watchdog threshold — colours the chip warn. */
  batteryWarn: boolean;
  /** True when storage_free is below the watchdog threshold. */
  storageWarn: boolean;
}

export function CameraDeviceChip({
  batteryPct,
  batteryCharging,
  storageMb,
  batteryWarn,
  storageWarn,
}: CameraDeviceChipProps) {
  // Defensive null guard — return null so the parent's grid stays clean
  // (no empty pill rendered into the status rail when there's nothing to show).
  if (batteryPct === null && storageMb === null) return null;

  return (
    <div
      className={`${s.deviceChip} ${batteryWarn || storageWarn ? s.deviceChipWarn : ""}`.trim()}
      aria-label="Device state"
    >
      {batteryPct !== null && (
        <span
          className={`${s.deviceChipReading} ${batteryWarn ? s.deviceChipReadingWarn : ""}`.trim()}
        >
          {batteryCharging && <span className={s.deviceChipIcon} aria-hidden="true">⚡</span>}
          <span className={s.deviceChipValue}>{batteryPct}%</span>
        </span>
      )}
      {batteryPct !== null && storageMb !== null && (
        <span className={s.deviceChipSep} aria-hidden="true">·</span>
      )}
      {storageMb !== null && (
        <span
          className={`${s.deviceChipReading} ${storageWarn ? s.deviceChipReadingWarn : ""}`.trim()}
        >
          <span className={s.deviceChipValue}>
            {storageMb >= 1024
              ? `${(storageMb / 1024).toFixed(1)}GB`
              : `${storageMb}MB`}
          </span>
          <span className={s.deviceChipUnit}>free</span>
        </span>
      )}
    </div>
  );
}
