/**
 * useSystemStatus — surfaces battery + storage telemetry for the AppHeader pills.
 *
 * Field operators care about two things mid-investigation:
 *   • Battery — running out kills the session. Battery Status API exists in
 *     Chromium but Safari/Firefox do not implement it; gracefully omit.
 *   • OPFS storage — we accumulate WAV captures and frame buffers; if quota
 *     fills, recording will fail silently. Surface free bytes early.
 *
 * Both polled at 60s. Battery also subscribes to native level/charging events
 * so it ticks immediately when a charger is plugged in.
 */

import { useEffect, useState } from "react";
import { getStorageEstimate } from "../opfs";

interface BatteryManager extends EventTarget {
  level: number;
  charging: boolean;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

export interface SystemStatus {
  batteryPct: number | null;
  charging: boolean | null;
  storageFreeMB: number | null;
  storageUsedPct: number | null;
}

const POLL_MS = 60_000;

export function useSystemStatus(): SystemStatus {
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  const [storageFreeMB, setStorageFreeMB] = useState<number | null>(null);
  const [storageUsedPct, setStorageUsedPct] = useState<number | null>(null);

  // Battery
  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== "function") return;

    let cancelled = false;
    let intervalId: number | null = null;

    const apply = (b: BatteryManager) => {
      if (cancelled) return;
      setBatteryPct(Math.round(b.level * 100));
      setCharging(Boolean(b.charging));
    };

    nav
      .getBattery()
      .then((b) => {
        if (cancelled) return;
        apply(b);
        const onLevel = () => apply(b);
        const onCharge = () => apply(b);
        b.addEventListener("levelchange", onLevel);
        b.addEventListener("chargingchange", onCharge);
        intervalId = window.setInterval(() => apply(b), POLL_MS);
        return () => {
          b.removeEventListener("levelchange", onLevel);
          b.removeEventListener("chargingchange", onCharge);
        };
      })
      .catch(() => {
        // Some browsers expose getBattery but reject (e.g. permissions).
        // Leave nulls in state so the pill stays hidden.
      });

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);

  // Storage
  useEffect(() => {
    if (!("storage" in navigator) || !("estimate" in navigator.storage)) return;

    let cancelled = false;
    const tick = async () => {
      const { usage, quota } = await getStorageEstimate();
      if (cancelled) return;
      if (typeof quota === "number" && quota > 0) {
        const used = typeof usage === "number" ? usage : 0;
        const free = Math.max(0, quota - used);
        setStorageFreeMB(free / (1024 * 1024));
        setStorageUsedPct((used / quota) * 100);
      }
    };
    void tick();
    const intervalId = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return { batteryPct, charging, storageFreeMB, storageUsedPct };
}
