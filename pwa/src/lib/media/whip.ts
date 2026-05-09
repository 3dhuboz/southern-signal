/**
 * WHIP (WebRTC-HTTP Ingestion Protocol) client.
 *
 * Pushes a MediaStream (composited camera + overlays + mic) to any WHIP
 * ingest endpoint. Works with Cloudflare Stream Live, Mux, Dolby.io,
 * Eyevinn, etc. Spec: draft-ietf-wish-whip.
 *
 * Lifecycle:
 *   const session = await startWhipSession({ url, stream });
 *   ... live ...
 *   await session.stop();
 */

export interface WhipStartOptions {
  /** WHIP ingest URL (POST endpoint). */
  url: string;
  /** Optional bearer token (some providers require it). */
  bearerToken?: string;
  /** The MediaStream to push (must already include video + audio tracks). */
  stream: MediaStream;
  /** Called on connection state changes. */
  onConnectionState?: (state: RTCPeerConnectionState) => void;
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

export async function startWhipSession(opts: WhipStartOptions): Promise<WhipSession> {
  const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE, bundlePolicy: "max-bundle" });

  // Add transceivers in send-only mode so we offer video + audio outbound.
  pc.addTransceiver("video", { direction: "sendonly" });
  pc.addTransceiver("audio", { direction: "sendonly" });

  // Attach the source stream's tracks to the corresponding senders.
  for (const track of opts.stream.getTracks()) {
    const sender = pc.getSenders().find((s) => s.track == null && (
      (track.kind === "video" && (s as RTCRtpSender & { transport?: unknown }) != null)
    ));
    if (sender) {
      await sender.replaceTrack(track);
    } else {
      pc.addTrack(track, opts.stream);
    }
  }

  if (opts.onConnectionState) {
    pc.addEventListener("connectionstatechange", () => opts.onConnectionState!(pc.connectionState));
  }

  // Create offer + wait for ICE gathering to complete (trickle is allowed
  // by WHIP but many ingest servers prefer a complete SDP).
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceComplete(pc);

  const sdp = pc.localDescription?.sdp ?? "";
  if (!sdp) throw new Error("WHIP: no local SDP available");

  const headers: Record<string, string> = { "Content-Type": "application/sdp" };
  if (opts.bearerToken) headers["Authorization"] = `Bearer ${opts.bearerToken}`;

  const response = await fetch(opts.url, {
    method: "POST",
    headers,
    body: sdp,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`WHIP server ${response.status}: ${detail.slice(0, 240)}`);
  }
  const answerSdp = await response.text();
  const resourceUrl = response.headers.get("location");

  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    pc,
    resourceUrl: resourceUrl ? new URL(resourceUrl, opts.url).toString() : null,
    async stop() {
      try {
        if (resourceUrl) {
          const target = new URL(resourceUrl, opts.url).toString();
          await fetch(target, { method: "DELETE" }).catch(() => { /* server may be flaky */ });
        }
      } finally {
        try { pc.close(); } catch { /* ignore */ }
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
