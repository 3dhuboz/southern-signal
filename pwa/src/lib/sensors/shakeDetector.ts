/**
 * ShakeDetector — hands-free marker trigger for field investigators.
 *
 * Listens for DeviceMotionEvent and fires onShake() when two acceleration
 * spikes above `threshold` m/s² occur within `windowMs` of each other.
 * After firing, ignores events for 2 seconds to prevent double-firing.
 *
 * iOS 13+ requires DeviceMotionEvent.requestPermission() called from a user
 * gesture before any devicemotion events are delivered. start() handles this
 * check: if permission has not been granted, start() is a no-op and you
 * should call requestPermission() from a button tap instead.
 */

export interface ShakeDetectorOptions {
  /** Acceleration magnitude threshold in m/s². Default: 15. */
  threshold?: number;
  /** Window within which two threshold crossings must occur to count as a shake. Default: 1000 ms. */
  windowMs?: number;
  /** Callback fired when a shake is detected. */
  onShake?: () => void;
}

interface AppleMotionEvent {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/** Result of a permission request. "not-needed" on Android/desktop. */
export type MotionPermissionResult = "granted" | "denied" | "not-needed" | "unavailable";

/**
 * Request DeviceMotion permission without needing a ShakeDetector instance.
 * Must be called from a user-gesture handler on iOS 13+.
 */
export async function requestMotionPermission(): Promise<MotionPermissionResult> {
  if (typeof DeviceMotionEvent === "undefined") return "unavailable";
  const M = DeviceMotionEvent as unknown as AppleMotionEvent;
  if (typeof M.requestPermission !== "function") return "not-needed";
  try {
    const result = await M.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export class ShakeDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly onShake: (() => void) | undefined;

  private lastSpikeTs: number | null = null;
  private debounceUntil: number = 0;
  private listening: boolean = false;
  private permissionGranted: boolean = false;

  private readonly handler: (event: DeviceMotionEvent) => void;

  constructor(options?: ShakeDetectorOptions) {
    this.threshold = options?.threshold ?? 15;
    this.windowMs = options?.windowMs ?? 1000;
    this.onShake = options?.onShake;

    this.handler = (event: DeviceMotionEvent) => {
      // Prefer acceleration (gravity-removed); fall back to accelerationIncludingGravity.
      const acc = event.acceleration ?? event.accelerationIncludingGravity;
      if (!acc || acc.x == null || acc.y == null || acc.z == null) return;

      const magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
      if (magnitude < this.threshold) return;

      const now = Date.now();

      // Within debounce window — ignore.
      if (now < this.debounceUntil) return;

      if (this.lastSpikeTs !== null && now - this.lastSpikeTs <= this.windowMs) {
        // Second spike within window — fire!
        this.lastSpikeTs = null;
        this.debounceUntil = now + 2000;
        this.onShake?.();
      } else {
        // First spike — record timestamp and wait for second.
        this.lastSpikeTs = now;
      }
    };
  }

  /** Request iOS DeviceMotion permission. Must be called from a user gesture. */
  async requestPermission(): Promise<MotionPermissionResult> {
    if (typeof DeviceMotionEvent === "undefined") return "unavailable";
    const M = DeviceMotionEvent as unknown as AppleMotionEvent;
    if (typeof M.requestPermission !== "function") {
      // Android / desktop — no permission gate.
      this.permissionGranted = true;
      return "not-needed";
    }
    try {
      const result = await M.requestPermission();
      this.permissionGranted = result === "granted";
      return result === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }

  /** Attach the devicemotion listener. No-op if DeviceMotion is unavailable or permission not yet granted on iOS. */
  start(): void {
    if (this.listening) return;
    if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") return;

    // If the platform requires permission and it has not been granted, do nothing.
    const M = DeviceMotionEvent as unknown as AppleMotionEvent;
    if (typeof M.requestPermission === "function" && !this.permissionGranted) return;

    this.listening = true;
    window.addEventListener("devicemotion", this.handler);
  }

  /** Detach the devicemotion listener. */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("devicemotion", this.handler);
  }

  /** Whether the detector is currently listening. */
  get isListening(): boolean {
    return this.listening;
  }
}
