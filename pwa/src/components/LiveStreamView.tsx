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
import { createCanvasCompositor, type CanvasCompositor, type OverlayState } from "../lib/media/canvasCompositor";
import { startWhipSession, type WhipSession, type WhipState, type WhipOutboundStats } from "../lib/media/whip";
import s from "./LiveStreamView.module.css";

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
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function LiveStreamView(props: LiveStreamViewProps) {
  const { investigationId, running, posterior, audioRms, sector, coherence, caseId, caseTitle, caption } = props;

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
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [recordingsCount, setRecordingsCount] = useState(0);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [whipState, setWhipState] = useState<WhipState>("idle");
  const [whipStats, setWhipStats] = useState<WhipOutboundStats | null>(null);

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
    };
  }, [posterior, audioRms, sector, coherence, caseId, caseTitle, caption, recording, liveOn]);

  const openCamera = useCallback(async (mode: "environment" | "user"): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      // Fallback: any camera, any mic.
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
      const msg =
        e.name === "NotAllowedError" ? "Camera/mic permission was denied."
        : e.name === "NotFoundError" ? "No camera or microphone found."
        : e.name === "NotReadableError" ? "Camera or mic is busy in another app."
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
      getOverlay: () => overlayStateRef.current,
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
        const sha = await sha256Hex(buf);
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
            <p className={s.liveHint}>
              Works with any WHIP-compatible ingest: Cloudflare Stream Live, Mux, Dolby.io, Eyevinn. Output is composited camera + sensor overlays — what you record is what the audience sees, with ISO timestamps baked into every frame.
            </p>
          </div>

          {statusMsg && <p className={s.statusLine}>{statusMsg}{recordingsCount > 0 ? ` · ${recordingsCount} clips saved` : ""}</p>}
        </>
      )}
    </div>
  );
}
