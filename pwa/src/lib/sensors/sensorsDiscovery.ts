/**
 * Sensors discovery — runtime feature-detection for every phone sensor /
 * platform API the app can use. No prompts, no permissions; just a
 * snapshot of what's available, with live readings where free.
 *
 * The Pi-hub branch keeps everything else this app doesn't have native
 * access to (real EMF meter, LIDAR, IR thermal). For phone-only V1, this
 * is the catalogue.
 */

import { useEffect, useState } from "react";

export type SensorState = "available" | "needs-permission" | "unavailable" | "live";

export interface SensorRow {
  id: string;
  label: string;
  state: SensorState;
  value?: string;
  detail?: string;
}

interface BatterySnapshot {
  charging: boolean;
  level: number;
}

interface NetworkSnapshot {
  online: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
}

function safeNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function useSensorsDiscovery(): SensorRow[] {
  const [rows, setRows] = useState<SensorRow[]>(() => initialSnapshot());

  // Network: cheap, free.
  const [network, setNetwork] = useState<NetworkSnapshot>(() => readNetwork());
  useEffect(() => {
    const fn = () => setNetwork(readNetwork());
    window.addEventListener("online", fn);
    window.addEventListener("offline", fn);
    const conn = (navigator as { connection?: EventTarget }).connection;
    conn?.addEventListener?.("change", fn);
    return () => {
      window.removeEventListener("online", fn);
      window.removeEventListener("offline", fn);
      conn?.removeEventListener?.("change", fn);
    };
  }, []);

  // Battery: getBattery() is a one-shot promise that returns a live object.
  const [battery, setBattery] = useState<BatterySnapshot | null>(null);
  useEffect(() => {
    let mounted = true;
    let mgr: EventTarget | null = null;
    const update = (b: { charging: boolean; level: number }) => {
      if (mounted) setBattery({ charging: b.charging, level: b.level });
    };
    const navAny = navigator as { getBattery?: () => Promise<{ charging: boolean; level: number; addEventListener: (k: string, fn: () => void) => void; removeEventListener: (k: string, fn: () => void) => void }> };
    if (typeof navAny.getBattery === "function") {
      navAny.getBattery().then((mgrIn) => {
        mgr = mgrIn as unknown as EventTarget;
        update(mgrIn);
        const fn = () => update(mgrIn);
        mgrIn.addEventListener("levelchange", fn);
        mgrIn.addEventListener("chargingchange", fn);
      }).catch(() => { /* ignore */ });
    }
    return () => {
      mounted = false;
      void mgr;
    };
  }, []);

  // Ambient Light Sensor.
  const [lightLux, setLightLux] = useState<number | null>(null);
  const [lightState, setLightState] = useState<SensorState>("unavailable");
  useEffect(() => {
    interface AmbientSensorLike extends EventTarget {
      illuminance?: number;
      start(): void;
      stop(): void;
    }
    const Ctor = (window as unknown as { AmbientLightSensor?: new () => AmbientSensorLike }).AmbientLightSensor;
    if (typeof Ctor !== "function") {
      setLightState("unavailable");
      return;
    }
    setLightState("needs-permission");
    let sensor: AmbientSensorLike | null = null;
    try {
      sensor = new Ctor();
      const onReading = () => {
        if (sensor && typeof sensor.illuminance === "number") {
          setLightLux(sensor.illuminance);
          setLightState("live");
        }
      };
      const onError = () => setLightState("unavailable");
      sensor.addEventListener("reading", onReading);
      sensor.addEventListener("error", onError);
      try { sensor.start(); } catch { setLightState("unavailable"); }
      return () => {
        sensor?.removeEventListener("reading", onReading);
        sensor?.removeEventListener("error", onError);
        try { sensor?.stop(); } catch { /* ignore */ }
      };
    } catch {
      setLightState("unavailable");
    }
  }, []);

  // Memory snapshot (where available).
  const [memoryGB, setMemoryGB] = useState<number | null>(null);
  useEffect(() => {
    const navAny = navigator as { deviceMemory?: number };
    if (typeof navAny.deviceMemory === "number") setMemoryGB(navAny.deviceMemory);
  }, []);

  // CPU cores (free).
  const cpuCores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? null : null;

  // Compose rows whenever any of the live values changes.
  useEffect(() => {
    const next: SensorRow[] = [];

    // Network
    next.push({
      id: "network",
      label: "Network",
      state: network.online ? "live" : "available",
      value: network.online ? "Online" : "Offline",
      detail: network.effectiveType ? `${network.effectiveType.toUpperCase()}${network.downlinkMbps ? ` · ${network.downlinkMbps.toFixed(1)} Mbps` : ""}` : "",
    });

    // Battery
    if (battery) {
      next.push({
        id: "battery",
        label: "Battery",
        state: "live",
        value: `${Math.round(battery.level * 100)}%`,
        detail: battery.charging ? "Charging" : "On battery",
      });
    } else {
      next.push({ id: "battery", label: "Battery", state: "unavailable", value: "—", detail: "API hidden by browser" });
    }

    // Ambient Light
    next.push({
      id: "ambient-light",
      label: "Ambient light",
      state: lightState,
      value: lightLux != null ? `${safeNum(lightLux, 0)} lx` : (lightState === "needs-permission" ? "Tap to allow" : "—"),
      detail: lightState === "unavailable" ? "Not supported (iOS Safari)" : lightLux != null ? "Live lux" : "Generic Sensor API",
    });

    // Camera (always available behind permission)
    const hasGUM = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
    next.push({
      id: "camera",
      label: "Camera",
      state: hasGUM ? "needs-permission" : "unavailable",
      value: hasGUM ? "Stereo + rear" : "—",
      detail: "MediaDevices.getUserMedia",
    });

    // Microphone
    next.push({
      id: "microphone",
      label: "Microphone",
      state: hasGUM ? "needs-permission" : "unavailable",
      value: hasGUM ? "48 kHz stereo" : "—",
      detail: "Used by acoustic + infrasound detectors",
    });

    // GPS
    next.push({
      id: "gps",
      label: "GPS / location",
      state: typeof navigator !== "undefined" && "geolocation" in navigator ? "needs-permission" : "unavailable",
      value: "—",
      detail: "Used by Country acknowledgement gate",
    });

    // Motion / orientation
    next.push({
      id: "motion",
      label: "Accelerometer + gyroscope",
      state: typeof DeviceMotionEvent !== "undefined" ? "needs-permission" : "unavailable",
      value: "—",
      detail: "DeviceMotionEvent",
    });

    // Magnetometer
    next.push({
      id: "magnetometer",
      label: "Magnetometer",
      state: (typeof window !== "undefined" && "Magnetometer" in window) ? "needs-permission" : "unavailable",
      value: "—",
      detail: "Generic Sensor API · Android only",
    });

    // Barometer (where available)
    next.push({
      id: "barometer",
      label: "Barometric pressure",
      state: (typeof window !== "undefined" && ("Barometer" in window || "PressureObserver" in window)) ? "needs-permission" : "unavailable",
      value: "—",
      detail: "Generic Sensor API · select Android",
    });

    // Wake lock
    next.push({
      id: "wake-lock",
      label: "Screen wake lock",
      state: ("wakeLock" in navigator) ? "available" : "unavailable",
      value: "—",
      detail: "Keeps screen on during recording",
    });

    // Vibration
    next.push({
      id: "vibration",
      label: "Vibration",
      state: ("vibrate" in navigator) ? "available" : "unavailable",
      value: "—",
      detail: "Haptic feedback on capture",
    });

    // Web Bluetooth
    next.push({
      id: "bluetooth",
      label: "Web Bluetooth",
      state: ("bluetooth" in navigator) ? "available" : "unavailable",
      value: "—",
      detail: "USB/BT addons (EMF meters, IR cameras)",
    });

    // Web Serial
    next.push({
      id: "serial",
      label: "Web Serial",
      state: ("serial" in navigator) ? "available" : "unavailable",
      value: "—",
      detail: "Pi-hub or DIY ESP32 sensor packs",
    });

    // Web USB
    next.push({
      id: "usb",
      label: "Web USB",
      state: ("usb" in navigator) ? "available" : "unavailable",
      value: "—",
      detail: "USB-C addons via WebUSB",
    });

    // OPFS
    next.push({
      id: "opfs",
      label: "Local file system (OPFS)",
      state: (typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage) ? "live" : "unavailable",
      value: "—",
      detail: "Origin Private File System for media",
    });

    // Hardware
    next.push({
      id: "cpu",
      label: "CPU cores",
      state: cpuCores ? "live" : "unavailable",
      value: cpuCores != null ? `${cpuCores}` : "—",
      detail: "Hardware concurrency",
    });

    if (memoryGB != null) {
      next.push({
        id: "memory",
        label: "Device memory",
        state: "live",
        value: `${memoryGB} GB`,
        detail: "navigator.deviceMemory",
      });
    }

    setRows(next);
  }, [network, battery, lightState, lightLux, memoryGB, cpuCores]);

  return rows;
}

function readNetwork(): NetworkSnapshot {
  const conn = (navigator as { connection?: { effectiveType?: string; downlink?: number } }).connection;
  return {
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    effectiveType: conn?.effectiveType,
    downlinkMbps: conn?.downlink,
  };
}

function initialSnapshot(): SensorRow[] {
  return [];
}
