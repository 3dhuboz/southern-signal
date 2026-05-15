/**
 * LiveStreamView — TV-production grade output. Camera + mic + sensor
 * overlays composited onto a single canvas at 30fps; the composite can
 * be:
 *
 *   • Recorded to disk (MediaRecorder → OPFS, hash-chained as media_asset).
 *   • Live-streamed via WHIP (WebRTC ingest) to Cloudflare Stream Live,
 *     YouTube Live (with WHIP relay), Twitch (Restream/Mux), etc.
 *
 * Both outputs share the same composited frames, so what the producer
 * records on disk is byte-equivalent (in terms of overlay state) to
 * what the live audience sees. ISO timestamp + case ID are baked in
 * per frame for editing-room defensibility.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { writeBytes } from "../lib/opfs";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { describeActivity } from "../lib/posterior/plainEnglish";
import {
  createCanvasCompositor,
  DEFAULT_OVERLAY_CHANNELS,
  type CanvasCompositor,
  type OverlayChannels,
  type OverlayState,
} from "../lib/media/canvasCompositor";
import { startWhipSession, type WhipSession, type WhipState, type WhipOutboundStats } from "../lib/media/whip";
import { setLiveBroadcastState } from "../lib/system/liveBroadcast";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import { getItcChannels } from "../lib/itc/itcChannels";
import s from "./LiveStreamView.module.css";

/* Overlay-channels localStorage key + helpers. Stored under ss-* like the
 * other LiveStreamView preferences. Merging against DEFAULT_OVERLAY_CHANNELS
 * keeps old persisted values forward-compatible when new channels are added. */
const OVERLAY_CHANNELS_LS_KEY = "ss-overlay-channels";

function loadOverlayChannels(): OverlayChannels {
  try {
    const raw = localStorage.getItem(OVERLAY_CHANNELS_LS_KEY);
    if (!raw) return DEFAULT_OVERLAY_CHANNELS;
    const parsed = JSON.parse(raw) as Partial<OverlayChannels>;
    return { ...DEFAULT_OVERLAY_CHANNELS, ...parsed };
  } catch {
    return DEFAULT_OVERLAY_CHANNELS;
  }
}

function saveOverlayChannels(channels: OverlayChannels): void {
  try { localStorage.setItem(OVERLAY_CHANNELS_LS_KEY, JSON.stringify(channels)); } catch { /* ignore */ }
}

/* User-facing labels + short descriptions for the channels panel.
 * Kept here (next to the consumer) rather than in canvasCompositor so the
 * compositor stays headless and copy stays edit-able by anyone in the file. */
const CHANNEL_LABELS: Record<keyof OverlayChannels, { name: string; hint: string }> = {
  activityPill:    { name: "Activity pill",      hint: "Top-left band label" },
  posteriorPill:   { name: "Posterior",          hint: "Top-right P %" },
  edgeGlow:        { name: "Edge glow",          hint: "Radial tint, posterior-driven" },
  sensors:         { name: "Sensors",            hint: "LIGHT · MAG · MOTION · TEMP" },
  itc:             { name: "ITC channels",       hint: "Spirit Box · Ovilus · EVP" },
  directionArrow:  { name: "Direction arrow",    hint: "Acoustic sector when coherence ≥ 0.5" },
  caption:         { name: "AI caption",         hint: "Bottom narration strip" },
  timestamp:       { name: "Timestamp + case",   hint: "Bottom-right ISO + case ID (recommended)" },
  statusPills:     { name: "REC / LIVE pills",   hint: "Centre-top status indicators" },
};

const CHANNEL_KEYS = Object.keys(CHANNEL_LABELS) as Array<keyof OverlayChannels>;

type WhipProviderKey = "cloudflare" | "fb_live_via_cloudflare" | "fb_live_via_restream" | "mux" | "dolby" | "eyevinn" | "custom";

interface WhipProviderTemplate {
  key: WhipProviderKey;
  label: string;
  url: string;
  note: string;
}

