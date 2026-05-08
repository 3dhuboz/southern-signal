/**
 * LiveARView — full-bleed camera with live sensor overlays:
 *
 *   • Floating direction arrow that follows the current sound sector,
 *     positioned around the screen edge.
 *   • Edge gradient glow that intensifies with the activity posterior.
 *   • Activity halo + pulse around the shutter.
 *   • Floating caption strip (AI narration) at the bottom.
 *   • Auto-snap when the activity crosses a threshold (cooldown 6s).
 *   • Manual shutter, low-light boost, hash-chained capture (same path
 *     as CameraCapture — JPEG → OPFS → media_assets → audit).
 *
 * This is the visible "groundbreaking" element of the app: see the
 * room with the sensors painted on top.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { writeBytes } from "../lib/opfs";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { describeActivity } from "../lib/posterior/plainEnglish";
import s from "./LiveARView.module.css";

interface LiveARViewProps {
  investigationId: string | null;
  running: boolean;
  posterior: number;
  audioRms: number;
  sector: string | null;
  coherence: number;
  /** Optional caption shown at the bottom — driven by AI narrator. */
  caption?: string | null;
}

const SECTOR_DEG: Record<string, number> = {
  "FRONT-L": 300,
  "FRONT-C": 0,
  "FRONT-R": 60,
  "REAR-R": 120,
  "REAR-C": 180,
  "REAR-L": 240,
};

