/**
 * One-shot geolocation for marker pinning. Watch is unreliable when the PWA
 * is backgrounded on iOS, so we prefer per-marker captures.
 */

export interface GeoPoint {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
}

export async function getCurrentPoint(timeoutMs = 8000): Promise<GeoPoint | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise<GeoPoint | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          timestamp: pos.timestamp,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          altitude: pos.coords.altitude ?? null,
          heading: pos.coords.heading ?? null,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/**
 * Silent variant — low accuracy, 3 s timeout, accepts up to 60 s stale fix.
 * Does NOT trigger a permission prompt if location hasn't been granted yet
 * (the OS delivers an error instead, which resolves to null here). Use this
 * for background proximity checks where accuracy is not critical and a prompt
 * would surprise the user.
 */
export async function getCurrentPointSilent(): Promise<GeoPoint | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise<GeoPoint | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          timestamp: pos.timestamp,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          altitude: pos.coords.altitude ?? null,
          heading: pos.coords.heading ?? null,
        });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: false, timeout: 3000, maximumAge: 60_000 },
    );
  });
}
