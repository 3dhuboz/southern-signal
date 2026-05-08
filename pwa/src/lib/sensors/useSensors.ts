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

  useEffect(() => {
    if (!active) return;

    const unsubMotion = subscribeMotion((s) => {
      setSnapshot((prev) => ({ ...prev, motion: s }));
      const result = updateBaseline(motionBaseline.current, s.accelMagnitude);
      motionBaseline.current = result.state;
      setVibration({
        value: s.accelMagnitude,
        z: result.z,
        mean: result.mean,
        stdev: result.stdev,
        alert: Math.abs(result.z) > ANOMALY_THRESHOLD,
      });
    });

    const unsubOrientation = subscribeOrientation((s) => {
      setSnapshot((prev) => ({ ...prev, orientation: s }));
      if (s.heading != null) {
        if (lastHeading.current != null) {
          // Compute shortest-path heading delta (degrees).
          let delta = s.heading - lastHeading.current;
          while (delta > 180) delta -= 360;
          while (delta < -180) delta += 360;
          const result = updateBaseline(compassBaseline.current, Math.abs(delta));
          compassBaseline.current = result.state;
          setCompassAnomaly({
            value: Math.abs(delta),
            z: result.z,
            mean: result.mean,
            stdev: result.stdev,
            alert: Math.abs(result.z) > ANOMALY_THRESHOLD,
          });
        }
        lastHeading.current = s.heading;
      }
    });

    let stopMag: (() => void) | null = null;
    if (isMagnetometerSupported()) {
      setMagnetometerAvailable(true);
      void subscribeMagnetometer((s) => {
        setSnapshot((prev) => ({ ...prev, magnetometer: s }));
        const result = updateBaseline(magBaseline.current, s.magnitude);
        magBaseline.current = result.state;
        setEmf({
          value: s.magnitude,
          z: result.z,
          mean: result.mean,
          stdev: result.stdev,
          alert: Math.abs(result.z) > ANOMALY_THRESHOLD,
        });
      }).then((subscription) => {
        if (subscription) stopMag = subscription.stop;
      });
    }

    let stopLight: (() => void) | null = null;
    if (isAmbientLightSupported()) {
      setLightAvailable(true);
      void subscribeAmbientLight((s) => {
        setSnapshot((prev) => ({ ...prev, light: s }));
        const result = updateBaseline(lightBaseline.current, s.lux);
        lightBaseline.current = result.state;
        setLightAnomaly({
          value: s.lux,
          z: result.z,
          mean: result.mean,
          stdev: result.stdev,
          alert: Math.abs(result.z) > ANOMALY_THRESHOLD,
        });
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