const ACTIVITY_AUTO_SNAP_THRESHOLD = 0.75;
const AUTO_SNAP_COOLDOWN_MS = 6000;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function LiveARView({ investigationId, running, posterior, audioRms, sector, coherence, caption }: LiveARViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastAutoSnapRef = useRef<number>(0);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamOn = stream != null;
  const [busy, setBusy] = useState(false);
  const [boost, setBoost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSnap, setRecentSnap] = useState<string | null>(null);
  const [snapCount, setSnapCount] = useState(0);
  const [autoSnapEnabled, setAutoSnapEnabled] = useState(true);

  const activity = describeActivity(posterior);

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
        // Prefer rear camera at high res.
        s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch {
        // Fallback: any camera, any size (desktops, laptops).
        s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      setStream(s);
    } catch (err) {
      const e = err as Error & { name?: string };
      console.error("LiveARView getUserMedia failed:", e);
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
  }, [stream]);

  // Attach stream to video once both exist. Order-independent — the video
  // element only mounts when streamOn flips true after stream is set.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    const playPromise = v.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        console.warn("LiveARView video.play() rejected:", err);
        setError("Playback couldn't start. Tap the camera again.");
      });
    }
  }, [stream]);

  const captureBlob = useCallback(async (): Promise<{ blob: Blob; thumb: string } | null> => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return null;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.9));
    if (!blob) return null;
    const thumb = canvas.toDataURL("image/jpeg", 0.55);
    return { blob, thumb };
  }, []);

  const persist = useCallback(async (blob: Blob, thumb: string, kind: "user" | "auto"): Promise<void> => {
    if (!investigationId) return;
    const buf = await blob.arrayBuffer();
    const sha = await sha256Hex(buf);
    const ts = Date.now();
    const filePath = `media/${investigationId}/ar-${ts}-${sha.slice(0, 8)}.jpg`;
    await writeBytes(filePath, buf);
    await registerMedia({
      investigation_id: investigationId,
      media_type: "image",
      file_path: filePath,
      timestamp_start: new Date(ts).toISOString(),
      checksum_sha256: sha,
      metadata: { source: kind === "auto" ? "ar.activity_auto" : "ar.user", bytes: blob.size, posterior, sector },
    });
    await recordEvent({
      investigation_id: investigationId,
      source: kind === "auto" ? "sensor" : "user",
      event_type: kind === "auto" ? "ar.activity_snap" : "ar.snap",
      title: kind === "auto" ? "AR auto-snap (activity surge)" : "AR photo",
      metadata: { sha256: sha, file_path: filePath, posterior, sector, coherence },
    });
    await appendAuditEntry({
      actor: kind === "auto" ? "sensor" : "user",
      kind: "ar.capture",
      payload: { investigation_id: investigationId, ts, sha256: sha, kind, posterior, sector },
    });
    setRecentSnap(thumb);
    setSnapCount((n) => n + 1);
  }, [investigationId, posterior, sector, coherence]);

  const handleManualSnap = useCallback(async () => {
    const cap = await captureBlob();
    if (!cap) return;
    try { navigator.vibrate?.(20); } catch { /* ignore */ }
    await persist(cap.blob, cap.thumb, "user");
  }, [captureBlob, persist]);

  // Auto-snap on activity threshold crossings.
  useEffect(() => {
    if (!streamOn || !running || !autoSnapEnabled) return;
    if (posterior < ACTIVITY_AUTO_SNAP_THRESHOLD) return;
    const now = Date.now();
    if (now - lastAutoSnapRef.current < AUTO_SNAP_COOLDOWN_MS) return;
    lastAutoSnapRef.current = now;
    void (async () => {
      const cap = await captureBlob();
      if (cap) await persist(cap.blob, cap.thumb, "auto");
    })();
  }, [posterior, streamOn, running, autoSnapEnabled, captureBlob, persist]);

  // Cleanup on unmount.
  useEffect(() => stop, [stop]);

  // Compute arrow position on the edge of the stage based on sector.
  const arrowAngle = sector ? SECTOR_DEG[sector] ?? null : null;
  const arrowVisible = arrowAngle != null && coherence >= 0.5;

  // Audio pulse — small radius increase + edge alpha tied to RMS.
  const rmsBoost = Math.max(0, Math.min(1, audioRms * 6));

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}>LIVE AR VIEW</span>
        <span className={s.note}>The room with the sensors painted on top.</span>
      </header>

      {!streamOn && !error && (
        <button
          type="button"
          className={s.openButton}
          onClick={start}
          disabled={busy || !investigationId}
        >
          <span className={s.openIcon} aria-hidden="true">📡</span>
          <span className={s.openLabel}>{busy ? "Opening camera…" : investigationId ? "Open AR view" : "Begin a session first"}</span>
          <span className={s.openHint}>See sound direction, activity, and live captions on the scene.</span>
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
          <div
            className={`${s.stage} ${s[`band_${activity.id}`]}`}
            style={{ "--rms": rmsBoost } as React.CSSProperties}
          >
            <video
              ref={videoRef}
              className={`${s.video} ${boost ? s.boost : ""}`.trim()}
              playsInline
              muted
            />
            {/* Edge gradient glow — coloured by activity band */}
            <div className={s.edgeGlow} aria-hidden="true" />
            {/* Top HUD strip */}
            <div className={s.hudTop}>
              <span className={s.hudActivity}>{activity.label.toUpperCase()}</span>
              <span className={s.hudPosterior}>P {(posterior * 100).toFixed(0)}%</span>
              {snapCount > 0 && <span className={s.hudCount}>{snapCount} CAPTURED</span>}
            </div>
            {/* Direction arrow — anchored to a circle around the centre */}
            {arrowVisible && (
              <DirectionArrow angleDeg={arrowAngle!} sector={sector!} coherence={coherence} />
            )}
            {/* Floating AI caption */}
            {caption && (
              <div className={s.caption} role="status" aria-live="polite">
                <span className={s.captionDot} aria-hidden="true" />
                <span className={s.captionText}>{caption}</span>
              </div>
            )}
            {/* Activity ring — encircles the shutter zone */}
            <div className={s.activityRingWrap} aria-hidden="true">
              <div className={s.activityRing} style={{ transform: `scale(${1 + posterior * 0.25})`, opacity: 0.45 + posterior * 0.55 }} />
            </div>
          </div>

          <div className={s.controls}>
            <button type="button" className={s.shutter} onClick={handleManualSnap} aria-label="Capture frame">
              <span className={s.shutterRing} aria-hidden="true" />
            </button>
            <div className={s.sideControls}>
              <label className={s.switch}>
                <input type="checkbox" checked={autoSnapEnabled} onChange={(e) => setAutoSnapEnabled(e.target.checked)} />
                <span>Auto-snap on activity surge</span>
              </label>
              <label className={s.switch}>
                <input type="checkbox" checked={boost} onChange={(e) => setBoost(e.target.checked)} />
                <span>Low-light boost</span>
              </label>
              <button type="button" className={s.closeButton} onClick={stop}>Close camera</button>
            </div>
          </div>

          {recentSnap && (
            <div className={s.thumbRow}>
              <img className={s.thumb} src={recentSnap} alt="Most recent capture" />
              <span className={s.thumbCaption}>Most recent capture · saved with hash + sensor state</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DirectionArrow({ angleDeg, sector, coherence }: { angleDeg: number; sector: string; coherence: number }) {
  // Place the arrow at 38% radius from centre, pointing outward along angleDeg.
  // angleDeg: 0 = front-centre (top), 90 = right, 180 = bottom, 270 = left.
  return (
    <div
      className={s.arrowAnchor}
      style={{
        ["--ar-angle" as string]: `${angleDeg}deg`,
        ["--ar-coh" as string]: coherence.toFixed(2),
      } as React.CSSProperties}
    >
      <div className={s.arrowOrbit}>
        <div className={s.arrowBody}>
          <svg viewBox="0 0 60 80" className={s.arrowSvg} aria-hidden="true">
            <defs>
              <linearGradient id="ssArrowFill" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="var(--accent-strong, #5DF2C7)" />
                <stop offset="100%" stopColor="var(--accent-soft, #2BA386)" />
              </linearGradient>
            </defs>
            <path d="M30 4 L52 50 L34 44 L34 76 L26 76 L26 44 L8 50 Z" fill="url(#ssArrowFill)" />
          </svg>
          <span className={s.arrowLabel}>{sector.replace("-", " ")}</span>
        </div>
      </div>
    </div>
  );
}
