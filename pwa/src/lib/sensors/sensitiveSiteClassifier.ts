/**
 * Sensitive Site Classifier — proximity check against the Colonial Frontier
 * Massacres dataset (Tier 2 #3).
 *
 * Uses a bundled snapshot of documented massacre sites from the Newcastle
 * Colonial Frontier Massacres Map (https://c21ch.newcastle.edu.au/colonialmassacres/).
 * Data is included locally so the check works fully offline.
 *
 * Attribution: Ryan, Lyndall et al. (2017–2024). Colonial Frontier Massacres
 * in Australia 1788–1930. University of Newcastle / ARC Discovery Project.
 * https://c21ch.newcastle.edu.au/colonialmassacres/
 *
 * When the user creates an investigation within `RADIUS_KM` of a documented
 * massacre site, the caller must show a typed-acknowledgement prompt before
 * allowing creation to proceed.
 *
 * The full dataset has 400+ entries; this bundled file contains ~60
 * representative sites. Operators in remote areas may be near sites not yet
 * in this snapshot — the absence of a match is NOT a guarantee.
 */

import SITES_RAW from "./colonialSites.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColonialSite {
  id: string;
  name: string;
  year: number | null;
  state: string;
  lat: number;
  lng: number;
}

export interface SiteMatch {
  site: ColonialSite;
  distanceKm: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Radius (km) within which a site triggers the warning. */
export const SENSITIVE_RADIUS_KM = 5;

const SITES = SITES_RAW as ColonialSite[];

// ---------------------------------------------------------------------------
// Haversine distance
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all documented massacre sites within `radiusKm` of the given
 * coordinates, sorted nearest-first.
 *
 * Returns an empty array when no sites are found or when coordinates are
 * invalid (NaN, out of range).
 */
export function findNearbySites(
  lat: number,
  lng: number,
  radiusKm = SENSITIVE_RADIUS_KM,
): SiteMatch[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];

  const matches: SiteMatch[] = [];
  for (const site of SITES) {
    const d = haversineKm(lat, lng, site.lat, site.lng);
    if (d <= radiusKm) {
      matches.push({ site, distanceKm: d });
    }
  }
  matches.sort((a, b) => a.distanceKm - b.distanceKm);
  return matches;
}

/**
 * Silently request the device's current location (no prompt — only works if
 * the user has previously granted geolocation). Resolves `null` on any error.
 *
 * Timeout is short (3 s) so the new-case form is never blocked waiting for GPS.
 */
export async function getCurrentLocationSilent(): Promise<GeolocationCoordinates | null> {
  if (!navigator.geolocation) return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve(pos.coords);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 3000, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}
