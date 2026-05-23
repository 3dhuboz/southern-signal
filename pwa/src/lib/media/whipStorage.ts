/**
 * WHIP broadcast configuration — shared constants used by both
 * LiveStreamView (the live-stream component) and Setup (the config panel).
 *
 * Keeping keys and provider templates here prevents the two callers from
 * drifting: if a key is renamed or a provider is added, one file to update.
 */

// ── Storage keys ─────────────────────────────────────────────────────────────

export const WHIP_URL_KEY      = "ss-whip-url";
export const WHIP_BEARER_KEY   = "ss-whip-bearer";
export const WHIP_PROVIDER_KEY = "ss-whip-provider";
export const FB_STREAM_KEY_SESSION_KEY = "ss-fb-stream-key";
export const FB_CONNECT_TOKEN_LEGACY_KEY = "ss-fb-connect-token";

// ── Provider templates ───────────────────────────────────────────────────────

export type WhipProviderKey =
  | "cloudflare"
  | "fb_live_via_cloudflare"
  | "fb_live_via_restream"
  | "mux"
  | "dolby"
  | "eyevinn"
  | "custom";

export interface WhipProviderTemplate {
  key: WhipProviderKey;
  label: string;
  /** URL template — user replaces <bracketed> placeholders. */
  url: string;
  /** Short setup note shown below the URL field in LiveStreamView. */
  note: string;
}

// URL templates with placeholders intentionally preserved — the user replaces
// the <bracketed> bits with their stream-specific values.
//
// Honest constraint on Facebook Live: FB only accepts RTMP/RTMPS, and
// browsers cannot speak RTMP. So "FB Live" entries below are RELAY paths —
// the browser pushes WHIP to a relay, and the relay re-broadcasts to FB
// over RTMP. The note for each entry explains the one-time setup.
export const WHIP_PROVIDERS: WhipProviderTemplate[] = [
  {
    key: "cloudflare",
    label: "Cloudflare Stream Live",
    url: "https://customer-XXXX.cloudflarestream.com/<input-id>/webrtc/publish",
    note: "From Cloudflare dashboard → Stream → Live Inputs → WebRTC URL. Bearer token not required.",
  },
  {
    key: "fb_live_via_cloudflare",
    label: "Facebook Live (via Cloudflare relay)",
    url: "https://customer-XXXX.cloudflarestream.com/<input-id>/webrtc/publish",
    note: "FB Live needs RTMP, which browsers can't speak. ONE-TIME SETUP: in Cloudflare → Stream → Live Inputs, create a new input, then under 'Outputs' add Facebook Live with URL rtmps://live-api-s.facebook.com:443/rtmp/ and the stream key from facebook.com/live/producer. Paste this input's WebRTC URL above; we'll push to Cloudflare and Cloudflare relays to FB.",
  },
  {
    key: "fb_live_via_restream",
    label: "Facebook Live (via Restream.io)",
    url: "https://live.restream.io/whip/<stream-key>",
    note: "Restream gives you a single ingest URL that fans out to FB Live + others. ONE-TIME SETUP: restream.io → connect Facebook page → copy the WHIP URL from Settings → Encoding. Free tier supports one destination.",
  },
  {
    key: "mux",
    label: "Mux",
    url: "https://global-live.mux.com/api/whip/<stream-key>",
    note: "From Mux dashboard → Live Streams → Stream Key. Bearer token: paste your Mux access token. Mux can also re-broadcast to FB via Simulcast Targets.",
  },
  {
    key: "dolby",
    label: "Dolby.io",
    url: "https://director.millicast.com/api/whip/<stream-name>",
    note: "From Dolby.io dashboard → Live → WHIP. Token required.",
  },
  {
    key: "eyevinn",
    label: "Eyevinn open-source WHIP gateway",
    url: "https://wht.eyevinn.technology/<channel-id>",
    note: "Free public test endpoint. Treat as throwaway — anyone can publish.",
  },
  {
    key: "custom",
    label: "Custom",
    url: "",
    note: "",
  },
];

export function isWhipProviderKey(value: unknown): value is WhipProviderKey {
  return typeof value === "string" && WHIP_PROVIDERS.some((p) => p.key === value);
}

export function readStoredWhipProvider(): WhipProviderKey {
  try {
    const stored = localStorage.getItem(WHIP_PROVIDER_KEY);
    if (isWhipProviderKey(stored)) return stored;
  } catch { /* ignore */ }
  return "custom";
}

export function canPersistWhipUrl(provider: WhipProviderKey, url: string): boolean {
  if (!url.trim()) return false;
  return provider === "cloudflare" || provider === "eyevinn";
}

export function readStoredWhipUrl(provider: WhipProviderKey = readStoredWhipProvider()): string {
  try {
    const sessionUrl = sessionStorage.getItem(WHIP_URL_KEY);
    if (sessionUrl) return sessionUrl;
  } catch { /* ignore */ }

  try {
    const persistedUrl = localStorage.getItem(WHIP_URL_KEY) ?? "";
    if (persistedUrl && canPersistWhipUrl(provider, persistedUrl)) return persistedUrl;
    if (persistedUrl) localStorage.removeItem(WHIP_URL_KEY);
  } catch { /* ignore */ }
  return "";
}

export function readStoredWhipBearer(): string {
  try {
    const sessionBearer = sessionStorage.getItem(WHIP_BEARER_KEY);
    if (sessionBearer) return sessionBearer;
  } catch { /* ignore */ }

  try {
    const legacyBearer = localStorage.getItem(WHIP_BEARER_KEY) ?? "";
    if (legacyBearer) {
      sessionStorage.setItem(WHIP_BEARER_KEY, legacyBearer);
      localStorage.removeItem(WHIP_BEARER_KEY);
      return legacyBearer;
    }
  } catch { /* ignore */ }
  return "";
}

export function saveWhipBroadcastConfig(input: {
  provider: WhipProviderKey;
  url: string;
  bearer: string;
}): void {
  const url = input.url.trim();
  const bearer = input.bearer.trim();
  try { localStorage.setItem(WHIP_PROVIDER_KEY, input.provider); } catch { /* ignore */ }

  try {
    if (url) sessionStorage.setItem(WHIP_URL_KEY, url);
    else sessionStorage.removeItem(WHIP_URL_KEY);
  } catch { /* ignore */ }

  try {
    if (url && canPersistWhipUrl(input.provider, url)) localStorage.setItem(WHIP_URL_KEY, url);
    else localStorage.removeItem(WHIP_URL_KEY);
  } catch { /* ignore */ }

  try {
    if (bearer) sessionStorage.setItem(WHIP_BEARER_KEY, bearer);
    else sessionStorage.removeItem(WHIP_BEARER_KEY);
  } catch { /* ignore */ }

  try { localStorage.removeItem(WHIP_BEARER_KEY); } catch { /* ignore */ }
}

export function clearWhipBroadcastConfig(): void {
  try {
    sessionStorage.removeItem(WHIP_URL_KEY);
    sessionStorage.removeItem(WHIP_BEARER_KEY);
    sessionStorage.removeItem(FB_STREAM_KEY_SESSION_KEY);
  } catch { /* ignore */ }
  try {
    localStorage.removeItem(WHIP_URL_KEY);
    localStorage.removeItem(WHIP_BEARER_KEY);
    localStorage.removeItem(WHIP_PROVIDER_KEY);
    localStorage.removeItem(FB_STREAM_KEY_SESSION_KEY);
    localStorage.removeItem(FB_CONNECT_TOKEN_LEGACY_KEY);
  } catch { /* ignore */ }
}
