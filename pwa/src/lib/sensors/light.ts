/**
 * Ambient light — Android-only via AmbientLightSensor (Generic Sensor API).
 * On iOS, fall back to camera mean-luminance (start camera at low resolution
 * and read mean Y of frames). Camera fallback is implemented by callers when
 * the camera is already active.
 */

export interface LightSample {
  timestamp: number;
  /** Illuminance in lux. */
  lux: number;
  source: "ambient-light-sensor" | "camera";
}

export function isAmbientLightSupported(): boolean {
  return typeof window !== "undefined" && "AmbientLightSensor" in window;
}

export async function subscribeAmbientLight(
  onSample: (s: LightSample) => void,
  options: { frequency?: number } = {},
): Promise<{ stop: () => void } | null> {
  if (!isAmbientLightSupported()) return null;
  try {
    type LightSensor = {
      illuminance: number;
      start(): void; stop(): void;
      addEventListener(t: string, fn: (ev: Event) => void): void;
    };
    const Ctor = (window as unknown as { AmbientLightSensor: new (opts: { frequency: number }) => LightSensor }).AmbientLightSensor;
    const sensor = new Ctor({ frequency: options.frequency ?? 5 });
    sensor.addEventListener("reading", () => {
      onSample({ timestamp: performance.now(), lux: sensor.illuminance, source: "ambient-light-sensor" });
    });
    sensor.addEventListener("error", () => {});
    sensor.start();
    return { stop: () => sensor.stop() };
  } catch {
    return null;
  }
}
