/**
 * VideoEvpCaptureTile — back-camera video + synchronized microphone audio,
 * recorded into a single audit-chained media asset. This is the "session
 * reel" the user asked for: when something happens you tap once, the
 * phone captures what you saw AND what was heard on the same timeline.
 *
 * Pipeline:
 *   getUserMedia({ video: env-facing, audio: true })
 *     → live <video> preview
 *     → MediaRecorder (video/webm; codecs=vp9,opus, or whatever the
 *       browser allows)
 *     → on stop: hash the Blob (SHA-256)
 *     → write OPFS at media/<investigationId>/reel-<ts>-<sha8>.webm
 *     → registerMedia ('video') + recordEvent ('video.reel_capture')
 *       + appendAuditEntry — same shape EvpRecorderControl uses for
 *       audio, so EvpReview / Evidence Brief pick it up.
 *
 * No re-encoding. No transcoding. Everything stays on device until the
 * operator explicitly opts in to cloud sync.
 *
 * Reviewer can later open the resulting media asset in EvpEditor (audio
 * track) and feed it to the deep-AI EVP review pass — the video is the
 * provenance, the audio is the evidence.
 */

import { useEffect, useRef, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent, registerMedia } from "../lib/db/repo";
import { writeBytes } from "../lib/opfs";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import s from "./VideoEvpCaptureTile.module.css";

interface Props {
  investigationId: string | null;
  sessionRunning: boolean;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* old browsers */ }
  }
  return undefined;
}

