/**
 * CommunityMap — opt-in public map of haunt sites pinned by Southern
 * Signal operators.
 *
 * Privacy posture:
 *   - The map endpoint coarsens coordinates to ~100 m server-side.
 *   - Publishing is per-case explicit; there's no auto-share.
 *   - Pins are tied to a per-device anonymous UUID (localStorage). Lose
 *     your device, lose the ability to delete your own pins — by design.
 *   - Culturally-sensitive cases never publish; the action is hidden by
 *     the global flag and the per-case flag.
 *
 * Rendering: Leaflet via CDN (see lib/community/leafletLoader.ts). Pins
 * are colour-coded by the case's final posterior so the map doubles as
 * a leaderboard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listInvestigations } from "../lib/db/repo";
import type { Investigation } from "../lib/db/schema";
import { deleteCommunityPin, listCommunityPins, publishCommunityPin, searchAreaIncidents, type AreaIncident, type CommunityPin } from "../lib/community/client";
import { loadLeaflet, type LeafletMap, type LeafletMarker } from "../lib/community/leafletLoader";
import { getCurrentPoint } from "../lib/sensors/geolocation";
import { usePreferences } from "../lib/preferences";
import s from "./View.module.css";
import m from "./CommunityMap.module.css";

interface SessionSummaryEntry {
  investigation: Investigation;
  peakPosterior?: number;
}

function describeBand(posterior: number | null): { label: string; key: string } {
  if (posterior == null) return { label: "Unknown", key: "unknown" };
  if (posterior < 0.15) return { label: "Calm", key: "calm" };
  if (posterior < 0.35) return { label: "Light", key: "light" };
  if (posterior < 0.60) return { label: "Possible", key: "possible" };
  if (posterior < 0.80) return { label: "Notable", key: "notable" };
  return { label: "Strong", key: "strong" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pinPopupHtml(pin: CommunityPin): string {
  const band = describeBand(pin.posterior);
  const date = new Date(pin.created_at).toLocaleDateString();
  const noteHtml = pin.note ? `<p class="${escapeHtml(m.popupNote)}">${escapeHtml(pin.note)}</p>` : "";
  const postPct = pin.posterior == null ? "—" : `${Math.round(pin.posterior * 100)}%`;
  return `
    <div class="${escapeHtml(m.popup)}">
      <div class="${escapeHtml(m.popupTitle)}">${escapeHtml(pin.venue_name)}</div>
      <div class="${escapeHtml(m.popupMeta)}">
        <span class="${escapeHtml(m.popupBand)} ${escapeHtml(m[`band_${band.key}`] ?? "")}">${escapeHtml(band.label)} · ${postPct}</span>
        <span class="${escapeHtml(m.popupDate)}">${escapeHtml(date)}</span>
      </div>
      ${noteHtml}
      ${pin.is_yours ? `<button type="button" data-pin-id="${escapeHtml(pin.id)}" class="${escapeHtml(m.popupDelete)}">Delete (yours)</button>` : ""}
    </div>
  `;
}

/**
 * Geocode a place name via Nominatim (OSM). Returns the first hit's
 * lat/lon, or null when nothing matches. Public free endpoint — no key,
 * no auth. Used for the venue-search shortcut so an operator can jump
 * the map to a suburb / venue without knowing the lat/lon.
 */
