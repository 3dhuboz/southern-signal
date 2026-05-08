/**
 * Real magnetometer reading (Android Chrome only).
 * iOS gets a compass-heading proxy via deviceorientation — see motion.ts.
 *
 * Generic Sensor API: navigator.permissions.query({name: 'magnetometer'}) → request.
 * Sample rate ~10–60 Hz. Returns magnetic field in microteslas.
 */

export interface MagnetometerSample {
  timestamp: number;
  /** Magnitude of magnetic field vector, microteslas. */
  magnitude: number;
  x: number;
  y: number;
  z: number;
}

export function isMagnetometerSupported(): boolean {
  return typeof window !== "undefined" && "Magnetometer" in window;
}

export async function subscribeMagnetometer(
  onSample: (s: MagnetometerSample) => void,
  options: { frequency?: number } = {},
): Promise<{ stop: () => void } | null> {
  if (!isMagnetometerSupported()) return null;

  // Permissions — best-effort.
  try {
    if ("permissions" in navigator) {
      // The 'magnetometer' permission name is non-standard but Chrome supports it.
      // Don't await its result strictly — we'll let the sensor's onerror fire if denied.
      void (navigator.permissions as { query?: (q: { name: string }) => Promise<unknown> }).query?.({ name: "magnetometer" });
    }
  } catch {
    /* swallow */
  }

  try {
    type MagSensor = {
      x: number; y: number; z: number;
      start(): void; stop(): void;
      addEventListener(t: string, fn: (ev: Event) => void): void;
    };
    const Ctor = (window as unknown as { Magnetometer: new (opts: { frequency: number }) => MagSensor }).Magnetometer;
    const sensor = new Ctor({ frequency: options.frequency ?? 30 });
    sensor.addEventListener("reading", () => {
      const x = sensor.x, y = sensor.y, z = sensor.z;
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      onSample({ timestamp: performance.now(), magnitude, x, y, z });
    });
    sensor.addEventListener("error", () => {
      // permission denied / sensor unavailable — caller should show an honest message
    });
    sensor.start();
    return { stop: () => sensor.stop() };
  } catch {
    return null;
  }
}