// URL templates with placeholders intentionally preserved — the user replaces
// the <bracketed> bits with their stream-specific values.
//
// Honest constraint on Facebook Live: FB only accepts RTMP/RTMPS, and
// browsers cannot speak RTMP. So "FB Live" entries below are RELAY paths —
// the browser pushes WHIP to a relay, and the relay re-broadcasts to FB
// over RTMP. The note for each entry explains the one-time setup.
const WHIP_PROVIDERS: WhipProviderTemplate[] = [
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

interface LiveStreamViewProps {
  investigationId: string | null;
  running: boolean;
  posterior: number;
  audioRms: number;
  sector: string | null;
  coherence: number;
  caseId: string | null;
  caseTitle: string | null;
  caption: string | null;
  /** Live sensor values for the on-canvas mini-readout. Each is optional;
   *  rows render only when a finite number is supplied. */
  lightLux?: number;
  magnetometerUt?: number;
  motionMs2?: number;
  temperatureC?: number;
  /** Bubbles recording / live state up so the parent can reflect it in
   *  out-of-band UI (e.g. the Simple-mode broadcast CTA). */
  onStateChange?: (state: { recording: boolean; broadcasting: boolean }) => void;
}

export function LiveStreamView(props: LiveStreamViewProps) {
  const {
    investigationId, running, posterior, audioRms, sector, coherence, caseId, caseTitle, caption,
    lightLux, magnetometerUt, motionMs2, temperatureC, onStateChange,
  } = props;

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const compositorStreamRef = useRef<MediaStream | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const whipSessionRef = useRef<WhipSession | null>(null);

  const [streamOn, setStreamOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [whipUrl, setWhipUrl] = useState<string>(() => {
    try { return localStorage.getItem("ss-whip-url") ?? ""; } catch { return ""; }
  });
  const [whipBearer, setWhipBearer] = useState<string>(() => {
    try { return localStorage.getItem("ss-whip-bearer") ?? ""; } catch { return ""; }
  });
  const [whipProvider, setWhipProvider] = useState<WhipProviderKey>(() => {
    try {
      const stored = localStorage.getItem("ss-whip-provider");
      if (stored && WHIP_PROVIDERS.some((p) => p.key === stored)) {
        return stored as WhipProviderKey;
      }
    } catch { /* ignore */ }
    return "custom";
  });
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [recordingsCount, setRecordingsCount] = useState(0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [whipState, setWhipState] = useState<WhipState>("idle");
  const [fbStreamKey, setFbStreamKey] = useState<string>(() => {
    try { return localStorage.getItem("ss-fb-stream-key") ?? ""; } catch { return ""; }
  });
  const [fbConnectToken, setFbConnectToken] = useState<string>(() => {
    try { return localStorage.getItem("ss-fb-connect-token") ?? ""; } catch { return ""; }
  });
  const [fbConnecting, setFbConnecting] = useState(false);
  const [fbConnectMsg, setFbConnectMsg] = useState<string | null>(null);
  const [whipStats, setWhipStats] = useState<WhipOutboundStats | null>(null);
  // Compartmentalised overlay channels. Defaults all-on; operator hides the
  // bits they don't want baked into the recording or live stream. Persists
  // across sessions so a producer's choices stick.
  const [channels, setChannels] = useState<OverlayChannels>(() => loadOverlayChannels());
  useEffect(() => { saveOverlayChannels(channels); }, [channels]);

  const setChannel = useCallback((key: keyof OverlayChannels, value: boolean) => {
    setChannels((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const setAllChannels = useCallback((value: boolean) => {
    setChannels(() => {
      const next = {} as OverlayChannels;
      for (const k of CHANNEL_KEYS) next[k] = value;
      return next;
    });
  }, []);
  const enabledChannelCount = CHANNEL_KEYS.reduce((n, k) => n + (channels[k] ? 1 : 0), 0);

  // Keep the latest props in a ref so the compositor's getOverlay() always
  // returns fresh state without re-creating the compositor each render.
  const overlayStateRef = useRef<OverlayState>({
    caseId: undefined,
    caseTitle: undefined,
    isoTimestamp: new Date().toISOString(),
    posterior: 0,
    activityLabel: "Calm",
    activityBand: "calm",
    sector: null,
    coherence: 0,
    caption: null,
    audioRms: 0,
    recording: false,
    liveStreaming: false,
  });

  useEffect(() => {
    const activity = describeActivity(posterior);
    // Only build the sensors object if at least one channel has a finite value;
    // an empty/undefined field tells the compositor to skip the readout.
    const sensors: NonNullable<OverlayState["sensors"]> = {};
    if (typeof lightLux === "number" && Number.isFinite(lightLux)) sensors.light = lightLux;
    if (typeof magnetometerUt === "number" && Number.isFinite(magnetometerUt)) sensors.magnetometer = magnetometerUt;
    if (typeof motionMs2 === "number" && Number.isFinite(motionMs2)) sensors.motion = motionMs2;
    if (typeof temperatureC === "number" && Number.isFinite(temperatureC)) sensors.temperature = temperatureC;
    const hasAnySensor = Object.keys(sensors).length > 0;

    overlayStateRef.current = {
      caseId: caseId ?? undefined,
      caseTitle: caseTitle ?? undefined,
      isoTimestamp: new Date().toISOString(),
      posterior,
      activityLabel: activity.label,
      activityBand: activity.id as OverlayState["activityBand"],
      sector,
      coherence,
      caption: caption ?? null,
      audioRms,
      recording,
      liveStreaming: liveOn,
      sensors: hasAnySensor ? sensors : undefined,
      channels,
    };
  }, [posterior, audioRms, sector, coherence, caseId, caseTitle, caption, recording, liveOn, lightLux, magnetometerUt, motionMs2, temperatureC, channels]);

  const openCamera = useCallback(async (mode: "environment" | "user"): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      // Only fall back for constraint-related rejections. Retrying after a
      // NotAllowedError / NotFoundError / NotReadableError / SecurityError /
      // AbortError would just trigger a second permission prompt or hit the
      // same hardware failure — doubling user-visible thrash and, on
      // Android Chrome, surfacing the "This site can't ask for your
      // permission" system dialog twice when a bubble/overlay is blocking
      // the standard permission UI.
      const e = err as Error & { name?: string };
      if (e.name === "OverconstrainedError" || e.name === "ConstraintNotSatisfiedError") {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
      throw err;
    }
  }, []);

  const detectTorchSupport = useCallback((stream: MediaStream) => {
    const track = stream.getVideoTracks()[0];
    if (!track) { setTorchSupported(false); return; }
    // The torch capability isn't in the standard typings — feature-detect at runtime.
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
    setTorchSupported(caps.torch === true);
    setTorchOn(false);
  }, []);

  const start = useCallback(async () => {
    if (streamOn || busy) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser doesn't expose a camera/mic API. HTTPS is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stream = await openCamera(facingMode);
      sourceStreamRef.current = stream;
      detectTorchSupport(stream);
      setStreamOn(true);
    } catch (err) {
      const e = err as Error & { name?: string };
      // AbortError / SecurityError fire on Android Chrome when a system
      // overlay or another app's bubble blocks the standard permission UI
      // ("This site can't ask for your permission"). The standard
      // NotAllowedError text "denied" implies user choice — which isn't
      // accurate here — so we give a hint about closing overlays instead.
      const msg =
        e.name === "NotAllowedError" ? "Camera/mic permission was denied. Open browser site settings to re-enable."
        : e.name === "NotFoundError" ? "No camera or microphone found."
        : e.name === "NotReadableError" ? "Camera or mic is busy in another app. Close other camera apps and try again."
        : e.name === "AbortError" ? "The camera prompt was interrupted. If you saw an Android system dialog about overlays or bubbles, close other apps with floating windows (e.g. Messenger chat heads, edge panels) and try again."
        : e.name === "SecurityError" ? "Camera/mic blocked by browser security. Ensure the site is loaded over HTTPS and that site permissions allow camera + microphone."
        : (e.message || "Camera unavailable");
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [streamOn, busy, facingMode, openCamera, detectTorchSupport]);

  const flipCamera = useCallback(async () => {
    if (!streamOn || busy) return;
    const next = facingMode === "environment" ? "user" : "environment";
    setBusy(true);
    setError(null);
    try {
      // Open the new camera before stopping the old one — minimizes preview gap.
      const newStream = await openCamera(next);
      const newVideo = newStream.getVideoTracks()[0];
      const newAudio = newStream.getAudioTracks()[0];
      const oldStream = sourceStreamRef.current;
      // Replace tracks in the source MediaStream so the compositor's <video>
      // element keeps its srcObject (no flicker).
      if (oldStream) {
        oldStream.getVideoTracks().forEach((t) => { oldStream.removeTrack(t); t.stop(); });
        if (newVideo) oldStream.addTrack(newVideo);
        // Audio track stays put — no need to re-grab.
        newStream.getAudioTracks().forEach((t) => { if (t !== newAudio) t.stop(); });
        newAudio?.stop();
      } else {
        sourceStreamRef.current = newStream;
      }
      setFacingMode(next);
      detectTorchSupport(sourceStreamRef.current!);
      const sourceV = sourceVideoRef.current;
      if (sourceV) sourceV.play().catch(() => { /* user gesture if needed */ });
    } catch (err) {
      setError(`Couldn't flip camera: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [streamOn, busy, facingMode, openCamera, detectTorchSupport]);

  const toggleTorch = useCallback(async () => {
    const track = sourceStreamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    const next = !torchOn;
    try {
      // Torch is a non-standard MediaTrackConstraint — typed as any here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await track.applyConstraints({ advanced: [{ torch: next }] as any });
      setTorchOn(next);
    } catch (err) {
      setError(`Torch unavailable: ${(err as Error).message}`);
    }
  }, [torchOn, torchSupported]);

  // Once the stream is on and the source <video> element is mounted,
  // attach the camera track to it, build the compositor, and wire the
  // composited stream into the preview <video>.
  useEffect(() => {
    const stream = sourceStreamRef.current;
    const sourceV = sourceVideoRef.current;
    if (!streamOn || !stream || !sourceV) return;
    sourceV.srcObject = stream;
    sourceV.play().catch(() => { /* user may need to tap */ });

    const compositor = createCanvasCompositor({
      video: sourceV,
      // Always stamp the timestamp + recompute ITC ages at draw time, not when
      // overlay state was last assembled in the props effect — otherwise the
      // time freezes whenever the watched props are stable (e.g. quiet scene)
      // and the age stamps stop ticking.
      getOverlay: () => {
        const now = Date.now();
        const store = getItcChannels();
        const itc: NonNullable<OverlayState["itc"]> = {};
        if (store.spiritBox) itc.spiritBox = { text: store.spiritBox.text, ageMs: now - store.spiritBox.timestamp };
        if (store.ovilus) itc.ovilus = { text: store.ovilus.text, ageMs: now - store.ovilus.timestamp };
        if (store.evp) itc.evp = { text: store.evp.text, ageMs: now - store.evp.timestamp };
        const hasAnyItc = Object.keys(itc).length > 0;
        return {
          ...overlayStateRef.current,
          isoTimestamp: new Date(now).toISOString(),
          itc: hasAnyItc ? itc : undefined,
        };
      },
      fps: 30,
    });
    compositorRef.current = compositor;
    compositor.start();

    // Build the OUTGOING stream: composited video + original audio track.
    const compositedVideoStream = compositor.captureStream();
    const audioTracks = stream.getAudioTracks();
    const outgoing = new MediaStream([
      ...compositedVideoStream.getVideoTracks(),
      ...audioTracks,
    ]);
    compositorStreamRef.current = outgoing;

    // Show the composite as the preview (so the operator sees what the
    // recording / live audience sees).
    const previewV = previewVideoRef.current;
    if (previewV) {
      previewV.srcObject = outgoing;
      previewV.muted = true;
      previewV.play().catch(() => { /* ignore */ });
    }

    return () => {
      compositor.stop();
      compositorRef.current = null;
      compositorStreamRef.current = null;
    };
  }, [streamOn]);

  const stop = useCallback(async () => {
    // Stop live first.
    if (whipSessionRef.current) {
      await whipSessionRef.current.stop().catch(() => { /* ignore */ });
      whipSessionRef.current = null;
      setLiveOn(false);
    }
    // Stop recording (also flushes a final clip).
    if (recorderRef.current && recording) {
      try { recorderRef.current.stop(); } catch { /* will fire onstop */ }
    }
    // Stop the source tracks.
    const srcStream = sourceStreamRef.current;
    if (srcStream) srcStream.getTracks().forEach((t) => t.stop());
    sourceStreamRef.current = null;
    setStreamOn(false);
    setRecording(false);
    setStatusMsg(null);
  }, [recording]);

  const toggleRecording = useCallback(async () => {
    if (!compositorStreamRef.current) return;
    if (recording) {
      try { recorderRef.current?.stop(); } catch { /* ignore */ }
      return;
    }
    if (!investigationId) {
      setError("Begin an investigation session before recording.");
      return;
    }
    recorderChunksRef.current = [];
    const mimeCandidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "video/webm";
    const recorder = new MediaRecorder(compositorStreamRef.current, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recorderChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(recorderChunksRef.current, { type: mime });
      recorderChunksRef.current = [];
      setRecording(false);
      if (blob.size === 0 || !investigationId) return;
      try {
        const buf = await blob.arrayBuffer();
        const sha = await sha256HexBytes(buf);
        const ts = Date.now();
        const ext = mime.includes("mp4") ? "mp4" : "webm";
        const filePath = `media/${investigationId}/clip-${ts}-${sha.slice(0, 8)}.${ext}`;
        await writeBytes(filePath, buf);
        await registerMedia({
          investigation_id: investigationId,
          media_type: "video",
          file_path: filePath,
          timestamp_start: new Date(ts).toISOString(),
          checksum_sha256: sha,
          metadata: {
            source: "live_stream_composite",
            mime,
            bytes: blob.size,
            overlays_baked_in: true,
          },
        });
        await recordEvent({
          investigation_id: investigationId,
          source: "user",
          event_type: "video.clip",
          title: "Composited video clip saved",
          metadata: { sha256: sha, file_path: filePath, bytes: blob.size, mime },
        });
        await appendAuditEntry({
          actor: "user",
          kind: "video.clip.saved",
          payload: { investigation_id: investigationId, ts, sha256: sha, bytes: blob.size, mime },
        });
        setRecordingsCount((n) => n + 1);
        setStatusMsg(`Clip saved · ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (err) {
        setError(`Save failed: ${(err as Error).message}`);
      }
    };
    recorder.start(2000); // emit dataavailable every 2s so we don't lose it on a crash
    setRecording(true);
    setStatusMsg("Recording…");
  }, [recording, investigationId]);

  const toggleLive = useCallback(async () => {
    if (!compositorStreamRef.current) return;
    if (liveOn) {
      if (whipSessionRef.current) await whipSessionRef.current.stop().catch(() => { /* ignore */ });
      whipSessionRef.current = null;
      setLiveOn(false);
      setStatusMsg("Live ended.");
      if (investigationId) {
        await appendAuditEntry({
          actor: "user",
          kind: "live.stop",
          payload: { investigation_id: investigationId, ts: Date.now() },
        }).catch(() => { /* ignore */ });
      }
      return;
    }
    if (!whipUrl.trim()) {
      setError("Paste your WHIP ingest URL first.");
      return;
    }
    try {
      localStorage.setItem("ss-whip-url", whipUrl.trim());
      if (whipBearer.trim()) localStorage.setItem("ss-whip-bearer", whipBearer.trim());
      else localStorage.removeItem("ss-whip-bearer");
    } catch { /* ignore */ }
    try {
      setStatusMsg("Connecting WHIP…");
      setWhipState("idle");
      setWhipStats(null);
      const session = await startWhipSession({
        url: whipUrl.trim(),
        bearerToken: whipBearer.trim() || undefined,
        stream: compositorStreamRef.current,
        onState: (state) => {
          setWhipState(state);
          if (state === "failed" || state === "disconnected") {
            setStatusMsg(`Live ${state}.`);
            setLiveOn(false);
          } else if (state === "live") {
            setStatusMsg("Live.");
          }
        },
        onStats: (stats) => setWhipStats(stats),
      });
      whipSessionRef.current = session;
      setLiveOn(true);
      if (investigationId) {
        await appendAuditEntry({
          actor: "user",
          kind: "live.start",
          payload: { investigation_id: investigationId, ts: Date.now(), whip_host: new URL(whipUrl).host },
        }).catch(() => { /* ignore */ });
      }
    } catch (err) {
      setError(`WHIP failed: ${(err as Error).message}`);
      setStatusMsg(null);
    }
  }, [liveOn, whipUrl, whipBearer, investigationId]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  // Bubble state changes up so the parent can mirror REC / LIVE in its own UI,
  // AND publish to the app-wide module store so the AppHeader pins the state
  // across every route.
  useEffect(() => {
    const next = { recording, broadcasting: liveOn };
    onStateChange?.(next);
    setLiveBroadcastState(next);
  }, [recording, liveOn, onStateChange]);

  // On unmount (route change, session end), clear the global flag so a
  // ghost "LIVE" pin can't linger after the camera closes.
  useEffect(() => {
    return () => setLiveBroadcastState({ recording: false, broadcasting: false });
  }, []);

  const handleProviderChange = useCallback((nextKey: WhipProviderKey) => {
    setWhipProvider(nextKey);
    try { localStorage.setItem("ss-whip-provider", nextKey); } catch { /* ignore */ }
    const provider = WHIP_PROVIDERS.find((p) => p.key === nextKey);
    if (!provider) return;
    // Custom leaves the URL untouched-blank; everything else pre-fills the
    // template (placeholders included — the user replaces <bracketed> bits).
    if (nextKey === "custom") {
      setWhipUrl("");
    } else {
      setWhipUrl(provider.url);
    }
  }, []);

  const activeProvider = WHIP_PROVIDERS.find((p) => p.key === whipProvider);
  const showFbConnector = whipProvider === "fb_live_via_cloudflare";

  const handleFbConnect = useCallback(async () => {
    if (!fbStreamKey.trim()) {
      setFbConnectMsg("Paste the Facebook stream key first (from facebook.com/live/producer → Use Stream Key).");
      return;
    }
    if (!fbConnectToken.trim()) {
      setFbConnectMsg("Bearer token required — matches FB_CONNECT_TOKEN in your Cloudflare Pages env.");
      return;
    }
    setFbConnecting(true);
    setFbConnectMsg("Provisioning Cloudflare Live Input + FB output…");
    try {
      try {
        localStorage.setItem("ss-fb-stream-key", fbStreamKey.trim());
        localStorage.setItem("ss-fb-connect-token", fbConnectToken.trim());
      } catch { /* ignore */ }
      const resp = await fetch("/api/live/fb/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${fbConnectToken.trim()}`,
        },
        body: JSON.stringify({ fb_stream_key: fbStreamKey.trim() }),
      });
      const data = await resp.json() as { whip_url?: string; error?: string; cf_detail?: string };
      if (!resp.ok || !data.whip_url) {
        const detail = data.cf_detail ? ` · ${data.cf_detail}` : "";
        setFbConnectMsg(`Failed: ${data.error ?? `HTTP ${resp.status}`}${detail}`);
        return;
      }
      setWhipUrl(data.whip_url);
      try { localStorage.setItem("ss-whip-url", data.whip_url); } catch { /* ignore */ }
      setFbConnectMsg("Connected — WHIP URL above is ready. Click Go live to start broadcasting to Facebook.");
    } catch (err) {
      setFbConnectMsg(`Failed: ${(err as Error).message}`);
    } finally {
      setFbConnecting(false);
    }
  }, [fbStreamKey, fbConnectToken]);

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}>LIVE BROADCAST · TV PRODUCTION</span>
        <span className={s.note}>Camera + mic + AR overlays composited to one stream. Record + go live.</span>
      </header>

      {/* Hidden source video — feeds the compositor. */}
      <video ref={sourceVideoRef} className={s.hidden} playsInline muted />

      {!streamOn && !error && (
        <button
          type="button"
          className={s.openButton}
          onClick={start}
          disabled={busy || !investigationId}
        >
          <span className={s.openIcon} aria-hidden="true">📡</span>
          <span className={s.openLabel}>{busy ? "Opening…" : investigationId ? "Open camera + mic" : "Begin a session first"}</span>
          <span className={s.openHint}>One-stream output. Record locally and/or go live with overlays.</span>
        </button>
      )}

      {error && (
        <div className={s.error}>
          <strong>{error}</strong>
          <button type="button" className={s.errorRetry} onClick={() => { setError(null); }}>Dismiss</button>
        </div>
      )}

      {streamOn && (
        <>
          <div className={s.stage}>
            <video ref={previewVideoRef} className={s.preview} playsInline muted />
            {(recording || liveOn) && (
              <div className={s.statusBadges}>
                {recording && <span className={`${s.badge} ${s.badgeRec}`}>● REC</span>}
                {liveOn && <span className={`${s.badge} ${s.badgeLive}`}>◉ LIVE</span>}
              </div>
            )}
          </div>

          <div className={s.cameraControls}>
            <button type="button" className={s.cameraBtn} onClick={flipCamera} disabled={busy} title="Flip camera">
              <span aria-hidden="true">↺</span>
              <span>{facingMode === "environment" ? "Rear" : "Front"}</span>
            </button>
            {torchSupported && (
              <button
                type="button"
                className={`${s.cameraBtn} ${torchOn ? s.cameraBtnActive : ""}`.trim()}
                onClick={toggleTorch}
                aria-pressed={torchOn}
                title="Toggle torch / flashlight"
              >
                <span aria-hidden="true">⚡</span>
                <span>Torch {torchOn ? "on" : "off"}</span>
              </button>
            )}
          </div>

          {/* Overlay channels — operator picks which baked-in elements
              show on the composite. Collapsed by default; the count tells
              them at a glance how many are on without opening it. */}
          <details className={s.channels}>
            <summary className={s.channelsSummary}>
              <span>Overlay channels</span>
              <span className={s.channelsCount}>{enabledChannelCount}/{CHANNEL_KEYS.length} on</span>
            </summary>
            <div className={s.channelsBody}>
              <p className={s.channelsHint}>
                Each toggle controls a piece of the on-camera overlay. Changes apply instantly to the recording and to live broadcasts; preferences persist on this device.
              </p>
              <div className={s.channelsGrid}>
                {CHANNEL_KEYS.map((key) => {
                  const def = CHANNEL_LABELS[key];
                  const on = channels[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`${s.channelToggle} ${on ? s.channelToggleOn : ""}`.trim()}
                      onClick={() => setChannel(key, !on)}
                      aria-pressed={on}
                      title={def.hint}
                    >
                      <span className={s.channelToggleDot} aria-hidden="true" />
                      <span>
                        <strong>{def.name}</strong>
                        <br />
                        <span style={{ fontSize: "10.5px", opacity: 0.7, fontWeight: 500 }}>{def.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className={s.channelsActions}>
                <button type="button" className={s.channelsActionBtn} onClick={() => setAllChannels(true)}>All on</button>
                <button type="button" className={s.channelsActionBtn} onClick={() => setAllChannels(false)}>All off</button>
                <button type="button" className={s.channelsActionBtn} onClick={() => setChannels(DEFAULT_OVERLAY_CHANNELS)}>Reset</button>
              </div>
            </div>
          </details>

          <div className={s.controls}>
            <button
              type="button"
              className={`${s.action} ${recording ? s.actionRec : ""}`.trim()}
              onClick={toggleRecording}
              disabled={!running}
              aria-pressed={recording}
            >
              {recording ? "Stop recording" : "Record clip"}
            </button>
            <button
              type="button"
              className={`${s.action} ${liveOn ? s.actionLive : ""}`.trim()}
              onClick={toggleLive}
              disabled={!whipUrl.trim()}
              aria-pressed={liveOn}
            >
              {liveOn ? "End live" : "Go live"}
            </button>
            <button type="button" className={s.actionGhost} onClick={stop}>Close camera</button>
          </div>

          {(liveOn || whipState !== "idle") && (
            <div className={s.liveStatus}>
              <span className={`${s.liveStatusDot} ${s[`liveStatusDot_${whipState}`] ?? ""}`.trim()} />
              <span className={s.liveStatusLabel}>{whipState.toUpperCase()}</span>
              {whipStats && (
                <span className={s.liveStatusMetric}>
                  {whipStats.kbps.toLocaleString()} kbps
                  {whipStats.rttMs != null ? ` · RTT ${whipStats.rttMs}ms` : ""}
                  {whipStats.packetsLost > 0 ? ` · lost ${whipStats.packetsLost}` : ""}
                </span>
              )}
            </div>
          )}

          <div className={s.live}>
            <label className={s.field}>
              <span className={s.fieldLabel}>Where do you want to broadcast?</span>
              <select
                className={s.providerSelect}
                value={whipProvider}
                onChange={(e) => handleProviderChange(e.target.value as WhipProviderKey)}
                disabled={liveOn}
              >
                {WHIP_PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </label>

            {/* Simple per-provider input: paste the one or two pieces
                we need from your provider's dashboard, we build the
                WHIP URL. Advanced URL+token below stays available for
                "Custom" or anyone who wants to override. */}
            <SimpleProviderSetup
              providerKey={whipProvider}
              whipUrl={whipUrl}
              onWhipUrl={setWhipUrl}
              onBearer={setWhipBearer}
              liveOn={liveOn}
              fieldClassName={s.field}
              labelClassName={s.fieldLabel}
              inputClassName={s.input}
              hintClassName={s.providerHint}
            />

            {showFbConnector && (
              <div className={s.fbConnector}>
                <p className={s.fbConnectorIntro}>
                  <strong>Quick setup.</strong> Paste your Facebook stream key and we'll create a Cloudflare Live Input + Facebook output for you, then fill the WHIP URL above. Needs <code>CF_ACCOUNT_ID</code>, <code>CF_STREAM_API_TOKEN</code> and <code>FB_CONNECT_TOKEN</code> in your Pages env.
                </p>
                <label className={s.field}>
                  <span className={s.fieldLabel}>Facebook stream key</span>
                  <input
                    type="password"
                    className={s.input}
                    value={fbStreamKey}
                    onChange={(e) => setFbStreamKey(e.target.value)}
                    placeholder="from facebook.com/live/producer → Use Stream Key"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={liveOn || fbConnecting}
                  />
                </label>
                <label className={s.field}>
                  <span className={s.fieldLabel}>Connector bearer token</span>
                  <input
                    type="password"
                    className={s.input}
                    value={fbConnectToken}
                    onChange={(e) => setFbConnectToken(e.target.value)}
                    placeholder="matches FB_CONNECT_TOKEN in Pages env"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={liveOn || fbConnecting}
                  />
                </label>
                <button
                  type="button"
                  className={s.action}
                  onClick={handleFbConnect}
                  disabled={liveOn || fbConnecting || !fbStreamKey.trim() || !fbConnectToken.trim()}
                >
                  {fbConnecting ? "Connecting…" : "Connect to Facebook Live"}
                </button>
                {fbConnectMsg && <p className={s.providerHint}>{fbConnectMsg}</p>}
              </div>
            )}
            {/* Advanced: raw URL + token override. Hidden by default
                so the regular path stays "pick provider + paste key". */}
            <details className={s.advanced}>
              <summary className={s.advancedSummary}>Advanced — paste your own WHIP URL</summary>
              <label className={s.field}>
                <span className={s.fieldLabel}>WHIP ingest URL</span>
                <input
                  type="text"
                  className={s.input}
                  value={whipUrl}
                  onChange={(e) => setWhipUrl(e.target.value)}
                  placeholder="https://customer-XXXX.cloudflarestream.com/<input>/webrtc/publish"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={liveOn}
                />
                {activeProvider && activeProvider.note && (
                  <p className={s.providerHint}>{activeProvider.note}</p>
                )}
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}>Bearer token (if required)</span>
                <input
                  type="password"
                  className={s.input}
                  value={whipBearer}
                  onChange={(e) => setWhipBearer(e.target.value)}
                  placeholder="Leave empty for Cloudflare Stream Live"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={liveOn}
                />
              </label>
            </details>
          </div>

          {statusMsg && <p className={s.statusLine}>{statusMsg}{recordingsCount > 0 ? ` · ${recordingsCount} clips saved` : ""}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Operator-friendly per-provider input. The PROVIDER TEMPLATE dropdown
 * picks a provider; this block then asks for ONLY the one or two
 * placeholders that vary per stream (stream key, customer/input id,
 * etc.) and builds the WHIP URL automatically. Falls back to nothing
 * for "Custom" — those users want the Advanced URL field directly.
 *
 * Bearer tokens only surface for providers that require one (Mux,
 * Dolby). For others the field stays in the Advanced disclosure.
 */
function SimpleProviderSetup({
  providerKey, whipUrl, onWhipUrl, onBearer, liveOn,
  fieldClassName, labelClassName, inputClassName, hintClassName,
}: {
  providerKey: WhipProviderKey;
  whipUrl: string;
  onWhipUrl: (v: string) => void;
  onBearer: (v: string) => void;
  liveOn: boolean;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: string;
  hintClassName: string;
}) {
  // Each provider declares its own simple form. The functions here
  // take the input values, build the final WHIP URL, and push it up
  // via onWhipUrl. Bearer-token side effects mirror the same.
  switch (providerKey) {
    case "cloudflare":
      return (
        <CloudflareStreamSimpleSetup
          whipUrl={whipUrl}
          onWhipUrl={onWhipUrl}
          liveOn={liveOn}
          fieldClassName={fieldClassName}
          labelClassName={labelClassName}
          inputClassName={inputClassName}
          hintClassName={hintClassName}
        />
      );
    case "fb_live_via_cloudflare":
      // Existing Facebook quick-connector path stays above this block;
      // nothing extra to render here.
      return null;
    case "fb_live_via_restream":
      return (
        <SingleKeySimpleSetup
          label="Restream WHIP stream key"
          helperText="From restream.io → Settings → Encoding → WHIP URL. Paste the part after https://live.restream.io/whip/."
          urlPattern={(key) => `https://live.restream.io/whip/${key}`}
          parseFromUrl={(url) => url.match(/restream\.io\/whip\/([^/?#]+)/)?.[1] ?? ""}
          whipUrl={whipUrl}
          onWhipUrl={onWhipUrl}
          liveOn={liveOn}
          fieldClassName={fieldClassName}
          labelClassName={labelClassName}
          inputClassName={inputClassName}
          hintClassName={hintClassName}
        />
      );
    case "mux":
      return (
        <SingleKeySimpleSetup
          label="Mux stream key"
          helperText="From Mux dashboard → Live Streams → Stream Key. Then paste your Mux access token below in Advanced if Mux requires it for your account."
          urlPattern={(key) => `https://global-live.mux.com/api/whip/${key}`}
          parseFromUrl={(url) => url.match(/mux\.com\/api\/whip\/([^/?#]+)/)?.[1] ?? ""}
          whipUrl={whipUrl}
          onWhipUrl={onWhipUrl}
          liveOn={liveOn}
          fieldClassName={fieldClassName}
          labelClassName={labelClassName}
          inputClassName={inputClassName}
          hintClassName={hintClassName}
          bearerLabel="Mux access token"
          onBearer={onBearer}
        />
      );
    case "dolby":
      return (
        <SingleKeySimpleSetup
          label="Dolby.io stream name"
          helperText="From Dolby.io dashboard → Live → WHIP. Then paste your Dolby token below in Advanced."
          urlPattern={(key) => `https://director.millicast.com/api/whip/${key}`}
          parseFromUrl={(url) => url.match(/millicast\.com\/api\/whip\/([^/?#]+)/)?.[1] ?? ""}
          whipUrl={whipUrl}
          onWhipUrl={onWhipUrl}
          liveOn={liveOn}
          fieldClassName={fieldClassName}
          labelClassName={labelClassName}
          inputClassName={inputClassName}
          hintClassName={hintClassName}
          bearerLabel="Dolby.io token"
          onBearer={onBearer}
        />
      );
    case "eyevinn":
      return (
        <SingleKeySimpleSetup
          label="Eyevinn channel id"
          helperText="Free public test endpoint — treat as throwaway."
          urlPattern={(key) => `https://wht.eyevinn.technology/${key}`}
          parseFromUrl={(url) => url.match(/eyevinn\.technology\/([^/?#]+)/)?.[1] ?? ""}
          whipUrl={whipUrl}
          onWhipUrl={onWhipUrl}
          liveOn={liveOn}
          fieldClassName={fieldClassName}
          labelClassName={labelClassName}
          inputClassName={inputClassName}
          hintClassName={hintClassName}
        />
      );
    case "custom":
    default:
      return null;
  }
}

function SingleKeySimpleSetup({
  label, helperText, urlPattern, parseFromUrl, whipUrl, onWhipUrl, liveOn,
  fieldClassName, labelClassName, inputClassName, hintClassName,
  bearerLabel, onBearer,
}: {
  label: string;
  helperText: string;
  urlPattern: (key: string) => string;
  parseFromUrl: (url: string) => string;
  whipUrl: string;
  onWhipUrl: (v: string) => void;
  liveOn: boolean;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: string;
  hintClassName: string;
  bearerLabel?: string;
  onBearer?: (v: string) => void;
}) {
  // Lift the key out of whipUrl if we recognise the pattern, so when
  // the user lands on a provider with a pre-filled URL we don't blank
  // their input.
  const parsedKey = parseFromUrl(whipUrl);
  return (
    <>
      <label className={fieldClassName}>
        <span className={labelClassName}>{label}</span>
        <input
          type="text"
          className={inputClassName}
          value={parsedKey}
          onChange={(e) => {
            const key = e.target.value.trim();
            onWhipUrl(key ? urlPattern(key) : "");
          }}
          placeholder="Paste from your provider's dashboard"
          autoComplete="off"
          spellCheck={false}
          disabled={liveOn}
        />
        <p className={hintClassName}>{helperText}</p>
      </label>
      {bearerLabel && onBearer && (
        <label className={fieldClassName}>
          <span className={labelClassName}>{bearerLabel}</span>
          <input
            type="password"
            className={inputClassName}
            onChange={(e) => onBearer(e.target.value)}
            placeholder="Paste your provider's access token"
            autoComplete="off"
            spellCheck={false}
            disabled={liveOn}
          />
        </label>
      )}
    </>
  );
}

function CloudflareStreamSimpleSetup({
  whipUrl, onWhipUrl, liveOn,
  fieldClassName, labelClassName, inputClassName, hintClassName,
}: {
  whipUrl: string;
  onWhipUrl: (v: string) => void;
  liveOn: boolean;
  fieldClassName: string;
  labelClassName: string;
  inputClassName: string;
  hintClassName: string;
}) {
  // Cloudflare WebRTC ingest URL shape:
  //   https://customer-<customer-id>.cloudflarestream.com/<input-id>/webrtc/publish
  const match = whipUrl.match(/customer-([^.]+)\.cloudflarestream\.com\/([^/]+)\/webrtc\/publish/);
  const customerId = match?.[1] ?? "";
  const inputId = match?.[2] ?? "";

  const update = (nextCustomer: string, nextInput: string) => {
    const c = nextCustomer.trim();
    const i = nextInput.trim();
    if (c && i) onWhipUrl(`https://customer-${c}.cloudflarestream.com/${i}/webrtc/publish`);
    else onWhipUrl("");
  };

  return (
    <>
      <label className={fieldClassName}>
        <span className={labelClassName}>Cloudflare customer id</span>
        <input
          type="text"
          className={inputClassName}
          value={customerId}
          onChange={(e) => update(e.target.value, inputId)}
          placeholder="e.g. customer-a1b2c3"
          autoComplete="off"
          spellCheck={false}
          disabled={liveOn}
        />
        <p className={hintClassName}>From the WebRTC URL on your Cloudflare Live Input — the bit between "customer-" and ".cloudflarestream.com".</p>
      </label>
      <label className={fieldClassName}>
        <span className={labelClassName}>Cloudflare Live Input id</span>
        <input
          type="text"
          className={inputClassName}
          value={inputId}
          onChange={(e) => update(customerId, e.target.value)}
          placeholder="The long id after the customer subdomain"
          autoComplete="off"
          spellCheck={false}
          disabled={liveOn}
        />
        <p className={hintClassName}>Cloudflare → Stream → Live Inputs → click your input → WebRTC URL.</p>
      </label>
    </>
  );
}
