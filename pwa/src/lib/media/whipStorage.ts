/**
 * WHIP broadcast configuration — shared constants used by both
 * LiveStreamView (the live-stream component) and Setup (the config panel).
 *
 * Keeping keys and provider templates here prevents the two callers from
 * drifting: if a key is renamed or a provider is added, one file to update.
 */

// ── localStorage keys ────────────────────────────────────────────────────────

export const WHIP_URL_KEY      = "ss-whip-url";
export const WHIP_BEARER_KEY   = "ss-whip-bearer";
export const WHIP_PROVIDER_KEY = "ss-whip-provider";

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
