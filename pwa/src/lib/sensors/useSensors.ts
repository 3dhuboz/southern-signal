/**
 * Single React hook that wires every sensor stream into shared state.
 *
 * Honest about platform gaps: feature-detects each sensor and reports its
 * availability. iOS users see "Compass anomaly" instead of "EMF" because
 * iOS doesn't expose a real magnetometer.
 */

import { useEffect, useRef, useState } from "react";
import type { LightSample } from "./light";
import type { MagnetometerSample } from "./magnetometer";
import type { MotionSample, OrientationSample } from "./motion";
import { isMagnetometerSupported, subscribeMagnetometer } from "./magnetometer";
import { subscribeMotion, subscribeOrientation } from "./motion";
import { isAmbientLightSupported, subscribeAmbientLight } from "./light";
import { type BaselineState, createBaseline, updateBaseline } from "./baseline";

export interface SensorSnapshot {
  motion: MotionSample | null;
  orientation: OrientationSample | null;
  magnetometer: MagnetometerSample | null;
  light: LightSample | null;
}

export interface AnomalyTile {
  /** Most-recent value for display. */
  value: number;
  /** Most-recent z-score. */
  z: number;
  /** Rolling mean. */
  mean: number;
  /** Rolling stddev. */
  stdev: number;
  /** True when |z| > 3 sustained. */
  alert: boolean;
}

export interface SensorState {
  ready: boolean;
  motionAvailable: boolean;
  orientationAvailable: boolean;
  magnetometerAvailable: boolean;
  lightAvailable: boolean;
  snapshot: SensorSnapshot;
  emf: AnomalyTile | null;
  vibration: AnomalyTile | null;
  compassAnomaly: AnomalyTile | null;
  lightAnomaly: AnomalyTile | null;
}

const ANOMALY_THRESHOLD = 3;

