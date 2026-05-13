/**
 * Tiny client for /api/community/sites.
 *
 * Keeps the network shape in one place so the map view and the publish
 * action don't drift. Everything is opt-in — calls fail soft (the map
 * shows an error banner; publish surfaces a toast-like message).
 */

import { getOrCreateAnonymousCommunityId } from "../preferences";

export interface CommunityPin {
  id: string;
  venue_name: string;
  lat: number;
  lon: number;
  region: string | null;
  posterior: number | null;
  note: string | null;
  created_at: string;
  is_yours: boolean;
}

export interface PublishInput {
  venue_name: string;
  lat: number;
  lon: number;
  region?: "AU" | "GLOBAL" | null;
  posterior?: number | null;
  note?: string | null;
  /** Optional — pass to replace an existing pin this device owns. */
  id?: string;
}

export interface ListOptions {
  bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  limit?: number;
}

export async function listCommunityPins(opts: ListOptions = {}): Promise<{ pins: CommunityPin[] } | { error: string; status: number }> {
  const params = new URLSearchParams();
  const anonId = getOrCreateAnonymousCommunityId();
  params.set("anonymous_id", anonId);
  if (opts.bbox) {
    const b = opts.bbox;
    params.set("bbox", `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`);
  }
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`/api/community/sites?${params.toString()}`, { method: "GET" });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json() as { error?: string }).error ?? ""; } catch { /* non-JSON */ }
    return { error: detail || `HTTP ${res.status}`, status: res.status };
  }
  return res.json() as Promise<{ pins: CommunityPin[] }>;
}

export async function publishCommunityPin(input: PublishInput): Promise<{ ok: true; id: string; lat: number; lon: number } | { error: string; status: number }> {
  const anonId = getOrCreateAnonymousCommunityId();
  const body = {
    anonymous_id: anonId,
    venue_name: input.venue_name,
    lat: input.lat,
    lon: input.lon,
    region: input.region ?? null,
    posterior: input.posterior ?? null,
    note: input.note ?? null,
    id: input.id,
  };
  const res = await fetch("/api/community/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json() as { error?: string }).error ?? ""; } catch { /* non-JSON */ }
    return { error: detail || `HTTP ${res.status}`, status: res.status };
  }
  return res.json() as Promise<{ ok: true; id: string; lat: number; lon: number }>;
}

// ---------------------- AI-surfaced area incidents ----------------------

export interface AreaIncidentSource { label: string; url: string }
export type AreaIncidentSourceQuality = "primary" | "secondary" | "anecdotal";

export interface AreaIncident {
  title: string;
  body: string;
  severity: "fatal" | "serious" | "minor" | "unknown";
  /** Citation tier — see server schema. Defaults to "secondary" if the
   *  model didn't say (the validator fills it in). */
  source_quality: AreaIncidentSourceQuality;
  year: number | null;
  lat: number;
  lon: number;
  sources: AreaIncidentSource[];
}

export interface AreaIncidentResponse {
  incidents: AreaIncident[];
  search_terms_used: string[];
  notes: string;
  model: string;
  cached: boolean;
  cache_age_seconds: number;
  cell_key: string;
}

export async function searchAreaIncidents(bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }, region: "AU" | "GLOBAL" = "AU"): Promise<AreaIncidentResponse | { error: string; status: number }> {
  const res = await fetch("/api/community/incidents-in-area", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox, region }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json() as { error?: string }).error ?? ""; } catch { /* non-JSON */ }
    return { error: detail || `HTTP ${res.status}`, status: res.status };
  }
  return res.json() as Promise<AreaIncidentResponse>;
}

export async function deleteCommunityPin(id: string): Promise<{ ok: true } | { error: string; status: number }> {
  const anonId = getOrCreateAnonymousCommunityId();
  const res = await fetch("/api/community/sites", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, anonymous_id: anonId }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json() as { error?: string }).error ?? ""; } catch { /* non-JSON */ }
    return { error: detail || `HTTP ${res.status}`, status: res.status };
  }
  return res.json() as Promise<{ ok: true }>;
}
