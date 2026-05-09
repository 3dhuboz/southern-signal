/**
 * Estes peer — minimal WebRTC wrapper for the dual-phone Estes Method.
 *
 * Two roles:
 *   • "receiver" creates an offer and posts it under a 6-digit code, then
 *     polls for an answer. Streams its mic to the questioner. Receives
 *     messages on a datachannel.
 *   • "questioner" enters a code, fetches the offer, posts an answer.
 *     Plays the receiver's mic. Sends messages on the datachannel.
 *
 * Once the SDP handshake completes, all media + data flow P2P (or via
 * STUN). The signaling endpoint never sees the audio.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const SIGNAL_PATH = "/api/estes/signal";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

export type EstesRole = "receiver" | "questioner";

export interface EstesPeerEvents {
  onConnected?: () => void;
  onClosed?: () => void;
  onMessage?: (text: string, fromIso: string) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (msg: string) => void;
}

export class EstesPeer {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private code: string | null = null;
  private events: EstesPeerEvents;
  private pollHandle: number | null = null;
  private opened = false;

  constructor(events: EstesPeerEvents = {}) {
    this.events = events;
  }

  isConnected(): boolean { return this.opened; }

  async startReceiver(code: string, micStream: MediaStream): Promise<void> {
    this.code = code;
    this.localStream = micStream;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    this.attachPeerEvents(pc);

    micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

    // Receiver creates the datachannel.
    const dc = pc.createDataChannel("estes", { ordered: true });
    this.attachDataChannel(dc);

    const offer = await pc.createOffer({ offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc);

    await this.postSignal("offer", pc.localDescription!);
    await this.pollForRemote("answer");
  }

  async startQuestioner(code: string): Promise<void> {
    this.code = code;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    this.attachPeerEvents(pc);

    pc.ondatachannel = (ev) => this.attachDataChannel(ev.channel);

    const offerPayload = await this.fetchSignal("offer");
    if (!offerPayload) throw new Error("No offer found for that code (or it expired). Ask the Receiver to start again.");

    await pc.setRemoteDescription(new RTCSessionDescription(offerPayload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceGathering(pc);

    await this.postSignal("answer", pc.localDescription!);
  }

  send(text: string): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify({ text, ts: new Date().toISOString() }));
  }

  close(): void {
    if (this.pollHandle != null) { window.clearTimeout(this.pollHandle); this.pollHandle = null; }
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    if (this.opened) {
      this.opened = false;
      this.events.onClosed?.();
    }
  }

  private attachPeerEvents(pc: RTCPeerConnection): void {
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.events.onRemoteStream?.(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && !this.opened) {
        this.opened = true;
        this.events.onConnected?.();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        if (this.opened) {
          this.opened = false;
          this.events.onClosed?.();
        }
      }
    };
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { text?: string; ts?: string };
        if (typeof parsed.text === "string") {
          this.events.onMessage?.(parsed.text, parsed.ts ?? new Date().toISOString());
        }
      } catch { /* ignore non-JSON */ }
    };
  }

  private async waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      // Hard stop after 4s — most NATs are quick or impossible.
      window.setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }, 4000);
    });
  }

  private async postSignal(role: "offer" | "answer", sdp: RTCSessionDescription): Promise<void> {
    if (!this.code) throw new Error("No code set");
    const resp = await fetch(SIGNAL_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: this.code, role, sdp: { type: sdp.type, sdp: sdp.sdp } }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Signal post failed (${resp.status}): ${text.slice(0, 160)}`);
    }
  }

  private async fetchSignal(role: "offer" | "answer"): Promise<{ sdp: RTCSessionDescriptionInit } | null> {
    if (!this.code) throw new Error("No code set");
    const resp = await fetch(`${SIGNAL_PATH}?code=${encodeURIComponent(this.code)}&role=${role}`, { method: "GET" });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Signal fetch failed (${resp.status})`);
    const data = await resp.json() as { sdp?: RTCSessionDescriptionInit };
    return data.sdp ? { sdp: data.sdp } : null;
  }

  private async pollForRemote(role: "offer" | "answer"): Promise<void> {
    if (!this.pc) return;
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const found = await this.fetchSignal(role).catch(() => null);
      if (found) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(found.sdp));
        return;
      }
      await new Promise((r) => { this.pollHandle = window.setTimeout(r, POLL_INTERVAL_MS); });
    }
    throw new Error("Timed out waiting for the other phone to connect.");
  }
}

export function generatePairingCode(): string {
  // 6-digit zero-padded code.
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}
