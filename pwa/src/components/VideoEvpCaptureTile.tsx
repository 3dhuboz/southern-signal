/**
 * VideoEvpCaptureTile — back-camera video + synchronized microphone
 * audio, **with TV-grade sensor overlays composited onto the recording**.
 *
 * Pipeline (mirrors LiveStreamView's broadcast path so the recorded
 * file looks identical to what would have gone live):
 *
 *   getUserMedia(video back-facing + mic)
 *         │
 *         ├── hidden <video>  ──┐
 *         │                     ├── canvasCompositor (30 fps)
 *         │                     │       overlays: timestamp, REC,
 *         │   live sensor /     │       venue, posterior, EMF µT,
 *         │   posterior props ──┘       audio RMS, narrator caption
 *         │                     │
 *         │                     └── canvas.captureStream() ─┐
 *         │                                                  │
 *         └── original mic audio track ──────────────────────┤
 *                                                            ▼
 *                                                  MediaStream (outgoing)
 *                                                         │
 *                                                         ├── visible preview <video>
 *                                                         └── MediaRecorder → OPFS
 *
 * Result: the saved WebM has the overlays burned into the pixels — same
 * "broadcast-look" output the operator would push to YouTube Live. The
 * audit-chain entry stays identical to the previous (overlay-less) clip
 * shape so downstream tooling (EvpEditor, EvidenceBrief) doesn't change.
 */

import { useEffect, useRef, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent, registerMedia } from "../lib/db/repo";
import { writeBytes } from "../lib/opfs";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import { createCanvasCompositor, type CanvasCompositor, type OverlayState } from "../lib/media/canvasCompositor";
import { describeActivity } from "../lib/posterior/plainEnglish";
import s from "./VideoEvpCaptureTile.module.css";

interface Props {
  investigationId: string | null;
  sessionRunning: boolean;
  /** Venue name shown in the top-right overlay strip. */
  caseTitle: string | null;
  /** Compact case id for the corner stamp (audit traceability). */
  caseId: string | null;
  /** Current site posterior (0..1). Drives the activity-band band glow. */
  posterior: number;
  /** Live mic RMS (0..1). Renders as the bottom-bar audio meter. */
  audioRms: number;
  /** Live sector reading from the FFT analyser. */
  sector: string | null;
  /** Sector coherence 0..1. */
  coherence: number;
  /** Narrator one-liner caption to subtitle the recording with. */
  caption?: string | null;
  /** Live magnetometer reading in microteslas, for the EMF strip. */
  magnetometerUt?: number;
  /** Live light reading in lux. */
  lightLux?: number;
  /** Live motion magnitude in m/s². */
  motionMs2?: number;
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

export function VideoEvpCaptureTile(props: Props) {
  const {
    investigationId, sessionRunning,
    caseTitle, caseId, posterior, audioRms, sector, coherence, caption,
    magnetometerUt, lightLux, motionMs2,
  } = props;

  // Hidden source video — receives the raw camera MediaStream.
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  // Visible preview — receives the composited (overlay-baked) MediaStream
  // so the operator sees exactly what the recording captures.
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const compositorStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const tickHandleRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<"idle" | "armed" | "recording" | "saving" | "saved">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Keep the latest overlay state in a ref so the compositor's
  // getOverlay() picks up live sensor values without re-creating the
  // compositor on every render. Identical pattern to LiveStreamView.
  const overlayStateRef = useRef<OverlayState>({
    isoTimestamp: new Date().toISOString(),
    posterior: 0,
    activityLabel: "Calm",
    activityBand: "calm",
    sector: null,
    coherence: 0,
    audioRms: 0,
    recording: false,
    liveStreaming: false,
  });

  useEffect(() => {
    const activity = describeActivity(posterior);
    const sensors: NonNullable<OverlayState["sensors"]> = {};
    if (typeof lightLux === "number" && Number.isFinite(lightLux)) sensors.light = lightLux;
    if (typeof magnetometerUt === "number" && Number.isFinite(magnetometerUt)) sensors.magnetometer = magnetometerUt;
    if (typeof motionMs2 === "number" && Number.isFinite(motionMs2)) sensors.motion = motionMs2;
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
      // recording / liveStreaming flags below are kept fresh by phase
      // changes (separate effect) so the REC dot blinks on the canvas.
      recording: phase === "recording",
      liveStreaming: false,
      sensors: hasAnySensor ? sensors : undefined,
    };
  }, [caseId, caseTitle, posterior, audioRms, sector, coherence, caption, magnetometerUt, lightLux, motionMs2, phase]);

