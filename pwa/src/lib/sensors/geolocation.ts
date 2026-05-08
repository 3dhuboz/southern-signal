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
