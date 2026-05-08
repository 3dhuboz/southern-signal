/**
 * iOS 13+ requires explicit permission for DeviceMotion / DeviceOrientation,
 * granted via a Promise returned from requestPermission() — and the call
 * MUST happen inside a user gesture (click/tap handler).
 *
 * Android Chrome does not gate these APIs.
 */

interface AppleMotionEvent {
  requestPermission?: () => Promise<"granted" | "denied">;
}

export async function requestMotionPermission(): Promise<"granted" | "denied" | "not-needed"> {
  const M = (typeof DeviceMotionEvent !== "undefined" ? DeviceMotionEvent : null) as unknown as AppleMotionEvent | null;
  if (!M || typeof M.requestPermission !== "function") return "not-needed";
  try {
    const result = await M.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export async function requestOrientationPermission(): Promise<"granted" | "denied" | "not-needed"> {
  const O = (typeof DeviceOrientationEvent !== "undefined" ? DeviceOrientationEvent : null) as unknown as AppleMotionEvent | null;
  if (!O || typeof O.requestPermission !== "function") return "not-needed";
  try {
    const result = await O.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export async function requestSensorPermissionsForUserGesture(): Promise<{
  motion: "granted" | "denied" | "not-needed";
  orientation: "granted" | "denied" | "not-needed";
}> {
  const [motion, orientation] = await Promise.all([
    requestMotionPermission(),
    requestOrientationPermission(),
  ]);
  return { motion, orientation };
}