export function useSensors(active: boolean): SensorState {
  const [snapshot, setSnapshot] = useState<SensorSnapshot>({ motion: null, orientation: null, magnetometer: null, light: null });
  const [emf, setEmf] = useState<AnomalyTile | null>(null);
  const [vibration, setVibration] = useState<AnomalyTile | null>(null);
  const [compassAnomaly, setCompassAnomaly] = useState<AnomalyTile | null>(null);
  const [lightAnomaly, setLightAnomaly] = useState<AnomalyTile | null>(null);
  const [magnetometerAvailable, setMagnetometerAvailable] = useState(false);
  const [lightAvailable, setLightAvailable] = useState(false);

  const motionBaseline = useRef<BaselineState>(createBaseline(120));
  const magBaseline = useRef<BaselineState>(createBaseline(300));
  const compassBaseline = useRef<BaselineState>(createBaseline(120));
  const lightBaseline = useRef<BaselineState>(createBaseline(60));
  const lastHeading = useRef<number | null>(null);
  // All four sensors fire at native rates (devicemotion 50-60 Hz, orientation
  // ~30 Hz, magnetometer and ambient-light vary by platform but both push
  // every reading). setSnapshot / setEmf / setVibration / setCompassAnomaly /
  // setLightAnomaly each yield a fresh object, churning referential equality
  // for every downstream consumer (and re-rendering the SensorPanel etc.) at
  // the native rate for the lifetime of a session. Throttle the React
  // commits to ~10 Hz; the baseline z-score still advances every event, but
  // the visible state only flips on a 100 ms grid. Anomaly threshold
  // crossings ALWAYS flush immediately so an alert isn't delayed up to
  // 100 ms. The watchdog / posterior engine read from sensors.snapshot via
  // refs in their own effects, so they're not starved by the throttle.
  const SENSOR_STATE_INTERVAL_MS = 100;
  const lastMotionStateEmitRef = useRef<number>(0);
  const lastOrientationStateEmitRef = useRef<number>(0);
  const lastMagStateEmitRef = useRef<number>(0);
  const lastLightStateEmitRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;

    const unsubMotion = subscribeMotion((s) => {
      // Always advance the baseline so the z-score reflects every event.
      const result = updateBaseline(motionBaseline.current, s.accelMagnitude);
      motionBaseline.current = result.state;
      // Throttle the React commits to 10 Hz. ALWAYS flush when the latest
      // event crosses the anomaly threshold — operators must see the alert
      // immediately rather than waiting up to 100 ms.
      const now = performance.now();
      const alert = Math.abs(result.z) > ANOMALY_THRESHOLD;
      if (alert || now - lastMotionStateEmitRef.current >= SENSOR_STATE_INTERVAL_MS) {
        lastMotionStateEmitRef.current = now;
        setSnapshot((prev) => ({ ...prev, motion: s }));
        setVibration({
          value: s.accelMagnitude,
          z: result.z,
          mean: result.mean,
          stdev: result.stdev,
          alert,
        });
      }
    });

    const unsubOrientation = subscribeOrientation((s) => {
      // Advance the heading-delta baseline on every event (cheap), but
      // throttle the React commit. Same alert-flush pattern as motion.
      let baselineUpdate: { z: number; mean: number; stdev: number; alert: boolean; delta: number } | null = null;
      if (s.heading != null) {
        if (lastHeading.current != null) {
          let delta = s.heading - lastHeading.current;
          while (delta > 180) delta -= 360;
          while (delta < -180) delta += 360;
          const result = updateBaseline(compassBaseline.current, Math.abs(delta));
          compassBaseline.current = result.state;
          baselineUpdate = {
            z: result.z,
            mean: result.mean,
            stdev: result.stdev,
            alert: Math.abs(result.z) > ANOMALY_THRESHOLD,
            delta: Math.abs(delta),
          };
        }
        lastHeading.current = s.heading;
      }
      const now = performance.now();
      if (baselineUpdate?.alert || now - lastOrientationStateEmitRef.current >= SENSOR_STATE_INTERVAL_MS) {
        lastOrientationStateEmitRef.current = now;
        setSnapshot((prev) => ({ ...prev, orientation: s }));
        if (baselineUpdate) {
          setCompassAnomaly({
            value: baselineUpdate.delta,
            z: baselineUpdate.z,
            mean: baselineUpdate.mean,
            stdev: baselineUpdate.stdev,
            alert: baselineUpdate.alert,
          });
        }
      }
    });

    let stopMag: (() => void) | null = null;
    if (isMagnetometerSupported()) {
      setMagnetometerAvailable(true);
      void subscribeMagnetometer((s) => {
        const result = updateBaseline(magBaseline.current, s.magnitude);
        magBaseline.current = result.state;
        const alert = Math.abs(result.z) > ANOMALY_THRESHOLD;
        const now = performance.now();
        if (alert || now - lastMagStateEmitRef.current >= SENSOR_STATE_INTERVAL_MS) {
          lastMagStateEmitRef.current = now;
          setSnapshot((prev) => ({ ...prev, magnetometer: s }));
          setEmf({
            value: s.magnitude,
            z: result.z,
            mean: result.mean,
            stdev: result.stdev,
            alert,
          });
        }
      }).then((subscription) => {
        if (subscription) stopMag = subscription.stop;
      });
    }

    let stopLight: (() => void) | null = null;
    if (isAmbientLightSupported()) {
      setLightAvailable(true);
      void subscribeAmbientLight((s) => {
        const result = updateBaseline(lightBaseline.current, s.lux);
        lightBaseline.current = result.state;
        const alert = Math.abs(result.z) > ANOMALY_THRESHOLD;
        const now = performance.now();
        if (alert || now - lastLightStateEmitRef.current >= SENSOR_STATE_INTERVAL_MS) {
          lastLightStateEmitRef.current = now;
          setSnapshot((prev) => ({ ...prev, light: s }));
          setLightAnomaly({
            value: s.lux,
            z: result.z,
            mean: result.mean,
            stdev: result.stdev,
            alert,
          });
        }
      }).then((subscription) => {
        if (subscription) stopLight = subscription.stop;
      });
    }

    return () => {
      unsubMotion();
      unsubOrientation();
      stopMag?.();
      stopLight?.();
    };
  }, [active]);

  return {
    ready: active,
    motionAvailable: typeof DeviceMotionEvent !== "undefined",
    orientationAvailable: typeof DeviceOrientationEvent !== "undefined",
    magnetometerAvailable,
    lightAvailable,
    snapshot,
    emf,
    vibration,
    compassAnomaly,
    lightAnomaly,
  };
}
