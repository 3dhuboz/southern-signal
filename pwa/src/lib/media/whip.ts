/**
 * WHIP (WebRTC-HTTP Ingestion Protocol) client.
 *
 * Pushes a MediaStream (composited camera + overlays + mic) to any WHIP
 * ingest endpoint. Works with Cloudflare Stream Live, Mux, Dolby.io,
 * Eyevinn, etc. Spec: draft-ietf-wish-whip.
 *
 * Lifecycle:
 *   const session = await startWhipSession({ url, stream, onState, onStats });
 *   ... live ...
 *   await session.stop();
 */

export type WhipState =
  | "idle"
  | "gathering"
  | "posting"
  | "connecting"
  | "live"
  | "disconnected"
  | "failed";

export interface WhipOutboundStats {
  /** Outbound bitrate (kbps) for video and audio combined. */
  kbps: number;
  /** Packets lost since stream start. */
  packetsLost: number;
  /** Packets sent since stream start. */
  packetsSent: number;
  /** Round-trip time (ms) reported by the most recent candidate pair. */
  rttMs: number | null;
}

export interface WhipStartOptions {
  /** WHIP ingest URL (POST endpoint). */
  url: string;
  /** Optional bearer token (some providers require it). */
  bearerToken?: string;
  /** The MediaStream to push (must already include video + audio tracks). */
  stream: MediaStream;
  /** Called on connection state changes (more granular than RTC's). */
  onState?: (state: WhipState) => void;
  /** Called every ~1s with outbound RTP stats. */
  onStats?: (stats: WhipOutboundStats) => void;
}

export interface WhipSession {
  pc: RTCPeerConnection;
  resourceUrl: string | null;
  /** Stop streaming and tear down. */
  stop(): Promise<void>;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

const STATS_INTERVAL_MS = 1000;

export async function startWhipSession(opts: WhipStartOptions): Promise<WhipSession> {
  const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE, bundlePolicy: "max-bundle" });
  let state: WhipState = "idle";
  const setState = (s: WhipState) => { if (s !== state) { state = s; opts.onState?.(s); } };

  // Add transceivers in send-only mode for each track in the source stream,
  // attaching the track in the same call so the transceiver is bound to the
  // right track from the start (no fragile sender-search post-hoc).
  for (const track of opts.stream.getTracks()) {
    pc.addTransceiver(track, { direction: "sendonly", streams: [opts.stream] });
  }

  pc.addEventListener("connectionstatechange", () => {
    switch (pc.connectionState) {
      case "connected": setState("live"); break;
      case "failed": setState("failed"); break;
      case "disconnected": setState("disconnected"); break;
      case "closed": setState("disconnected"); break;
      default: /* "new" / "connecting" already covered by the lifecycle below */
    }
  });

  // Create offer + wait for ICE gathering to complete (trickle is allowed
  // by WHIP but many ingest servers prefer a complete SDP).
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  setState("gathering");
  await waitForIceComplete(pc);

  const sdp = pc.localDescription?.sdp ?? "";
  if (!sdp) {
    setState("failed");
    throw new Error("WHIP: no local SDP available");
  }

  setState("posting");
  const headers: Record<string, string> = { "Content-Type": "application/sdp" };
  if (opts.bearerToken) headers["Authorization"] = `Bearer ${opts.bearerToken}`;

  const response = await fetch(opts.url, {
    method: "POST",
    headers,
    body: sdp,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    setState("failed");
    throw new Error(`WHIP server ${response.status}: ${detail.slice(0, 240)}`);
  }
  const answerSdp = await response.text();
  const resourceUrl = response.headers.get("location");

  setState("connecting");
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  // Stats poller — totals are cumulative, so we diff against the previous
  // sample to compute live kbps. RTT comes from the active candidate pair.
  let lastBytesSent = 0;
  let lastSampleAt = Date.now();
  const statsHandle = opts.onStats
    ? window.setInterval(async () => {
        try {
          const report = await pc.getStats();
          let bytesSent = 0;
          let packetsSent = 0;
          let packetsLost = 0;
          let rttMs: number | null = null;
          report.forEach((stat) => {
            const s = stat as RTCStats & { type: string; bytesSent?: number; packetsSent?: number; packetsLost?: number; nominated?: boolean; currentRoundTripTime?: number };
            if (s.type === "outbound-rtp") {
              bytesSent += s.bytesSent ?? 0;
              packetsSent += s.packetsSent ?? 0;
            }
            if (s.type === "remote-inbound-rtp") {
              packetsLost += s.packetsLost ?? 0;
            }
            if (s.type === "candidate-pair" && s.nominated && typeof s.currentRoundTripTime === "number") {
              rttMs = Math.round(s.currentRoundTripTime * 1000);
            }
          });
          const now = Date.now();
          const dtSec = Math.max(0.001, (now - lastSampleAt) / 1000);
          const dBytes = Math.max(0, bytesSent - lastBytesSent);
          const kbps = (dBytes * 8 / 1000) / dtSec;
          lastBytesSent = bytesSent;
          lastSampleAt = now;
          opts.onStats!({ kbps: Math.round(kbps), packetsLost, packetsSent, rttMs });
        } catch { /* ignore stats failures */ }
      }, STATS_INTERVAL_MS)
    : null;

  return {
    pc,
    resourceUrl: resourceUrl ? new URL(resourceUrl, opts.url).toString() : null,
    async stop() {
      if (statsHandle != null) window.clearInterval(statsHandle);
      try {
        if (resourceUrl) {
          const target = new URL(resourceUrl, opts.url).toString();
          const headers: Record<string, string> = {};
          if (opts.bearerToken) headers["Authorization"] = `Bearer ${opts.bearerToken}`;
          await fetch(target, { method: "DELETE", headers }).catch(() => { /* server may be flaky */ });
        }
      } finally {
        try { pc.close(); } catch { /* ignore */ }
        setState("disconnected");
      }
    },
  };
}

function waitForIceComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}