async function geocodeVenue(q: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=0`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const arr = await res.json() as Array<{ lat: string; lon: string; display_name: string }>;
  if (arr.length === 0) return null;
  const lat = parseFloat(arr[0].lat);
  const lon = parseFloat(arr[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: arr[0].display_name };
}

function incidentPopupHtml(inc: AreaIncident): string {
  const isFolklore = inc.category === "folklore";
  const severityKey = inc.severity || "unknown";
  const yearStr = inc.year ? String(inc.year) : (isFolklore ? "undated" : "—");
  const sourcesHtml = inc.sources.length
    ? `<ul class="${escapeHtml(m.popupSources)}">${inc.sources.slice(0, 4).map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a></li>`).join("")}</ul>`
    : `<p class="${escapeHtml(m.popupNote)}"><em>No citations returned by the model — treat with skepticism.</em></p>`;
  const qualityLabel = inc.source_quality === "primary"
    ? "PRIMARY SOURCE"
    : inc.source_quality === "anecdotal"
    ? "ANECDOTAL · VERIFY"
    : "SECONDARY";
  const qualityWarning = inc.source_quality !== "primary"
    ? `<p class="${escapeHtml(m.popupQualityWarn)}">⚠ ${escapeHtml(qualityLabel === "ANECDOTAL · VERIFY" ? "Anecdotal — confirm against a primary source before quoting on camera." : "Secondary source — trace to a primary citation before reporting.")}</p>`
    : "";
  // Folklore-specific reminder: even primary-sourced folklore is still
  // a claim, not a confirmed event. Operators on camera need to phrase
  // it as "the newspaper reported a haunting" not "there was a haunting".
  const folkloreReminder = isFolklore
    ? `<p class="${escapeHtml(m.popupFolkloreNote)}">👻 Folklore / local legend — phrase as "the source reports…", not as confirmed event.</p>`
    : "";
  const categoryBadge = isFolklore
    ? `<span class="${escapeHtml(m.popupBand)} ${escapeHtml(m.category_folklore ?? "")}">FOLKLORE · ${escapeHtml(yearStr)}</span>`
    : `<span class="${escapeHtml(m.popupBand)} ${escapeHtml(m[`severity_${severityKey}`] ?? "")}">${escapeHtml(severityKey.toUpperCase())} · ${escapeHtml(yearStr)}</span>`;
  return `
    <div class="${escapeHtml(m.popup)}">
      <div class="${escapeHtml(m.popupTitle)}">${escapeHtml(inc.title)}</div>
      <div class="${escapeHtml(m.popupMeta)}">
        ${categoryBadge}
        <span class="${escapeHtml(m.popupBand)} ${escapeHtml(m[`quality_${inc.source_quality}`] ?? "")}">${escapeHtml(qualityLabel)}</span>
      </div>
      <p class="${escapeHtml(m.popupNote)}">${escapeHtml(inc.body)}</p>
      ${sourcesHtml}
      ${folkloreReminder}
      ${qualityWarning}
    </div>
  `;
}

export function CommunityMap() {
  const [prefs] = usePreferences();
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<LeafletMarker[]>([]);
  const incidentMarkersRef = useRef<LeafletMarker[]>([]);
  const [loading, setLoading] = useState(true);
  // loadError = Leaflet itself failed to load — the whole map view is unusable.
  // This is the only failure that disables the incident-search button.
  const [loadError, setLoadError] = useState<string | null>(null);
  // pinsError = /api/community/sites GET failed (e.g. COMMUNITY_DB not bound
  // or transient network blip). Non-fatal: the map and the incident-search
  // feature still work; we just can't show the community pin layer. Surfaced
  // as a soft banner rather than a blocking overlay.
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [pins, setPins] = useState<CommunityPin[]>([]);
  const [incidents, setIncidents] = useState<AreaIncident[]>([]);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [incidentMeta, setIncidentMeta] = useState<{ count: number; cached: boolean; cacheAgeSeconds: number; notes: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [recentCases, setRecentCases] = useState<SessionSummaryEntry[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [pendingPosteriorStr, setPendingPosteriorStr] = useState("");
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsPoint, setGpsPoint] = useState<{ lat: number; lon: number } | null>(null);
  // Map control bar — venue search + jump-to-me. Errors share one banner.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [findMeBusy, setFindMeBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  // Filter chips — default all-on so the existing UX is preserved.
  const [showCommunity, setShowCommunity] = useState(true);
  const [showIncidents, setShowIncidents] = useState(true);
  const [showFolklore, setShowFolklore] = useState(true);

  // Load Leaflet + create map on mount.
  useEffect(() => {
    let cancelled = false;
    let cleanupRef: (() => void) | null = null;
    void (async () => {
      try {
        const L = await loadLeaflet();
        if (cancelled || !mapEl.current) return;
        const map = L.map(mapEl.current, { worldCopyJump: true }).setView([-25.3, 133.8], 4); // AU-centred default
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 19,
        }).addTo(map);
        mapRef.current = map;

        // Try to centre on user GPS — opportunistic, no nag.
        void (async () => {
          const pt = await getCurrentPoint(6000);
          if (pt && mapRef.current) {
            mapRef.current.setView([pt.latitude, pt.longitude], 11);
          }
        })();

        // Popup delete buttons piggyback on the document click — Leaflet
        // popups render outside our React tree.
        const onDocClick = (e: MouseEvent) => {
          const t = e.target as HTMLElement | null;
          if (!t) return;
          const id = t.getAttribute("data-pin-id");
          if (!id) return;
          void (async () => {
            const ok = window.confirm("Delete this pin from the community map?");
            if (!ok) return;
            const res = await deleteCommunityPin(id);
            if ("ok" in res) {
              setPins((cur) => cur.filter((p) => p.id !== id));
            } else {
              window.alert(`Delete failed: ${res.error}`);
            }
          })();
        };
        document.addEventListener("click", onDocClick);
        cleanupRef = () => document.removeEventListener("click", onDocClick);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message || "Failed to load map library.");
      }
    })();
    return () => {
      cancelled = true;
      if (cleanupRef) cleanupRef();
      markersRef.current.forEach((mk) => mk.remove());
      markersRef.current = [];
      incidentMarkersRef.current.forEach((mk) => mk.remove());
      incidentMarkersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Pull pins after map is ready. Failure here is NON-fatal — the map
  // itself still renders, the incident-search feature still works, only
  // the community-pin layer is missing. Set pinsError so the UI can
  // surface a soft banner instead of disabling everything.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setPinsError(null);
      const res = await listCommunityPins({ limit: 500 });
      if ("error" in res) {
        setPinsError(res.error);
      } else {
        setPins(res.pins);
      }
      setLoading(false);
    })();
  }, []);

  // Re-render community pins when they change OR the filter toggle flips.
  // The cleanup runs first regardless of `showCommunity` so toggling off
  // tears down existing markers; toggling on adds them back.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof window.L === "undefined") return;
    const L = window.L;
    markersRef.current.forEach((mk) => mk.remove());
    markersRef.current = [];
    if (!showCommunity) return;
    for (const pin of pins) {
      const band = describeBand(pin.posterior);
      const icon = L.divIcon({
        className: `${m.markerIcon} ${m[`marker_${band.key}`] ?? ""}`,
        html: `<span class="${escapeHtml(m.markerDot)}"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = L.marker([pin.lat, pin.lon], { icon }).addTo(map) as LeafletMarker;
      marker.bindPopup(pinPopupHtml(pin), { className: m.popupWrap });
      markersRef.current.push(marker);
    }
  }, [pins, showCommunity]);

  // Re-render AI-surfaced incident markers when they change OR the
  // category filters flip. Two marker styles: severity-coloured diamond
  // for real events, violet ringed circle for folklore — distinct shapes
  // so a reviewer can tell at a glance which findings are documented
  // events vs local legends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof window.L === "undefined") return;
    const L = window.L;
    incidentMarkersRef.current.forEach((mk) => mk.remove());
    incidentMarkersRef.current = [];
    for (const inc of incidents) {
      const isFolklore = inc.category === "folklore";
      if (isFolklore && !showFolklore) continue;
      if (!isFolklore && !showIncidents) continue;
      const icon = isFolklore
        ? L.divIcon({
            className: `${m.incidentIcon} ${m.folkloreIcon}`,
            html: `<span class="${escapeHtml(m.folkloreGlyph)}"></span>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          })
        : L.divIcon({
            className: `${m.incidentIcon} ${m[`severity_${inc.severity}`] ?? ""}`,
            html: `<span class="${escapeHtml(m.incidentDiamond)}"></span>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });
      const marker = L.marker([inc.lat, inc.lon], { icon }).addTo(map) as LeafletMarker;
      marker.bindPopup(incidentPopupHtml(inc), { className: m.popupWrap });
      incidentMarkersRef.current.push(marker);
    }
  }, [incidents, showIncidents, showFolklore]);

  // Venue search via Nominatim. Pans + zooms the map to the first hit.
  // Empty query is a no-op; errors land in the shared control banner.
  const handleVenueSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchBusy(true);
    setControlError(null);
    setControlNotice(null);
    try {
      const hit = await geocodeVenue(q);
      if (!hit) {
        setControlError(`No match for "${q}".`);
        return;
      }
      mapRef.current?.setView([hit.lat, hit.lon], 14);
      setControlNotice(hit.label);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "Geocoder failed.");
    } finally {
      setSearchBusy(false);
    }
  }, [searchQuery]);

  // Jump the map to the operator's current GPS fix. Reuses
  // getCurrentPoint which is already wired for the publish flow.
  const handleFindMe = useCallback(async () => {
    setFindMeBusy(true);
    setControlError(null);
    setControlNotice(null);
    const pt = await getCurrentPoint(8000);
    setFindMeBusy(false);
    if (!pt) {
      setControlError("No GPS fix — allow location and try again.");
      return;
    }
    mapRef.current?.setView([pt.latitude, pt.longitude], 14);
    setControlNotice(`Centred on ${pt.latitude.toFixed(3)}, ${pt.longitude.toFixed(3)}`);
  }, []);

  // Trigger an AI search for documented incidents inside the current
  // visible bounds. Cached server-side keyed by a 0.1°-rounded cell
  // so two operators panning the same region share the cache.
  const handleSearchArea = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    setIncidentBusy(true);
    setIncidentError(null);
    setIncidentMeta(null);
    const b = map.getBounds();
    const bbox = {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast(),
    };
    const res = await searchAreaIncidents(bbox, "AU");
    setIncidentBusy(false);
    if ("error" in res) {
      setIncidentError(res.error);
      return;
    }
    setIncidents(res.incidents);
    setIncidentMeta({
      count: res.incidents.length,
      cached: res.cached,
      cacheAgeSeconds: res.cache_age_seconds,
      notes: res.notes,
    });
  }, []);

  // Pull recent cases for the publish picker.
  useEffect(() => {
    void (async () => {
      try {
        const all = await listInvestigations();
        // Last 12, most recent first.
        const recent = all
          .filter((inv) => !!inv.location_name || !!inv.title)
          .slice(0, 12)
          .map((inv) => ({ investigation: inv }));
        setRecentCases(recent);
      } catch {
        setRecentCases([]);
      }
    })();
  }, []);

  const openShare = useCallback(async () => {
    setShareOpen(true);
    setShareError(null);
    setShareSuccess(null);
    setGpsPoint(null);
    setGpsBusy(true);
    const pt = await getCurrentPoint(8000);
    setGpsBusy(false);
    if (pt) setGpsPoint({ lat: pt.latitude, lon: pt.longitude });
  }, []);

  const handlePublish = useCallback(async () => {
    setShareError(null);
    setShareSuccess(null);
    const inv = recentCases.find((r) => r.investigation.id === selectedCaseId)?.investigation;
    if (!inv) { setShareError("Pick a case to publish."); return; }
    if (!gpsPoint) { setShareError("GPS fix required. Allow location and try again."); return; }
    let posterior: number | null = null;
    if (pendingPosteriorStr.trim()) {
      const p = parseFloat(pendingPosteriorStr.trim());
      if (!Number.isFinite(p) || p < 0 || p > 1) { setShareError("Posterior must be a number between 0 and 1."); return; }
      posterior = p;
    }
    const note = pendingNote.trim() || null;
    const venueName = inv.location_name?.trim() || inv.title.trim();
    setShareBusy(true);
    const res = await publishCommunityPin({
      venue_name: venueName,
      lat: gpsPoint.lat,
      lon: gpsPoint.lon,
      region: "AU",
      posterior,
      note,
    });
    setShareBusy(false);
    if ("error" in res) {
      setShareError(res.error);
      return;
    }
    setShareSuccess(`Pinned · ${venueName} at ${res.lat.toFixed(3)}, ${res.lon.toFixed(3)}`);
    // Refresh pins so the new one appears.
    const list = await listCommunityPins({ limit: 500 });
    if (!("error" in list)) setPins(list.pins);
  }, [recentCases, selectedCaseId, gpsPoint, pendingNote, pendingPosteriorStr]);

  const stats = useMemo(() => {
    const total = pins.length;
    const strong = pins.filter((p) => (p.posterior ?? 0) >= 0.6).length;
    const yours = pins.filter((p) => p.is_yours).length;
    return { total, strong, yours };
  }, [pins]);

  const incidentCounts = useMemo(() => {
    const inc = incidents.filter((i) => i.category !== "folklore").length;
    const fl = incidents.filter((i) => i.category === "folklore").length;
    return { incidents: inc, folklore: fl };
  }, [incidents]);

  const sensitive = prefs.globalCulturalSensitivityFlag;
  const canShare = !sensitive && prefs.community.enabled;

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Community map · Operator network</span>
        <h1 className={s.title}>Pinned haunts</h1>
        <p className={s.lede}>
          Opt-in public map of sites Southern Signal operators have flagged.
          Coordinates are coarsened server-side to ~100 m. No accounts —
          your device owns its pins via a local anonymous id, so deleting
          requires this device.
        </p>
      </div>

      <section className={m.statRow}>
        <div className={m.statCard}>
          <span className={m.statLabel}>Total pinned</span>
          <span className={m.statValue}>{stats.total}</span>
        </div>
        <div className={m.statCard}>
          <span className={m.statLabel}>Strong (posterior ≥ 60%)</span>
          <span className={m.statValue}>{stats.strong}</span>
        </div>
        <div className={m.statCard}>
          <span className={m.statLabel}>Yours on this device</span>
          <span className={m.statValue}>{stats.yours}</span>
        </div>
        <div className={m.statCard}>
          <span className={m.statLabel}>Incidents · Folklore</span>
          <span className={m.statValue}>
            {incidents.filter((i) => i.category === "incident").length}
            <span className={m.statSep}> · </span>
            {incidents.filter((i) => i.category === "folklore").length}
          </span>
        </div>
      </section>

      <section className={m.controlBar}>
        <form
          className={m.controlSearchForm}
          onSubmit={(e) => { e.preventDefault(); void handleVenueSearch(); }}
        >
          <input
            type="search"
            className={m.controlSearchInput}
            placeholder="Jump to a suburb, town, or venue…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={!!loadError}
            aria-label="Search a place to centre the map"
          />
          <button
            type="submit"
            className={m.controlBtn}
            disabled={!!loadError || searchBusy || !searchQuery.trim()}
          >
            {searchBusy ? "Searching…" : "Go"}
          </button>
        </form>
        <button
          type="button"
          className={m.controlBtn}
          onClick={handleFindMe}
          disabled={!!loadError || findMeBusy}
          aria-label="Centre map on my current location"
        >
          {findMeBusy ? "Locating…" : "📍 Find me"}
        </button>
        <div className={m.filterChipRow} role="group" aria-label="Map layer filters">
          <button
            type="button"
            className={m.filterChip}
            data-active={showCommunity}
            onClick={() => setShowCommunity((v) => !v)}
            aria-pressed={showCommunity}
          >
            <span className={m.filterChipGlyph} aria-hidden="true">●</span>
            Community pins ({stats.total})
          </button>
          <button
            type="button"
            className={m.filterChip}
            data-active={showIncidents}
            onClick={() => setShowIncidents((v) => !v)}
            aria-pressed={showIncidents}
            disabled={incidentCounts.incidents === 0}
          >
            <span className={m.filterChipGlyph} aria-hidden="true">◆</span>
            Incidents ({incidentCounts.incidents})
          </button>
          <button
            type="button"
            className={m.filterChip}
            data-active={showFolklore}
            onClick={() => setShowFolklore((v) => !v)}
            aria-pressed={showFolklore}
            disabled={incidentCounts.folklore === 0}
          >
            <span className={m.filterChipGlyph} aria-hidden="true">👻</span>
            Folklore ({incidentCounts.folklore})
          </button>
        </div>
        {(controlError || controlNotice) && (
          <p className={controlError ? m.controlError : m.controlNotice}>
            {controlError ?? controlNotice}
          </p>
        )}
      </section>

      <section className={m.incidentBar}>
        <div className={m.incidentBarText}>
          <strong>AI-surfaced incidents + folklore:</strong>{" "}
          Pan / zoom to the area you care about, then tap to search Trove
          digitised newspapers, court records, ABC News, regional papers,
          and heritage registers. Two categories surface inside the
          visible bounds: documented incidents (orange/red diamond) and
          local folklore / hauntings (violet circle) — every finding ships
          with citation links. Results cached server-side (~10 km cells,
          30-day TTL) so repeat views are free.
        </div>
        <button
          type="button"
          className={`btn btn-primary ${m.incidentSearchBtn}`}
          onClick={handleSearchArea}
          disabled={incidentBusy || !!loadError}
        >
          {incidentBusy ? "Searching archives…" : "Search this area for incidents"}
        </button>
        {incidentMeta && (
          <p className={m.incidentMeta}>
            {incidentMeta.count} incident{incidentMeta.count === 1 ? "" : "s"} plotted ·{" "}
            {incidentMeta.cached ? `cached ${Math.round(incidentMeta.cacheAgeSeconds / 3600)}h ago` : "fresh from Sonar"}
            {incidentMeta.notes ? ` · ${incidentMeta.notes}` : ""}
          </p>
        )}
        {incidentError && <p className={m.incidentError}>{incidentError}</p>}
      </section>

      <div className={m.mapShell}>
        <div ref={mapEl} className={m.mapEl} aria-label="World map of community pins" />
        {loading && !loadError && (
          <div className={m.mapOverlay}>Loading pins…</div>
        )}
        {loadError && (
          <div className={`${m.mapOverlay} ${m.mapOverlayErr}`}>
            Map library failed to load: {loadError}
            <br />
            <span className={m.mapOverlayHint}>
              The Leaflet CDN may be unreachable on this network. Check connectivity and reload.
            </span>
          </div>
        )}
      </div>

      {pinsError && (
        <p className={m.pinsErrorBanner}>
          Community pin layer unavailable: {pinsError}
          <br />
          <span className={m.mapOverlayHint}>
            Doesn't affect incident search — that endpoint is independent. To enable pinning, bind <code>COMMUNITY_DB</code> (D1) in Pages settings.
          </span>
        </p>
      )}

      {canShare ? (
        <section className={m.shareSection}>
          {!shareOpen && (
            <button type="button" className={`btn btn-primary ${m.shareBtn}`} onClick={openShare}>
              Share a case to the community map
            </button>
          )}
          {shareOpen && (
            <div className={m.sharePanel}>
              <header className={m.shareHeader}>
                <h2 className={m.shareTitle}>Publish a pin</h2>
                <button type="button" className={m.shareClose} onClick={() => setShareOpen(false)}>Close</button>
              </header>
              <p className={m.shareLede}>
                Pick a case, confirm the GPS fix, and (optionally) tag the
                final posterior + a short note. Your device's anonymous id
                stays with the pin so you can delete it later.
              </p>

              <label className={m.shareField}>
                <span className={m.shareFieldLabel}>Case</span>
                <select
                  value={selectedCaseId ?? ""}
                  onChange={(e) => setSelectedCaseId(e.target.value || null)}
                  className={m.shareInput}
                >
                  <option value="">— pick a case —</option>
                  {recentCases.map((c) => (
                    <option key={c.investigation.id} value={c.investigation.id}>
                      {c.investigation.location_name?.trim() || c.investigation.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className={m.shareField}>
                <span className={m.shareFieldLabel}>Final posterior (optional, 0–1)</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={pendingPosteriorStr}
                  onChange={(e) => setPendingPosteriorStr(e.target.value)}
                  placeholder="e.g. 0.42"
                  className={m.shareInput}
                />
              </label>

              <label className={m.shareField}>
                <span className={m.shareFieldLabel}>Note (optional, ≤ 280 chars)</span>
                <textarea
                  value={pendingNote}
                  onChange={(e) => setPendingNote(e.target.value.slice(0, 280))}
                  rows={3}
                  className={m.shareTextarea}
                  placeholder="What stood out? Stay factual — this is public."
                />
              </label>

              <div className={m.shareGps}>
                {gpsBusy ? "Acquiring GPS fix…" : gpsPoint ? `GPS · ${gpsPoint.lat.toFixed(4)}, ${gpsPoint.lon.toFixed(4)} (coarsened on publish)` : "GPS unavailable — allow location and retry."}
                <button
                  type="button"
                  className={m.shareGpsBtn}
                  onClick={async () => { setGpsBusy(true); const pt = await getCurrentPoint(8000); setGpsBusy(false); setGpsPoint(pt ? { lat: pt.latitude, lon: pt.longitude } : null); }}
                  disabled={gpsBusy}
                >
                  Retry GPS
                </button>
              </div>

              <button
                type="button"
                className={`btn btn-primary ${m.sharePublishBtn}`}
                disabled={shareBusy || !selectedCaseId || !gpsPoint}
                onClick={handlePublish}
              >
                {shareBusy ? "Publishing…" : "Publish pin"}
              </button>

              {shareError && <p className={m.shareError}>{shareError}</p>}
              {shareSuccess && <p className={m.shareSuccess}>{shareSuccess}</p>}
            </div>
          )}
        </section>
      ) : (
        <section className={m.shareDisabled}>
          {sensitive
            ? "Publishing is hard-blocked while \"Treat all sites as culturally sensitive\" is on. Untoggle in Setup to publish."
            : "Community map disabled in Setup."}
        </section>
      )}

      <p className={m.privacyNote}>
        Pins are public. Don't pin sites whose location is restricted (sacred,
        private property without consent, working hospitals, etc.). Coords
        are coarsened to ~100 m but the venue name and your note are stored
        verbatim — review what you write before publishing.
      </p>
    </section>
  );
}
