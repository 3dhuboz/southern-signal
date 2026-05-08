/**
 * Motion / orientation streams.
 *
 * Linear acceleration magnitude (gravity-removed) is the core signal for
 * "vibration / micro-tilt" tools. We subtract the gravity vector from the
 * raw accelerationIncludingGravity reading to get a usable signal.
 */

export interface MotionSample {
  timestamp: number;
  /** Magnitude of linear acceleration with gravity removed, in m/s^2. */
  accelMagnitude: number;
  /** Raw axes (including gravity), m/s^2. */
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate, deg/s. */
  alpha: number;
  beta: number;
  gamma: number;
}

export interface OrientationSample {
  timestamp: number;
  /** Compass heading 0-360°. iOS exposes webkitCompassHeading; Android exposes alpha (different reference). */
  heading: number | null;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** True if reading is platform-corrected (iOS only). */
  trueNorth: boolean;
}

const GRAVITY_FILTER_ALPHA = 0.8;

export function subscribeMotion(onSample: (s: MotionSample) => void): () => void {
  let gravity = { x: 0, y: 0, z: 9.81 };
  const handler = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity ?? event.acceleration;
    if (!acc || acc.x == null || acc.y == null || acc.z == null) return;
    // Low-pass to estimate gravity, subtract to get linear accel.
    gravity = {
      x: GRAVITY_FILTER_ALPHA * gravity.x + (1 - GRAVITY_FILTER_ALPHA) * acc.x,
      y: GRAVITY_FILTER_ALPHA * gravity.y + (1 - GRAVITY_FILTER_ALPHA) * acc.y,
      z: GRAVITY_FILTER_ALPHA * gravity.z + (1 - GRAVITY_FILTER_ALPHA) * acc.z,
    };
    const lx = acc.x - gravity.x;
    const ly = acc.y - gravity.y;
    const lz = acc.z - gravity.z;
    const mag = Math.sqrt(lx * lx + ly * ly + lz * lz);
    onSample({
      timestamp: event.timeStamp,
      accelMagnitude: mag,
      ax: acc.x,
      ay: acc.y,
      az: acc.z,
      alpha: event.rotationRate?.alpha ?? 0,
      beta: event.rotationRate?.beta ?? 0,
      gamma: event.rotationRate?.gamma ?? 0,
    });
  };
  window.addEventListener("devicemotion", handler);
  return () => window.removeEventListener("devicemotion", handler);
}

export function subscribeOrientation(onSample: (s: OrientationSample) => void): () => void {
  const handler = (event: DeviceOrientationEvent) => {
    const evt = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
    const compass = typeof evt.webkitCompassHeading === "number"
      ? evt.webkitCompassHeading
      : event.alpha != null
        ? (360 - event.alpha) % 360
        : null;
    onSample({
      timestamp: event.timeStamp,
      heading: compass,
      alpha: event.alpha,
      beta: event.beta,
      gamma: event.gamma,
      trueNorth: typeof evt.webkitCompassHeading === "number",
    });
  };
  window.addEventListener("deviceorientation", handler);
  return () => window.removeEventListener("deviceorientation", handler);
}