function extensionFor(mime: string | undefined): string {
  if (!mime) return "webm";
  if (mime.startsWith("video/mp4")) return "mp4";
  return "webm";
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export function VideoEvpCaptureTile({ investigationId, sessionRunning }: Props) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const tickHandleRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<"idle" | "armed" | "recording" | "saving" | "saved">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Cleanup on unmount — stop tracks and the recorder.
  useEffect(() => {
    return () => {
      if (tickHandleRef.current != null) window.clearInterval(tickHandleRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try { recorderRef.current.stop(); } catch { /* best-effort */ }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const arm = async () => {
    setErr(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErr("Camera/microphone APIs unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => { /* muted preview, autoplay-safe */ });
      }
      setPhase("armed");
    } catch (e) {
      const name = (e as Error & { name?: string }).name;
      setErr(
        name === "NotAllowedError" ? "Camera/microphone permission denied. Allow it in site settings."
        : name === "NotFoundError" ? "No back camera or microphone found."
        : name === "NotReadableError" ? "Camera or mic is busy in another app."
        : (e as Error).message || "Could not access camera/mic.",
      );
    }
  };

  const disarm = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setPhase("idle");
  };

  const startRecording = () => {
    if (!streamRef.current || !investigationId) return;
    const mime = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(streamRef.current, { mimeType: mime, videoBitsPerSecond: 2_500_000 }) : new MediaRecorder(streamRef.current);
    } catch (e) {
      setErr(`Could not start recorder: ${(e as Error).message}`);
      return;
    }
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onerror = (e) => setErr(`Recorder error: ${(e as ErrorEvent).message ?? "unknown"}`);
    rec.start(1000); // 1s chunks — gives us a partial buffer if anything crashes mid-take
    startedAtRef.current = Date.now();
    setElapsed(0);
    tickHandleRef.current = window.setInterval(() => {
      if (startedAtRef.current) setElapsed((Date.now() - startedAtRef.current) / 1000);
    }, 250);
    setPhase("recording");
    setSavedMsg(null);
  };

  const stopRecording = async () => {
    const rec = recorderRef.current;
    if (!rec || !investigationId) return;
    if (tickHandleRef.current != null) {
      window.clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
    setPhase("saving");
    const stopPromise = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    try { rec.stop(); } catch { /* already inactive */ }
    await stopPromise;
    const durationSeconds = startedAtRef.current ? (Date.now() - startedAtRef.current) / 1000 : 0;
    startedAtRef.current = null;
    const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
    chunksRef.current = [];

    try {
      const buf = await blob.arrayBuffer();
      const sha = await sha256HexBytes(buf);
      const ts = Date.now();
      const ext = extensionFor(rec.mimeType);
      const path = `media/${investigationId}/reel-${ts}-${sha.slice(0, 8)}.${ext}`;
      await writeBytes(path, buf);
      const asset = await registerMedia({
        investigation_id: investigationId,
        media_type: "video",
        file_path: path,
        timestamp_start: new Date(ts - durationSeconds * 1000).toISOString(),
        timestamp_end: new Date(ts).toISOString(),
        checksum_sha256: sha,
        metadata: {
          source: "video_evp_reel",
          mime: rec.mimeType,
          duration_s: durationSeconds,
          bytes: buf.byteLength,
          /* Video bitrate hint we asked the recorder for — actual bitrate
           * varies by codec and browser. Reviewers can re-derive from
           * file size / duration for the receipt. */
          target_video_bps: 2_500_000,
        },
      });
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "video.reel_capture",
        title: "Video + EVP reel captured",
        description: `${formatDuration(durationSeconds)} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`,
        linked_file: path,
        metadata: { sha256: sha, file_path: path, bytes: buf.byteLength, duration_s: durationSeconds, mime: rec.mimeType, source_asset_id: asset.id },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "video.reel.saved",
        payload: { investigation_id: investigationId, ts, sha256: sha, bytes: buf.byteLength, duration_s: durationSeconds, file_path: path, mime: rec.mimeType },
      });
      setSavedMsg(`Saved · ${formatDuration(durationSeconds)} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);
      setPhase("saved");
      // Stay armed so the operator can immediately record another reel —
      // the preview keeps running. Tap "stop camera" to release the
      // stream, or "Record" again to start a fresh take.
    } catch (e) {
      setErr(`Save failed: ${(e as Error).message}`);
      setPhase("armed");
    } finally {
      // Drop the recorder reference; the stream stays alive in `armed`.
      recorderRef.current = null;
    }
  };

  const disabled = !investigationId;

  return (
    <section className={s.wrap} aria-label="Video + EVP session reel">
      <header className={s.head}>
        <span className={s.eyebrow}>VIDEO + EVP REEL</span>
        <span className={s.sub}>Back camera + mic, audit-chained</span>
      </header>

      <div className={s.previewBox}>
        <video
          ref={previewRef}
          className={s.preview}
          playsInline
          muted
          aria-hidden={phase === "idle"}
        />
        {phase === "idle" && (
          <div className={s.previewIdle}>Preview off · arm the rig to enable</div>
        )}
        {phase === "recording" && (
          <div className={s.recBadge}>
            <span className={s.recDot} aria-hidden="true" />
            REC · {formatDuration(elapsed)}
          </div>
        )}
      </div>

      <div className={s.actions}>
        {phase === "idle" && (
          <button type="button" className={`btn btn-primary ${s.btn}`} disabled={disabled} onClick={arm}>
            Arm rig (open camera + mic)
          </button>
        )}
        {(phase === "armed" || phase === "saved") && (
          <>
            <button type="button" className={`btn btn-danger ${s.btn}`} disabled={!sessionRunning} onClick={startRecording}>
              {sessionRunning ? "Record reel" : "Begin a session first"}
            </button>
            <button type="button" className={`btn btn-ghost ${s.btnGhost}`} onClick={disarm}>
              Release camera
            </button>
          </>
        )}
        {phase === "recording" && (
          <button type="button" className={`btn btn-primary ${s.btn}`} onClick={stopRecording}>
            Stop & save reel
          </button>
        )}
        {phase === "saving" && (
          <button type="button" className={`btn btn-primary ${s.btn}`} disabled>
            Hashing & saving…
          </button>
        )}
      </div>

      {savedMsg && phase === "saved" && (
        <p className={s.status}>{savedMsg}</p>
      )}
      {err && <p className={s.error}>{err}</p>}
      {!investigationId && (
        <p className={s.hint}>Begin a session to enable reel capture.</p>
      )}
    </section>
  );
}
