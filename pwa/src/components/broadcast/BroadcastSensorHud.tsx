/**
 * BroadcastSensorHud — top-right compact sensor data block.
 *
 * Live key/value strip showing the three sensors the operator most often
 * watches on a hunt: ambient magnetic flux (EMF / "compass anomaly" on
 * iOS), ambient illuminance, and recent motion magnitude. Each row is a
 * mono key + right-aligned value pair so the column lines up like an
 * OB-van data block.
 *
 * Graceful degradation: rows are only rendered when the underlying sensor
 * is actually reporting samples. iOS Safari typically has no real
 * Magnetometer API — useSensors leaves `magnetometer` null in that case;
 * the EMF row simply doesn't render rather than showing a fake reading.
 * That keeps the chrome honest for the Bayesian / acoustician reviewer
 * who'll inspect this surface pre-air.
 *
 * Threshold flashes: when the parent's per-sensor AnomalyTile reports
 * `alert: true` (|z| > 3 sustained), the corresponding row flashes the
 * --signal accent for 400 ms via a CSS keyframe driven by a `data-alert`
 * attribute toggle. The flash is debounced — the keyframe restarts only
 * on a 0→1 transition, so a sustained alert pulses once not endlessly.
 *
 * All units are SI / human-readable: EMF magnitude in microteslas (µT),
 * lux is unitless count, accel magnitude in m/s². No degrees Celsius
 * row — iOS exposes no thermometer; we don't fake one.
 */
import { useEffect, useRef, useState } from "react";
import type { LightSample } from "../../lib/sensors/light";
import type { MagnetometerSample } from "../../lib/sensors/magnetometer";
import type { MotionSample } from "../../lib/sensors/motion";
import s from "./BroadcastSensorHud.module.css";

/** Minimal subset of useSensors().emf etc. the HUD needs. Decoupled from
 *  the wider AnomalyTile shape so consumers can hand-roll an alert flag. */
interface AnomalyHint {
  alert: boolean;
}

interface Props {
  magnetometer: MagnetometerSample | null;
  light: LightSample | null;
  motion: MotionSample | null;
  /** EMF anomaly tile (z-score driven). When `alert`, the EMF row flashes. */
  emfAlert?: AnomalyHint | null;
  /** Vibration / motion anomaly tile. When `alert`, the ACC row flashes. */
  motionAlert?: AnomalyHint | null;
  /** Light anomaly tile. When `alert`, the LUX row flashes. */
  lightAlert?: AnomalyHint | null;
  /** Whether the magnetometer hardware is actually supported on this
   *  device. iOS Safari → false, the EMF row is suppressed entirely. */
  magnetometerAvailable: boolean;
  /** Same gate for the ambient-light sensor. Camera-derived light still
   *  passes through `light` so this gate is independent. */
  lightAvailable: boolean;
}

/** Format a sensor value for the right column. We use tabular-nums in CSS
 *  so the column doesn't jitter across single-digit / two-digit jumps. */
function fmt(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(decimals);
}

/** Tiny hook: returns a 1 when `alert` rises 0→1, with auto-clear after
 *  FLASH_MS so the keyframe restarts cleanly on the next rising edge.
 *  Avoids a stale `data-alert="1"` that would freeze the row in the
 *  flash colour. */
const FLASH_MS = 400;
function useFlashOnRising(alert: boolean): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef(false);
  useEffect(() => {
    if (alert && !prev.current) {
      setFlash(true);
      const t = window.setTimeout(() => setFlash(false), FLASH_MS);
      prev.current = true;
      return () => window.clearTimeout(t);
    }
    if (!alert) prev.current = false;
  }, [alert]);
  return flash;
}

export function BroadcastSensorHud({
  magnetometer,
  light,
  motion,
  emfAlert,
  motionAlert,
  lightAlert,
  magnetometerAvailable,
  lightAvailable,
}: Props) {
  const emfFlash = useFlashOnRising(emfAlert?.alert ?? false);
  const motionFlash = useFlashOnRising(motionAlert?.alert ?? false);
  const lightFlash = useFlashOnRising(lightAlert?.alert ?? false);

  // Each row renders only when both the hardware is available AND we've
  // observed at least one sample. The all-empty case suppresses the panel
  // entirely so an iOS phone with no granted sensors doesn't see an empty
  // glass rectangle.
  const showEmf = magnetometerAvailable && magnetometer != null;
  const showLux = lightAvailable && light != null;
  const showAcc = motion != null;
  const anyVisible = showEmf || showLux || showAcc;
  if (!anyVisible) return null;

  // A11y: when a row flashes cyan on a threshold cross, sighted operators
  // see the wash; a screen-reader operator needs an equivalent announcement.
  // We build a per-sensor announcement string only while the flash is hot
  // and feed it into a polite aria-live region — keeps the page quiet
  // except on the rising edge, mirroring the visual pulse.
  const emfAnnouncement = emfFlash && magnetometer
    ? `EMF anomaly: ${fmt(magnetometer.magnitude, 1)} micro-tesla`
    : "";
  const luxAnnouncement = lightFlash && light
    ? `Light anomaly: ${fmt(light.lux, light.lux < 10 ? 1 : 0)} lux`
    : "";
  const accAnnouncement = motionFlash && motion
    ? `Motion anomaly: ${fmt(motion.accelMagnitude, 2)} metres per second squared`
    : "";
  const liveAnnouncement = [emfAnnouncement, luxAnnouncement, accAnnouncement]
    .filter(Boolean)
    .join(". ");

  return (
    <div
      className={s.hud}
      data-hud-drag-target="sensors"
      role="group"
      aria-label="Live sensor readings"
    >
      {showEmf && (
        <div
          className={s.row}
          data-alert={emfFlash ? "1" : "0"}
        >
          <span className={s.key}>EMF</span>
          <span className={s.value}>
            <span className={s.num}>{fmt(magnetometer!.magnitude, 1)}</span>
            <span className={s.unit}>µT</span>
          </span>
        </div>
      )}
      {showLux && (
        <div
          className={s.row}
          data-alert={lightFlash ? "1" : "0"}
        >
          <span className={s.key}>LUX</span>
          <span className={s.value}>
            <span className={s.num}>{fmt(light!.lux, light!.lux < 10 ? 1 : 0)}</span>
            <span className={s.unit}>lx</span>
          </span>
        </div>
      )}
      {showAcc && (
        <div
          className={s.row}
          data-alert={motionFlash ? "1" : "0"}
        >
          <span className={s.key}>ACC</span>
          <span className={s.value}>
            <span className={s.num}>{fmt(motion!.accelMagnitude, 2)}</span>
            <span className={s.unit}>m/s²</span>
          </span>
        </div>
      )}
      {/* Visually-hidden live region: AT users hear the spike at the
          same moment a sighted operator sees the row flash cyan. The
          region is empty when no flash is active so the page stays
          quiet between events. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveAnnouncement}
      </span>
    </div>
  );
}
