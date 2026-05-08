/**
 * CameraCapture — tap to open the rear camera, tap shutter to snap a
 * still. Photos are written to OPFS, hashed, and registered in
 * media_assets so they appear in Review and the manifest. A "low-light
 * boost" toggle applies a CSS filter (preview-only) for visibility in
 * dark fieldwork — it does NOT alter the saved frame.
 *
 * Honest framing: this captures scene snapshots. It is NOT thermal,
 * spectral, or "spirit" imaging. The point is a hash-chained record of
 * what the room looked like at a tagged moment.
 *
 * Motion auto-snap: when enabled, samples frames every 800ms, computes
 * a luminance-delta against the rolling baseline, and auto-snaps when
 * the delta crosses a threshold. Each auto-snap also fires a marker
 * event so the moment is in the chain.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { writeBytes } from "../lib/opfs";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./CameraCapture.module.css";

interface CameraCaptureProps {
  investigationId: string | null;
  running: boolean;
}

const MOTION_INTERVAL_MS = 800;
const MOTION_DELTA_THRESHOLD = 16; // average per-pixel luminance delta (0-255)
const MOTION_COOLDOWN_MS = 4000;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function CameraCapture({ investigationId, running }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionPrevRef = useRef<Uint8ClampedArray | null>(null);
  const motionTimerRef = useRef<number | null>(null);
  const lastMotionSnapTsRef = useRef<number>(0);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamOn = stream != null;
  const [busy, setBusy] = useState(false);
  const [boost, setBoost] = useState(false);
  const [motionMode, setMotionMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestThumb, setLatestThumb] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);

  const start = useCallback(async () => {
    if (stream || busy) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser doesn't expose a camera API. HTTPS is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      setStream(s);
    } catch (err) {
      const e = err as Error & { name?: string };
      console.error("CameraCapture getUserMedia failed:", e);
      const msg =
        e.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings."
        : e.name === "NotFoundError" ? "No camera found on this device."
        : e.name === "NotReadableError" ? "Camera is busy in another app or tab."
        : (e.message || "Camera unavailable");
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [stream, busy]);

  const stop = useCallback(() => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const v = videoRef.current;
    if (v) v.srcObject = null;
    setStream(null);
    setMotionMode(false);
    if (motionTimerRef.current != null) {
      window.clearInterval(motionTimerRef.current);
      motionTimerRef.current = null;
    }
    motionPrevRef.current = null;
  }, [stream]);

  // Attach stream once video element mounts.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    const playPromise = v.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        console.warn("CameraCapture video.play() rejected:", err);
      });
    }
  }, [stream]);

  const captureFrameBlob = useCallback(async (): Promise<{ blob: Blob; thumbDataUrl: string } | null> => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return null;
    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9));
    if (!blob) return null;
    // Build a small thumbnail data URL (256-wide).
    const thumbW = 256;
    const thumbH = Math.round((canvas.height / canvas.width) * thumbW);
    const tCanvas = document.createElement("canvas");
    tCanvas.width = thumbW;
    tCanvas.height = thumbH;
    tCanvas.getContext("2d")?.drawImage(v, 0, 0, thumbW, thumbH);
    const thumbDataUrl = tCanvas.toDataURL("image/jpeg", 0.7);
    return { blob, thumbDataUrl };
  }, []);

  const persistFrame = useCallback(async (blob: Blob, thumbDataUrl: string, source: "user" | "motion"): Promise<void> => {
    if (!investigationId) return;
    const buf = await blob.arrayBuffer();
    const sha = await sha256Hex(buf);
    const ts = Date.now();
    const filePath = `media/${investigationId}/photo-${ts}-${sha.slice(0, 8)}.jpg`;
    await writeBytes(filePath, buf);
    await registerMedia({
      investigation_id: investigationId,
      media_type: "image",
      file_path: filePath,
      timestamp_start: new Date(ts).toISOString(),
      checksum_sha256: sha,
      metadata: { source, bytes: blob.size },
    });
    await recordEvent({
      investigation_id: investigationId,
      source: source === "motion" ? "sensor" : "user",
      event_type: source === "motion" ? "camera.motion_snap" : "camera.snap",
      title: source === "motion" ? "Camera auto-snap (motion)" : "Photo captured",
      metadata: { sha256: sha, file_path: filePath },
    });
    await appendAuditEntry({
      actor: source === "motion" ? "sensor" : "user",
      kind: "camera.capture",
      payload: { investigation_id: investigationId, ts, sha256: sha, source },
    });
    setLatestThumb(thumbDataUrl);
    setPhotoCount((n) => n + 1);
  }, [investigationId]);

  const handleSnap = useCallback(async () => {
    const captured = await captureFrameBlob();
    if (!captured) return;
    try { navigator.vibrate?.(20); } catch { /* ignore */ }
    await persistFrame(captured.blob, captured.thumbDataUrl, "user");
  }, [captureFrameBlob, persistFrame]);

  // Motion detection loop.
  useEffect(() => {
    if (motionTimerRef.current != null) {
      window.clearInterval(motionTimerRef.current);
      motionTimerRef.current = null;
    }
    motionPrevRef.current = null;
    if (!motionMode || !streamOn) return;

    motionTimerRef.current = window.setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.videoWidth === 0) return;
      const small = document.createElement("canvas");
      const w = 64;
      const h = 36;
      small.width = w;
      small.height = h;
      const ctx = small.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      // luminance only (Rec. 601)
      const lum = new Uint8ClampedArray(w * h);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        lum[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      }
      const prev = motionPrevRef.current;
      motionPrevRef.current = lum;
      if (!prev) return;
      let total = 0;
      for (let i = 0; i < lum.length; i++) {
        const d = lum[i] - prev[i];
        total += d < 0 ? -d : d;
      }
      const avg = total / lum.length;
      const now = Date.now();
      if (avg >= MOTION_DELTA_THRESHOLD && now - lastMotionSnapTsRef.current > MOTION_COOLDOWN_MS) {
        lastMotionSnapTsRef.current = now;
        const captured = await captureFrameBlob();
        if (captured) await persistFrame(captured.blob, captured.thumbDataUrl, "motion");
      }
    }, MOTION_INTERVAL_MS);

    return () => {
      if (motionTimerRef.current != null) {
        window.clearInterval(motionTimerRef.current);
        motionTimerRef.current = null;
      }
    };
  }, [motionMode, streamOn, captureFrameBlob, persistFrame]);

  // Cleanup on unmount.
  useEffect(() => stop, [stop]);

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}>CAMERA</span>
        <span className={s.note}>Scene snapshots — not thermal, not spirit imaging.</span>
      </header>

      {!streamOn && !error && (
        <button
          type="button"
          className={s.openButton}
          onClick={start}
          disabled={busy || !investigationId}
        >
          <span className={s.openIcon} aria-hidden="true">📷</span>
          <span className={s.openLabel}>{busy ? "Opening camera…" : investigationId ? "Open camera" : "Begin a session first"}</span>
          <span className={s.openHint}>Captures hash-chained still photos to the case file.</span>
        </button>
      )}

      {error && (
        <div className={s.error}>
          <strong>Camera unavailable.</strong> {error}
          <button type="button" className={s.errorRetry} onClick={start}>Try again</button>
        </div>
      )}

      {streamOn && (
        <>
          <div className={s.stage}>
            <video
              ref={videoRef}
              className={`${s.video} ${boost ? s.boost : ""}`.trim()}
              playsInline
              muted
            />
            <canvas ref={canvasRef} className={s.hiddenCanvas} aria-hidden="true" />
            {photoCount > 0 && (
              <span className={s.shotCounter} aria-live="polite">{photoCount} saved</span>
            )}
          </div>
          <div className={s.controls}>
            <button
              type="button"
              className={s.shutter}
              onClick={handleSnap}
              disabled={!investigationId}
              aria-label="Take photo"
            >
              <span className={s.shutterRing} aria-hidden="true" />
            </button>
            <div className={s.sideControls}>
              <label className={s.switch}>
                <input type="checkbox" checked={boost} onChange={(e) => setBoost(e.target.checked)} />
                <span>Low-light boost</span>
              </label>
              <label className={s.switch}>
                <input type="checkbox" checked={motionMode} onChange={(e) => setMotionMode(e.target.checked)} disabled={!running} />
                <span>{running ? "Motion auto-snap" : "Motion auto-snap (start session)"}</span>
              </label>
              <button type="button" className={s.closeButton} onClick={stop}>Close camera</button>
            </div>
          </div>
          {latestThumb && (
            <div className={s.thumbRow}>
              <img className={s.thumb} src={latestThumb} alt="Most recent capture" />
              <span className={s.thumbCaption}>Most recent capture · saved to the case file</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