  // Cleanup on unmount — stop tracks, recorder, compositor.
  useEffect(() => {
    return () => {
      if (tickHandleRef.current != null) window.clearInterval(tickHandleRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try { recorderRef.current.stop(); } catch { /* best-effort */ }
      }
      compositorRef.current?.stop();
      compositorRef.current = null;
      compositorStreamRef.current?.getTracks().forEach((t) => t.stop());
      compositorStreamRef.current = null;
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

      const sourceV = sourceVideoRef.current;
      if (sourceV) {
        sourceV.srcObject = stream;
        await sourceV.play().catch(() => { /* user may need to tap */ });
      }

      // Build the compositor — paints overlays onto an off-screen canvas
      // at 30 fps. captureStream() yields the composited video track.
      if (sourceV) {
        const compositor = createCanvasCompositor({
          video: sourceV,
          // Stamp the timestamp on every frame so it ticks during quiet
          // scenes too — never re-anchored to the watched-prop effect.
          getOverlay: () => ({ ...overlayStateRef.current, isoTimestamp: new Date().toISOString() }),
          fps: 30,
        });
        compositorRef.current = compositor;
        compositor.start();

        // Outgoing stream = composited video + original microphone audio.
        const compositedVideoStream = compositor.captureStream();
        const audioTracks = stream.getAudioTracks();
        const outgoing = new MediaStream([
          ...compositedVideoStream.getVideoTracks(),
          ...audioTracks,
        ]);
        compositorStreamRef.current = outgoing;

        // Show the composite as the preview — what you see is what the
        // recording captures and what YouTube would see if pushed live.
        const previewV = previewVideoRef.current;
        if (previewV) {
          previewV.srcObject = outgoing;
          previewV.muted = true;
          await previewV.play().catch(() => { /* ignore */ });
        }
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
    compositorRef.current?.stop();
    compositorRef.current = null;
    compositorStreamRef.current?.getTracks().forEach((t) => t.stop());
    compositorStreamRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
    if (sourceVideoRef.current) sourceVideoRef.current.srcObject = null;
    setPhase("idle");
  };

  const startRecording = () => {
    const outgoing = compositorStreamRef.current;
    if (!outgoing || !investigationId) return;
    const mime = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(outgoing, { mimeType: mime, videoBitsPerSecond: 2_500_000 }) : new MediaRecorder(outgoing);
    } catch (e) {
      setErr(`Could not start recorder: ${(e as Error).message}`);
      return;
    }
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onerror = (e) => setErr(`Recorder error: ${(e as ErrorEvent).message ?? "unknown"}`);
    rec.start(1000); // 1s chunks — partial buffer survives a mid-take crash
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
          target_video_bps: 2_500_000,
          /* Burned-in overlays. Marker for downstream tooling so a
           * reviewer / Evidence Brief knows the pixels include the
           * sensor strip + REC stamp + venue label. */
          overlays: "burned-in",
        },
      });
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "video.reel_capture",
        title: "Video + EVP reel captured",
        description: `${formatDuration(durationSeconds)} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB · overlays burned-in`,
        linked_file: path,
        metadata: { sha256: sha, file_path: path, bytes: buf.byteLength, duration_s: durationSeconds, mime: rec.mimeType, source_asset_id: asset.id, overlays: "burned-in" },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "video.reel.saved",
        payload: { investigation_id: investigationId, ts, sha256: sha, bytes: buf.byteLength, duration_s: durationSeconds, file_path: path, mime: rec.mimeType, overlays: "burned-in" },
      });
      setSavedMsg(`Saved · ${formatDuration(durationSeconds)} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB · overlays in pixels`);
      setPhase("saved");
    } catch (e) {
      setErr(`Save failed: ${(e as Error).message}`);
      setPhase("armed");
    } finally {
      recorderRef.current = null;
    }
  };

  const disabled = !investigationId;

  return (
    <section className={s.wrap} aria-label="Video + EVP session reel">
      <header className={s.head}>
        <span className={s.eyebrow}>VIDEO + EVP REEL · OVERLAYS</span>
        <span className={s.sub}>Sensor strip baked into the pixels — broadcast-ready</span>
      </header>

      <div className={s.previewBox}>
        {/* Hidden source — never displayed; feeds the compositor. */}
        <video
          ref={sourceVideoRef}
          className={s.hiddenSource}
          playsInline
          muted
          aria-hidden="true"
        />
        {/* Visible preview — shows the composited stream with overlays. */}
        <video
          ref={previewVideoRef}
          className={s.preview}
          playsInline
          muted
          aria-hidden={phase === "idle"}
        />
        {phase === "idle" && (
          <div className={s.previewIdle}>
            Preview off · arm the rig to enable<br />
            <span className={s.previewIdleSub}>
              When armed, the preview shows the recording with timestamp,
              EMF µT, audio RMS, posterior + venue overlays baked in.
            </span>
          </div>
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
