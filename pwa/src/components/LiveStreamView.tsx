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

import { memo, useCallback, useEffect, useRef, useState } from "react";
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
import { useNetworkOnline } from "../lib/system/systemStatus";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import { getItcChannels } from "../lib/itc/itcChannels";
import { getItcMixer } from "../lib/audio/itcAudioMixer";
import { usePreferences } from "../lib/preferences";
import { loadOverlayChannels, saveOverlayChannels } from "../lib/media/overlayChannelStorage";
import {
  WHIP_URL_KEY, WHIP_BEARER_KEY, WHIP_PROVIDER_KEY,
  WHIP_PROVIDERS,
  type WhipProviderKey,
} from "../lib/media/whipStorage";
import s from "./LiveStreamView.module.css";

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
  cornerBrackets:  { name: "Corner brackets",    hint: "Viewfinder framing marks — broadcast cue" },
  statusPills:     { name: "REC / LIVE pills",   hint: "Centre-top status indicators" },
  kiiMeter:        { name: "K-II EMF meter",     hint: "Virtual 5-LED bar (bottom-left) driven by magnetometer" },
  remPod:          { name: "Virtual REM pod",    hint: "Animated EM proximity widget (bottom-right) with pulsing rings" },
  nightVision:     { name: "Night vision",       hint: "Green-channel IR filter — simulated NV look over the camera feed" },
  audioMeter:      { name: "Audio meter",        hint: "Gradient level bar under the REC/LIVE row — confirms mic input" },
  fullSpectrumCam: { name: "Full-spectrum (faux-IR)", hint: "False-color filter mimicking IR-modified DSLR look — NOT a real IR sensor" },
  emfGalvanometer: { name: "EMF galvanometer",   hint: "Analog needle meter — same magnetometer signal as K-II, different gear" },
  motionDetector:  { name: "PIR motion sense",   hint: "Fresnel dome + trigger LED — driven by accelerometer (not real PIR)" },
};

const CHANNEL_KEYS = Object.keys(CHANNEL_LABELS) as Array<keyof OverlayChannels>;


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
  /**
   * Raw magnetometer z-score from the EMF sensor. Passed directly to the
   * K-II virtual meter so its LEDs react to EMF spikes without Bayesian lag.
   * Optional — K-II falls back to activityBand when absent.
   */
  emfZScore?: number;
  /** Bubbles recording / live state up so the parent can reflect it in
   *  out-of-band UI (e.g. the Simple-mode broadcast CTA). */
  onStateChange?: (state: { recording: boolean; broadcasting: boolean }) => void;
  /**
   * External overlay channel state. When provided, CameraScreen (or another
   * parent) owns the channels and drives them via its own dock. The internal
   * toggle panel is hidden so the two sources don't collide.
   */
  externalChannels?: OverlayChannels;
  onExternalChannelChange?: (key: keyof OverlayChannels, value: boolean) => void;
  /**
   * Fullscreen camera-first mode. Removes card chrome (border, padding,
   * border-radius, header), makes the stage fill its container with flex: 1
   * instead of the fixed aspect-ratio, and hides the WHIP setup panel behind
   * the Record/Go-live buttons. Used by CameraScreen.
   */
  fullscreen?: boolean;
  /**
   * When provided, CameraScreen fills this ref with LiveStreamView's
   * toggleRecording callback so the dock button can drive it without
   * prop-threading state back up.
   */
  recordToggleRef?: React.MutableRefObject<(() => void) | null>;
  /** Same pattern as recordToggleRef — drives toggleLive from the dock. */
  liveToggleRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Called whenever the camera stream opens / closes, the WHIP URL changes,
   * or torch / facing hardware state changes. CameraScreen uses this to know
   * which dock buttons to show and whether they're enabled.
   */
  onCameraState?: (s: {
    streamOn: boolean;
    whipConfigured: boolean;
    torchSupported: boolean;
    torchOn: boolean;
    facingMode: "environment" | "user";
  }) => void;
  /** When provided, CameraScreen fills this ref with LiveStreamView's
   *  flipCamera callback so the dock (or a gesture) can drive it. */
  flipCameraRef?: React.MutableRefObject<(() => void) | null>;
  /** When provided, CameraScreen fills this ref with LiveStreamView's
   *  toggleTorch callback so a dock button can drive it. Only meaningful
   *  on devices where the active camera reports torch support. */
  torchToggleRef?: React.MutableRefObject<(() => void) | null>;
  /** When provided, CameraScreen fills this ref with the refocus()
   *  callback so a tap-to-focus gesture can re-trigger autofocus without
   *  reaching into the camera track directly. */
  refocusRef?: React.MutableRefObject<(() => void) | null>;
  /** Notified when the source MediaStream (camera+mic) opens or closes,
   *  with a reference to the stream itself. The VAD module attaches an
   *  AnalyserNode to the mic track via this hand-off. */
  onSourceStream?: (stream: MediaStream | null) => void;
  /**
   * Same pattern — exposes the camera-open `start` callback so CameraScreen
   * can fire it from inside the Begin button's gesture handler. The browser
   * camera permission prompt MUST originate in a user gesture; chaining the
   * open into Begin gives a one-tap flow.
   */
  startCameraRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  /**
   * Exposes a synchronous "snap a small JPEG thumbnail of the current frame"
   * callback. CameraScreen wires it into `commitMarker` so every marker drop
   * captures a 160x90 visual receipt at the exact moment the operator tapped.
   * The thumbnail flows through the audit chain via the marker's metadata, so
   * the timestamp / hash chain proves what was on screen when the moment was
   * marked. Returns null if the camera isn't open or the source video element
   * doesn't have a decodable frame yet.
   */
  snapThumbnailRef?: React.MutableRefObject<(() => string | null) | null>;
  /**
   * Scene-driven camera defaults. `defaultFacing` seeds the initial
   * facingMode at mount; `defaultTorch` requests torch-on once the camera
   * is open AND torch is supported. Both are honored once-per-mount so that
   * mid-session prop changes don't yank the camera underneath the operator
   * (e.g. flipping to selfie wouldn't auto-re-engage torch).
   */
  defaultFacing?: "environment" | "user";
  defaultTorch?: boolean;
  /**
   * Bubbles the open-state machine (idle / opening / streaming / error)
   * + the error text up to the parent so a fullscreen host (CameraScreen)
   * can render its OWN permission / starting / error fallback over a
   * solid dark backdrop. Fullscreen mode suppresses the in-component
   * error/openButton/controls chrome — see `fullscreen` prop — so the
   * parent needs this signal to surface the same UX cleanly.
   */
  onOpenStateChange?: (s: { state: "idle" | "opening" | "streaming" | "error"; error: string | null }) => void;
}

