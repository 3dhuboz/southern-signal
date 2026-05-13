/**
 * Lazy CDN loader for Leaflet 1.9.x. Loaded once per page, cached.
 *
 * We don't bundle Leaflet because:
 *   1. The Community Map is a secondary route — bundling it would tax
 *      every cold load even for operators who never touch the map.
 *   2. CDN-hosted Leaflet (unpkg) is already heavily cached on most
 *      networks, so the marginal cost is near-zero for repeat visitors.
 *
 * The PWA service worker is configured network-first for HTML, stale-
 * while-revalidate for hashed assets — neither rule fights this loader
 * because Leaflet is loaded by URL via <script> insertion, not fetched.
 */

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
// SRI hashes computed from the actual unpkg files (sha512). Recompute
// with: `curl https://unpkg.com/leaflet@1.9.4/dist/leaflet.js | openssl
// dgst -sha512 -binary | openssl base64 -A` if you bump the version.
const LEAFLET_INTEGRITY_JS = "sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==";
const LEAFLET_INTEGRITY_CSS = "sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w==";

interface LeafletGlobal {
  map(el: HTMLElement, options?: object): LeafletMap;
  tileLayer(url: string, options?: object): LeafletLayer;
  marker(latlng: [number, number], options?: object): LeafletMarker;
  divIcon(options: { className?: string; html?: string; iconSize?: [number, number]; iconAnchor?: [number, number] }): LeafletIcon;
  latLngBounds(corners: Array<[number, number]>): LeafletBounds;
}

export interface LeafletMap {
  setView(latlng: [number, number], zoom: number): LeafletMap;
  fitBounds(bounds: LeafletBounds, options?: object): LeafletMap;
  on(event: string, handler: (...args: unknown[]) => void): LeafletMap;
  off(event: string, handler?: (...args: unknown[]) => void): LeafletMap;
  getBounds(): { getSouth(): number; getWest(): number; getNorth(): number; getEast(): number };
  removeLayer(layer: LeafletLayer): LeafletMap;
  remove(): void;
}

export interface LeafletLayer {
  addTo(map: LeafletMap): LeafletLayer;
  remove(): void;
}

export interface LeafletMarker extends LeafletLayer {
  bindPopup(html: string | HTMLElement, options?: object): LeafletMarker;
  setIcon(icon: LeafletIcon): LeafletMarker;
  openPopup(): LeafletMarker;
  on(event: string, handler: (...args: unknown[]) => void): LeafletMarker;
}

export interface LeafletIcon { /* opaque */ }
export interface LeafletBounds { /* opaque */ }

declare global {
  interface Window {
    L?: LeafletGlobal;
  }
}

let loadPromise: Promise<LeafletGlobal> | null = null;

export function loadLeaflet(): Promise<LeafletGlobal> {
  if (typeof window !== "undefined" && window.L) return Promise.resolve(window.L);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<LeafletGlobal>((resolve, reject) => {
    // CSS first (no race — link load doesn't block JS in modern browsers).
    if (!document.querySelector(`link[data-leaflet]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      link.integrity = LEAFLET_INTEGRITY_CSS;
      link.crossOrigin = "anonymous";
      link.dataset.leaflet = "1";
      document.head.appendChild(link);
    }
    if (!document.querySelector(`script[data-leaflet]`)) {
      const script = document.createElement("script");
      script.src = LEAFLET_JS;
      script.integrity = LEAFLET_INTEGRITY_JS;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.dataset.leaflet = "1";
      script.onload = () => {
        if (window.L) resolve(window.L);
        else reject(new Error("Leaflet loaded but window.L is undefined."));
      };
      script.onerror = () => reject(new Error("Failed to load Leaflet from CDN."));
      document.head.appendChild(script);
    } else if (window.L) {
      resolve(window.L);
    }
  });
  return loadPromise;
}
