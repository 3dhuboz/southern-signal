/**
 * Civil twilight helper. Returns whether the sun is below 6° at the
 * given lat/lng/time — the standard "civil twilight ended" trigger
 * astronomers use. Below 6° altitude → engage scotopic.
 *
 * Algorithm: NOAA solar-position approximation (good to ~±1 minute,
 * which is fine for "is it dark enough to need red mode"). No deps.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86_400_000);
}

/**
 * Sun altitude in degrees at the given time and location. Negative
 * altitudes mean the sun is below the horizon. Civil twilight = altitude
 * between 0° and -6°; the night portion this app cares about is -6° or
 * lower.
 */
export function sunAltitudeDeg(d: Date, latDeg: number, lngDeg: number): number {
  const n = dayOfYear(d);
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

  // Fractional year (radians).
  const gamma = ((2 * Math.PI) / 365) * (n - 1 + (utcHours - 12) / 24);

  // Equation of time (minutes).
  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination (radians).
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);

  // True solar time (minutes since solar midnight).
  const timeOffset = eqTime + 4 * lngDeg; // minutes
  const tst = utcHours * 60 + timeOffset;
  const haDeg = tst / 4 - 180; // hour angle in degrees
  const ha = haDeg * RAD;

  const lat = latDeg * RAD;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

/** True if the sun is at or below -6°: civil twilight has ended. */
export function isPastCivilTwilight(d: Date, latDeg: number, lngDeg: number): boolean {
  return sunAltitudeDeg(d, latDeg, lngDeg) <= -6;
}