function LiveStreamViewImpl(props: LiveStreamViewProps) {
  const {
    investigationId, running, posterior, audioRms, sector, coherence, caseId, caseTitle, caption,
    lightLux, magnetometerUt, motionMs2, temperatureC, emfZScore, onStateChange,
    externalChannels, onExternalChannelChange, fullscreen,
    recordToggleRef, liveToggleRef, onCameraState,
    flipCameraRef, startCameraRef, torchToggleRef, refocusRef, onSourceStream,
    snapThumbnailRef,
    defaultFacing, defaultTorch,
    onOpenStateChange,
  } = props;

  const [prefs] = usePreferences();
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const compositorStreamRef = useRef<MediaStream | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const whipSessionRef = useRef<WhipSession | null>(null);

  const [streamOn, setStreamOn] = useState(false);
  // Headphone monitor preference — operator opts in via Setup → Broadcast.
  // Re-applied whenever the camera opens (which guarantees a user-gesture has
  // happened, so the mixer's AudioContext can unlock) AND whenever the pref
  // itself toggles. Until either of those fires, getItcMixer() may throw
  // (autoplay rejected); the catch swallows that case silently.
  useEffect(() => {
    try { getItcMixer().setMonitor(prefs.itcMonitor === true); }
    catch { /* mixer unavailable yet — picked up on next gesture */ }
  }, [prefs.itcMonitor, streamOn]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [whipUrl, setWhipUrl] = useState<string>(() => {
    try { return localStorage.getItem(WHIP_URL_KEY) ?? ""; } catch { return ""; }
  });
  const [whipBearer, setWhipBearer] = useState<string>(() => {
    try { return localStorage.getItem(WHIP_BEARER_KEY) ?? ""; } catch { return ""; }
  });
  const [whipProvider, setWhipProvider] = useState<WhipProviderKey>(() => {
    try {
      const stored = localStorage.getItem(WHIP_PROVIDER_KEY);
      if (stored && WHIP_PROVIDERS.some((p) => p.key === stored)) {
        return stored as WhipProviderKey;
      }
    } catch { /* ignore */ }
    return "custom";
  });
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [recordingsCount, setRecordingsCount] = useState(0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">(() => defaultFacing ?? "environment");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  // Pending auto-torch from the active scene. The scene's defaultTorch flag
  // can't be applied at openCamera time (torch capability isn't known until
  // detectTorchSupport probes the track), so we stash it here and let an
  // effect fire toggleTorch the moment torchSupported flips true. The ref is
  // consumed once so flips / re-opens don't repeatedly re-engage torch.
  const autoTorchPendingRef = useRef<boolean>(defaultTorch === true);
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
  // Network status — feeds the canvas OFFLINE pill (visible when recording locally
  // with no connectivity), proving the frame was captured before any cloud sync.
  const online = useNetworkOnline();

  // Timestamps for the on-canvas elapsed-time readouts that get burnt into the
  // REC / LIVE pills. Captured once on transition; cleared when the activity
  // ends. The compositor reads them every frame and computes `Date.now() - t`
  // so the timer ticks per RAF tick without React state churn.
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [liveStartedAt, setLiveStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setRecordingStartedAt(recording ? Date.now() : null);
  }, [recording]);
  useEffect(() => {
    setLiveStartedAt(liveOn ? Date.now() : null);
  }, [liveOn]);
  // Compartmentalised overlay channels. Defaults all-on; operator hides the
  // bits they don't want baked into the recording or live stream. Persists
  // across sessions so a producer's choices stick.
  // When externalChannels is provided (CameraScreen dock), use those instead.
  const [channels, setChannels] = useState<OverlayChannels>(() => loadOverlayChannels());
  const activeChannels = externalChannels ?? channels;
  useEffect(() => { saveOverlayChannels(channels); }, [channels]);

  const setChannel = useCallback((key: keyof OverlayChannels, value: boolean) => {
    if (onExternalChannelChange) { onExternalChannelChange(key, value); return; }
    setChannels((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, [onExternalChannelChange]);
  const setAllChannels = useCallback((value: boolean) => {
    setChannels(() => {
      const next = {} as OverlayChannels;
      for (const k of CHANNEL_KEYS) next[k] = value;
      return next;
    });
  }, []);
  const enabledChannelCount = CHANNEL_KEYS.reduce((n, k) => n + (activeChannels[k] ? 1 : 0), 0);

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

    // Mutate the existing ref object in place — getOverlay() returns the same
    // identity each frame, so reassigning .current would force every consumer
    // to grab a new reference. The ref is read by a single consumer (the
    // compositor's per-frame closure) on the main thread, so there's no
    // tear risk from concurrent reads.
    const overlay = overlayStateRef.current;
    overlay.caseId = caseId ?? undefined;
    overlay.caseTitle = caseTitle ?? undefined;
    overlay.isoTimestamp = new Date().toISOString();
    overlay.posterior = posterior;
    overlay.activityLabel = activity.label;
    overlay.activityBand = activity.id as OverlayState["activityBand"];
    overlay.sector = sector;
    overlay.coherence = coherence;
    overlay.caption = caption ?? null;
    overlay.audioRms = audioRms;
    overlay.recording = recording;
    overlay.liveStreaming = liveOn;
    overlay.online = online;
    overlay.recordingStartedAt = recordingStartedAt ?? undefined;
    overlay.liveStartedAt = liveStartedAt ?? undefined;
    overlay.emfZScore = (typeof emfZScore === "number" && Number.isFinite(emfZScore)) ? emfZScore : undefined;
    overlay.sensors = hasAnySensor ? sensors : undefined;
    overlay.channels = activeChannels;
  }, [posterior, audioRms, sector, coherence, caseId, caseTitle, caption, recording, liveOn, online, recordingStartedAt, liveStartedAt, lightLux, magnetometerUt, motionMs2, temperatureC, emfZScore, activeChannels]);

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

  // Tap-to-focus — re-trigger autofocus on the active camera track. The
  // pointsOfInterest API exists in the spec but isn't widely implemented;
  // single-shot autofocus is the broadly-supported fallback and visually
  // does what the operator expects ("tap = re-focus").
  const refocus = useCallback(async () => {
    const track = sourceStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (track.getCapabilities?.() ?? {}) as any;
    const modes: string[] = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    try {
      if (modes.includes("single-shot")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] as any });
      } else if (modes.includes("continuous")) {
        // Toggling continuous mode forces most implementations to re-focus.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] as any });
      }
      // Else: track doesn't expose focusMode (front cameras, laptops) —
      // silently no-op; the visual tap ring still confirms the gesture.
    } catch { /* hardware refused — ignore */ }
  }, []);

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

  // Marker thumbnail capture. Draws the latest source-video frame to a small
  // canvas (160x90, 16:9) and returns a JPEG dataUrl at quality 0.5 — large
  // enough to recognise the scene, small enough (~3-5 KB) to embed in the
  // audit chain payload without bloating the SQLite row. Returns null if the
  // camera isn't open or the video element hasn't decoded a frame yet.
  // Synchronous — operates on the already-decoded current frame — so the
  // caller can include the dataUrl directly in the marker's metadata at the
  // moment commitMarker fires.
  const snapMarkerThumbnail = useCallback((): string | null => {
    const v = sourceVideoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return null;
    const w = 160;
    const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(v, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.5);
    } catch {
      return null;
    }
  }, []);

  // Auto-torch from scene defaults — fires once when the camera comes online
  // AND torch is supported, then clears the ref so subsequent flips don't
  // re-engage it. If the active scene asked for torch but the device lacks
  // it (e.g. front camera, or no LED hardware), the request simply lapses.
  useEffect(() => {
    if (!autoTorchPendingRef.current) return;
    if (streamOn && torchSupported && !torchOn) {
      autoTorchPendingRef.current = false;
      void toggleTorch();
    }
  }, [streamOn, torchSupported, torchOn, toggleTorch]);

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
      // Mutate the ref object in place each frame and return the same identity.
      // The prop-watching useEffect below ALSO mutates the same object (rather
      // than reassigning .current to a fresh allocation) so the per-frame and
      // per-prop-change paths converge on a single OverlayState instance. At
      // 30fps that's ~510 field-copies/sec we no longer perform.
      getOverlay: () => {
        const overlay = overlayStateRef.current;
        const now = Date.now();
        overlay.nowMs = now;
        // isoTimestamp stays populated for downstream tooling (audit log,
        // recorder metadata) that consumes the ISO form, but the compositor
        // reads nowMs preferentially.
        overlay.isoTimestamp = new Date(now).toISOString();
        const store = getItcChannels();
        if (store.spiritBox || store.ovilus || store.evp) {
          const itc: NonNullable<OverlayState["itc"]> = {};
          if (store.spiritBox) itc.spiritBox = { text: store.spiritBox.text, ageMs: now - store.spiritBox.timestamp };
          if (store.ovilus)    itc.ovilus    = { text: store.ovilus.text,    ageMs: now - store.ovilus.timestamp };
          if (store.evp)       itc.evp       = { text: store.evp.text,       ageMs: now - store.evp.timestamp };
          overlay.itc = itc;
        } else {
          overlay.itc = undefined;
        }
        return overlay;
      },
      fps: 30,
    });
    compositorRef.current = compositor;
    compositor.start();

    // Build the OUTGOING stream: composited video + mic audio + ITC mixer
    // audio. The ITC mixer carries synthesised Spirit Box / Ovilus tones that
    // used to play through device speakers (where the mic re-captured them
    // as a feedback loop). Routing them through a MediaStream source instead
    // means MediaRecorder + WHIP get a clean composite while the room mic
    // only picks up the actual scene audio.
    const compositedVideoStream = compositor.captureStream();
    const audioTracks = stream.getAudioTracks();
    let itcAudioTracks: MediaStreamTrack[] = [];
    try {
      itcAudioTracks = getItcMixer().getStream().getAudioTracks();
    } catch {
      // Web Audio unavailable / autoplay rejected before any tool ran —
      // skip ITC audio tracks. Recording still works without them; the
      // ITC tools will simply produce no audio this session.
    }
    // De-duplicate by track id so a second mount (e.g. after closing the
    // camera and re-opening) doesn't add the same ITC track twice.
    const audioById = new Map<string, MediaStreamTrack>();
    for (const t of audioTracks) audioById.set(t.id, t);
    for (const t of itcAudioTracks) audioById.set(t.id, t);
    const outgoing = new MediaStream([
      ...compositedVideoStream.getVideoTracks(),
      ...audioById.values(),
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
      localStorage.setItem(WHIP_URL_KEY, whipUrl.trim());
      if (whipBearer.trim()) localStorage.setItem(WHIP_BEARER_KEY, whipBearer.trim());
      else localStorage.removeItem(WHIP_BEARER_KEY);
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

  // Fill parent-owned refs so CameraScreen can drive recording/live/flip/
  // torch/focus/start without LiveStreamView exposing its internal state.
  useEffect(() => {
    if (recordToggleRef) recordToggleRef.current = toggleRecording;
    if (liveToggleRef)   liveToggleRef.current   = toggleLive;
    if (flipCameraRef)   flipCameraRef.current   = flipCamera;
    if (torchToggleRef)  torchToggleRef.current  = toggleTorch;
    if (refocusRef)      refocusRef.current      = refocus;
    if (startCameraRef)  startCameraRef.current  = start;
    if (snapThumbnailRef) snapThumbnailRef.current = snapMarkerThumbnail;
  }, [recordToggleRef, liveToggleRef, toggleRecording, toggleLive, flipCameraRef, flipCamera, torchToggleRef, toggleTorch, refocusRef, refocus, startCameraRef, start, snapThumbnailRef, snapMarkerThumbnail]);

  // Hand the source stream to the parent so it can attach a VAD analyser to
  // the mic track. Fires once each open/close — the parent compares by ref
  // identity to avoid re-wiring on every render.
  useEffect(() => {
    if (!onSourceStream) return;
    if (streamOn && sourceStreamRef.current) onSourceStream(sourceStreamRef.current);
    else onSourceStream(null);
  }, [streamOn, onSourceStream]);

  // Notify parent when the stream opens/closes or WHIP config changes
  // so the dock buttons can show correct enabled/disabled state.
  // Derived here so the effect only fires when the boolean boundary is crossed,
  // not on every keystroke in the WHIP URL input.
  const whipConfigured = whipUrl.trim().length > 0;
  useEffect(() => {
    onCameraState?.({ streamOn, whipConfigured, torchSupported, torchOn, facingMode });
  }, [onCameraState, streamOn, whipConfigured, torchSupported, torchOn, facingMode]);

  // Bubble the open-state machine to the parent. Fullscreen hosts
  // (CameraScreen) hide LiveStreamView's own error/openButton chrome and
  // render their own permission/starting/error fallback over a solid dark
  // backdrop — they need this signal to know which to render.
  //
  // The machine is collapsed to four states:
  //   idle      — no stream, no error, not opening
  //   opening   — getUserMedia in flight (busy && !streamOn)
  //   streaming — preview is live
  //   error     — last open failed (permission denied, hardware busy, etc.)
  // `streamOn && error` shouldn't normally happen, but if it does we prefer
  // streaming so the operator sees the live feed.
  useEffect(() => {
    if (!onOpenStateChange) return;
    const state: "idle" | "opening" | "streaming" | "error" =
      streamOn ? "streaming"
      : busy ? "opening"
      : error ? "error"
      : "idle";
    onOpenStateChange({ state, error });
  }, [onOpenStateChange, streamOn, busy, error]);

  // Internal helper for the parent: dismissing the error from the parent's
  // own UI needs to reset our local error state too, otherwise the next
  // `start()` will re-evaluate against a stale error. Exposed via a ref so
  // we don't have to add yet another callback prop.
  const dismissError = useCallback(() => setError(null), []);
  // (no public ref yet — parent dismisses by re-calling start(); kept here
  // for future use if we need explicit Dismiss UX.)
  void dismissError;

  const handleProviderChange = useCallback((nextKey: WhipProviderKey) => {
    setWhipProvider(nextKey);
    try { localStorage.setItem(WHIP_PROVIDER_KEY, nextKey); } catch { /* ignore */ }
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
      try { localStorage.setItem(WHIP_URL_KEY, data.whip_url); } catch { /* ignore */ }
      setFbConnectMsg("Connected — WHIP URL above is ready. Click Go live to start broadcasting to Facebook.");
    } catch (err) {
      setFbConnectMsg(`Failed: ${(err as Error).message}`);
    } finally {
      setFbConnecting(false);
    }
  }, [fbStreamKey, fbConnectToken]);

  // Derive fullscreen variant class names once; avoids 3 repeated inline ternaries.
  const wrapCls    = fullscreen ? `${s.wrap} ${s.wrapFullscreen}` : s.wrap;
  const stageCls   = fullscreen ? `${s.stage} ${s.stageFull}` : s.stage;
  const openBtnCls = fullscreen ? `${s.openButton} ${s.openButtonFull}` : s.openButton;

  return (
    <div className={wrapCls}>
      {/* Title strip — hidden in fullscreen mode (camera IS the UI) */}
      {!fullscreen && (
        <header className={s.head}>
          <span className={s.eyebrow}>LIVE BROADCAST · TV PRODUCTION</span>
          <span className={s.note}>Camera + mic + AR overlays composited to one stream. Record + go live.</span>
        </header>
      )}

      {/* Hidden source video — feeds the compositor. */}
      <video ref={sourceVideoRef} className={s.hidden} playsInline muted />

      {/* Fullscreen mode (CameraScreen) hides the in-component openButton +
          error div + controls dock; the parent renders its own permission /
          starting / error fallback over a solid #000 backdrop AND owns the
          BIG SHUTTER + slim dock. Without this gate, those controls
          rendered in flex flow, took space from the camera stage, and the
          parent's overlays sat on top of them — see CameraScreen.tsx where
          the shutter is absolute-positioned at the same bottom region. */}
      {!fullscreen && !streamOn && !error && (
        <button
          type="button"
          className={openBtnCls}
          onClick={start}
          disabled={busy}
        >
          <span className={s.openIcon} aria-hidden="true">📡</span>
          <span className={s.openLabel}>{busy ? "Opening…" : "Open camera"}</span>
          <span className={s.openHint}>One-stream output. Record locally and/or go live with overlays.</span>
        </button>
      )}

      {!fullscreen && error && (
        <div className={s.error}>
          <strong>{error}</strong>
          <button type="button" className={s.errorRetry} onClick={() => { setError(null); }}>Dismiss</button>
        </div>
      )}

      {/* Fullscreen + no stream + no error: render the always-present stage
          shell so its #000 background covers the wrap. The parent renders the
          actual permission-prompt UI on top via onOpenStateChange. Without
          this shell, the wrap shrinks to its other content (just the hidden
          source video) and the cameraWrap behind it would show through any
          translucent HUD glass. */}
      {fullscreen && !streamOn && (
        <div className={stageCls} aria-hidden="true" />
      )}

      {streamOn && (
        <>
          <div className={stageCls}>
            <video ref={previewVideoRef} className={s.preview} playsInline muted />
            {(recording || liveOn) && (
              <div className={s.statusBadges}>
                {recording && <span className={`${s.badge} ${s.badgeRec}`}>● REC</span>}
                {liveOn && <span className={`${s.badge} ${s.badgeLive}`}>◉ LIVE</span>}
              </div>
            )}
          </div>

          {/* Inline camera controls — shown only in non-fullscreen mode.
              In fullscreen (CameraScreen), the dock owns flip and torch. */}
          {!fullscreen && (
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
          )}

          {/* Overlay channels — operator picks which baked-in elements
              show on the composite. Collapsed by default; the count tells
              them at a glance how many are on without opening it.
              Hidden when CameraScreen's external dock drives channels
              OR when we're in fullscreen camera mode (the broadcast setup
              panel lives elsewhere when the camera is the primary surface). */}
          {!fullscreen && !externalChannels && <details className={s.channels}>
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
                  const on = activeChannels[key];
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
          </details>}


          {/* In-component primary controls — Record clip / Go live / Close.
              Hidden in fullscreen camera mode where CameraScreen owns the
              BIG SHUTTER + slim dock affordances. Without this gate, these
              three buttons rendered in normal flex flow, pushed the camera
              stage upward, and the absolute-positioned shutter sat on top
              of them — the exact bug visible in the broken-Camera screenshot. */}
          {!fullscreen && <div className={s.controls}>
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
          </div>}

          {!fullscreen && (liveOn || whipState !== "idle") && (
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

          {/* WHIP broadcast setup panel — hidden in fullscreen mode. Live
              streaming configuration belongs on a dedicated setup surface,
              not crammed under the camera viewport where it competes with
              the shutter and the BroadcastSceneSelector. The non-fullscreen
              /lab Mission Control surface keeps the full setup affordance. */}
          {!fullscreen && <div className={s.live}>
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
          </div>}

          {!fullscreen && statusMsg && <p className={s.statusLine}>{statusMsg}{recordingsCount > 0 ? ` · ${recordingsCount} clips saved` : ""}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Memoised public export. The parent (CameraScreen) re-renders frequently
 * on every sensor / posterior tick (1-50 Hz) and on the 5 Hz audioRms
 * coarse copy. Without memo, this 1300+ line component re-runs end to end
 * each time. All callback props are useCallback-stable and ref props are
 * useRef-stable, so the default shallow-prop check is sufficient.
 */
export const LiveStreamView = memo(LiveStreamViewImpl);

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
