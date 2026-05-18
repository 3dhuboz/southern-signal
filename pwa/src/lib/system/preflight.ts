/**
 * preflight — single-call health check for the camera-first surface.
 *
 * Run before the Begin gesture. Returns a structured summary the UI can use
 * to either (a) just kick off the session if everything's healthy, or (b)
 * surface a blocker with actionable hints if something critical is broken.
 *
 * Why not just let `getUserMedia` fail? Two reasons:
 *   1. A permission denial 10 minutes into a hunt is unrecoverable — the
 *      user has missed the moment they were trying to capture. Catching it
 *      pre-flight gives them a chance to grant permissions cleanly.
 *   2. Storage quota fills are silent killers. The recorder happily writes
 *      to OPFS until the disk's full, then drops chunks without surfacing
 *      a useful error. Better to refuse to start when quota is < 200MB.
 */

export type PreflightLevel = "ok" | "warn" | "block";

export interface PreflightCheck {
  id: "camera" | "mic" | "storage" | "battery";
  level: PreflightLevel;
  message: string;
}

export interface PreflightReport {
  overall: PreflightLevel;
  checks: PreflightCheck[];
}

const MIN_STORAGE_BYTES = 200 * 1024 * 1024; // 200MB — roughly 10 min of WebM
const LOW_BATTERY_PCT = 0.20;

async function checkCamera(): Promise<PreflightCheck> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { id: "camera", level: "block", message: "This browser doesn't expose a camera. HTTPS is required and the site must be opened in a real browser, not an in-app webview." };
  }
  // Permissions API is best-effort — Safari iOS in particular doesn't expose
  // "camera" / "microphone" via navigator.permissions on older versions.
  try {
    const status = await navigator.permissions?.query?.({ name: "camera" as PermissionName });
    if (status?.state === "denied") {
      return { id: "camera", level: "block", message: "Camera permission is denied. Open the site's permissions in your browser settings to re-enable." };
    }
  } catch { /* permissions API absent — getUserMedia will surface the issue */ }
  return { id: "camera", level: "ok", message: "Camera API available." };
}

async function checkMic(): Promise<PreflightCheck> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { id: "mic", level: "block", message: "This browser doesn't expose a microphone." };
  }
  try {
    const status = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
    if (status?.state === "denied") {
      return { id: "mic", level: "block", message: "Microphone permission is denied. Re-enable in browser settings." };
    }
  } catch { /* ignore */ }
  return { id: "mic", level: "ok", message: "Microphone API available." };
}

async function checkStorage(): Promise<PreflightCheck> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { id: "storage", level: "warn", message: "Can't read storage quota on this browser — recordings will land on the device but the safety check is skipped." };
  }
  try {
    const est = await navigator.storage.estimate();
    const usage = est.usage ?? 0;
    const quota = est.quota ?? 0;
    const free = quota > 0 ? Math.max(0, quota - usage) : Infinity;
    if (free < MIN_STORAGE_BYTES) {
      const freeMb = Math.round(free / (1024 * 1024));
      return { id: "storage", level: "block", message: `Only ${freeMb}MB free for recordings. Clear out old captures or free device storage before starting.` };
    }
    return { id: "storage", level: "ok", message: `${Math.round(free / (1024 * 1024))}MB free for recordings.` };
  } catch {
    return { id: "storage", level: "warn", message: "Couldn't estimate storage — proceeding without the check." };
  }
}

async function checkBattery(): Promise<PreflightCheck> {
  type BatteryManager = { level: number; charging: boolean };
  const navWithBattery = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  if (!navWithBattery.getBattery) {
    return { id: "battery", level: "ok", message: "Battery API unavailable on this device." };
  }
  try {
    const b = await navWithBattery.getBattery();
    const pct = Math.round(b.level * 100);
    if (b.charging) return { id: "battery", level: "ok", message: `Battery ${pct}% — charging.` };
    if (b.level < LOW_BATTERY_PCT) {
      return { id: "battery", level: "warn", message: `Battery at ${pct}%. Long hunts may exhaust it — plug in if possible.` };
    }
    return { id: "battery", level: "ok", message: `Battery ${pct}%.` };
  } catch {
    return { id: "battery", level: "ok", message: "Battery status couldn't be read — proceeding." };
  }
}

/**
 * Run all checks in parallel. The overall level is the highest severity of
 * any individual check (block > warn > ok), so the UI can decide whether
 * to surface a blocker or just kick off the session.
 */
export async function runPreflight(): Promise<PreflightReport> {
  const checks = await Promise.all([
    checkCamera(),
    checkMic(),
    checkStorage(),
    checkBattery(),
  ]);
  const overall: PreflightLevel = checks.some((c) => c.level === "block")
    ? "block"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "ok";
  return { overall, checks };
}
