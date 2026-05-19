/**
 * EvpRecorderControl — wires `EvpRecorder` to the database. Tap to start
 * a forensic-grade 16-bit / 48 kHz mono PCM capture. On stop the WAV is
 * hashed (SHA-256), written to OPFS at
 * `media/<investigationId>/evp-<ts>-<sha8>.wav`, and registered as a
 * `media_assets` row + `evidence_event` + audit-chain entry.
 *
 * Useful from anywhere a session is active — Mission Control during a
 * sweep, or the EVP view as a "capture another clip" button.
 */

import { useEffect, useRef, useState } from "react";
import { EvpRecorder, type EvpRecorderState } from "../lib/audio/evpRecorder";
import { readFile, writeBytes, deletePath } from "../lib/opfs";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { exec } from "../lib/db/db";
import { transcribeAudio, isInvestigationSensitive } from "../lib/ai/cloudTranscribe";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import { getPreferences } from "../lib/preferences";
import s from "./EvpRecorderControl.module.css";

interface Props {
  investigationId: string | null;
  onSaved?: () => void;
  variant?: "default" | "compact";
  /**
   * Scene-driven auto-start. When true, the recorder fires `handleStart`
   * once as soon as `investigationId` becomes non-null and status is idle.
   * Wired into CameraScreen via scene.evp.autoRecord so an "EVP Session"
   * scene captures the moment Begin is pressed, without the operator
   * also having to tap Start Recording.
   *
   * Per-mount latch: re-mounting (e.g. scene change between investigations)
   * arms autoStart again, but the latch prevents a single mount from
   * re-firing if the parent rerenders.
   */
  autoStart?: boolean;
  /**
   * Mirror flag — when this transitions from true → false, the recorder
   * stops + saves. Lets a session-end (running flips off) flush a clip
   * without the operator needing to remember to hit Stop. No-op when
   * false → false / status is already idle.
   */
  active?: boolean;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export function EvpRecorderControl({ investigationId, onSaved, variant = "default", autoStart = false, active }: Props) {
  const recorderRef = useRef<EvpRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new EvpRecorder();

  const [state, setState] = useState<EvpRecorderState>({ status: "idle", startedAt: null, durationSeconds: 0, error: null });
  const [savingMessage, setSavingMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [transcribeStatus, setTranscribeStatus] = useState<string | null>(null);
  // Latch so the autoStart effect doesn't refire on every render. Reset
  // when investigationId changes (new session, new clip) so the operator
  // can move between cases without losing the auto-start behaviour.
  const autoStartedRef = useRef(false);
  useEffect(() => { autoStartedRef.current = false; }, [investigationId]);

  useEffect(() => {
    return recorderRef.current!.subscribe(setState);
  }, []);

  // Preference-gated cloud Whisper transcribe. Fire-and-forget — must not
  // block the recording-save path. Skips silently when:
  //   • prefs.evp.autoTranscribe is off (default).
  //   • clip < 1 s (probably an accidental tap).
  //   • the device is offline.
  //   • the case (or device) is flagged culturally sensitive.
  // Mirrors the manual handleTranscribe flow in EvpEditor — same INSERT
  // into transcripts, same audit-entry shape.
  const maybeAutoTranscribe = async (args: {
    investigationId: string;
    asset: { id: string; file_path: string };
    wavBuffer: ArrayBuffer;
    durationSeconds: number;
  }): Promise<void> => {
    // Read preferences defensively — a corrupted blob must NOT silently
    // treat the device as non-sensitive. We refuse auto-transcribe on any
    // read failure (it's an opt-in convenience, not a critical path).
    let prefs: ReturnType<typeof getPreferences>;
    try {
      prefs = getPreferences();
    } catch {
      return;
    }
    if (!prefs.evp.autoTranscribe) return;
    if (args.durationSeconds < 1) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (prefs.globalCulturalSensitivityFlag !== false) return;

    // isInvestigationSensitive is fail-closed (DB throw / row missing →
    // returns true) so this branch refuses on any uncertainty.
    if (await isInvestigationSensitive(args.investigationId)) return;

    setTranscribeStatus("Transcribing…");
    try {
      const blob = new Blob([args.wavBuffer], { type: "audio/wav" });
      // We pass `culturallySensitive: false` here only because we just
      // verified both flags above and got `false` from each. transcribeAudio
      // -> ensureRoutable re-checks the DB row itself (belt-and-braces), so
      // a race where the operator toggles the flag mid-transcribe still
      // fails closed.
      const result = await transcribeAudio(
        blob,
        { investigationId: args.investigationId, culturallySensitive: false },
        { language: "en", filename: "evp-clip.wav" },
      );

      const transcriptId = crypto.randomUUID();
      await exec(
        `INSERT INTO transcripts (id, media_id, investigation_id, segment_start_s, segment_end_s, text, confidence, engine, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptId,
          args.asset.id,
          args.investigationId,
          0,
          args.durationSeconds,
          result.text,
          null,
          `cloud-${result.model}`,
          JSON.stringify({ segments: result.segments, language: result.language, duration: result.duration, auto: true }),
        ],
      );
      await recordEvent({
        investigation_id: args.investigationId,
        source: "ai",
        event_type: "audio.evp_transcribe",
        title: "EVP auto-transcribed",
        description: result.text.slice(0, 200),
        linked_file: args.asset.file_path,
        metadata: {
          source_media_id: args.asset.id,
          transcript_id: transcriptId,
          start_offset_s: 0,
          end_offset_s: args.durationSeconds,
          model: result.model,
          language: result.language,
          auto: true,
        },
      });
      await appendAuditEntry({
        actor: "ai",
        kind: "audio.evp.transcribe",
        payload: {
          investigation_id: args.investigationId,
          media_id: args.asset.id,
          transcript_id: transcriptId,
          model: result.model,
          start_offset_s: 0,
          end_offset_s: args.durationSeconds,
          auto: true,
        },
      });

      const preview = result.text.trim().slice(0, 60);
      const ellipsis = result.text.trim().length > 60 ? "…" : "";
      setTranscribeStatus(preview ? `Transcribed: ${preview}${ellipsis}` : "Transcribed (no speech detected)");
    } catch (err) {
      setTranscribeStatus(`Transcribe failed: ${(err as Error).message}`);
    }
  };

  const handleStart = async () => {
    if (!investigationId) {
      setLastError("Begin a session first.");
      return;
    }
    setLastError(null);
    setSavingMessage(null);
    setTranscribeStatus(null);
    const ts = Date.now();
    const tmpPath = `media/${investigationId}/_evp-pending-${ts}.wav`;
    try {
      await recorderRef.current!.start(tmpPath);
    } catch (err) {
      const e = err as Error & { name?: string };
      // AbortError / SecurityError fire on Android Chrome when a system
      // overlay (Messenger chat heads, edge panels, accessibility bubbles)
      // blocks the standard permission UI with "This site can't ask for
      // your permission". The standard "denied" copy implies user choice
      // — which isn't accurate here — so we give a hint about overlays.
      setLastError(
        e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in browser site settings."
        : e.name === "NotFoundError" ? "No microphone found."
        : e.name === "NotReadableError" ? "Microphone is busy in another app. Close other recording apps and try again."
        : e.name === "AbortError" ? "The microphone prompt was interrupted. If you saw an Android system dialog about overlays or bubbles, close other apps with floating windows and try again."
        : e.name === "SecurityError" ? "Microphone blocked by browser security. Ensure the site is loaded over HTTPS and that site permissions allow microphone."
        : (e.message || "Microphone unavailable"),
      );
    }
  };

  const handleStop = async () => {
    if (!investigationId) return;
    const result = await recorderRef.current!.stop();
    if (!result) return;
    setSavingMessage("Hashing and saving…");
    try {
      const file = await readFile(result.path);
      const buf = await file.arrayBuffer();
      const sha = await sha256HexBytes(buf);
      const ts = Date.now();
      const finalPath = `media/${investigationId}/evp-${ts}-${sha.slice(0, 8)}.wav`;
      await writeBytes(finalPath, buf);
      await deletePath(result.path).catch(() => { /* best-effort */ });

      const asset = await registerMedia({
        investigation_id: investigationId,
        media_type: "audio",
        file_path: finalPath,
        timestamp_start: new Date(ts - result.durationSeconds * 1000).toISOString(),
        timestamp_end: new Date(ts).toISOString(),
        checksum_sha256: sha,
        metadata: {
          source: "evp_recorder",
          sample_rate: result.sampleRate,
          channels: 1,
          bits_per_sample: 16,
          duration_s: result.durationSeconds,
          bytes: result.sizeBytes,
        },
      });
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "audio.evp_capture",
        title: "EVP recording captured",
        description: `${formatDuration(result.durationSeconds)} · 16-bit ${result.sampleRate / 1000} kHz mono`,
        linked_file: finalPath,
        metadata: { sha256: sha, file_path: finalPath, bytes: result.sizeBytes, duration_s: result.durationSeconds },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "audio.evp.saved",
        payload: { investigation_id: investigationId, ts, sha256: sha, bytes: result.sizeBytes, duration_s: result.durationSeconds, file_path: finalPath },
      });
      setSavingMessage(`Saved · ${formatDuration(result.durationSeconds)} · ${(result.sizeBytes / 1024).toFixed(0)} KB`);
      onSaved?.();

      // Fire-and-forget auto-transcribe — preference-gated, never blocks save.
      void maybeAutoTranscribe({
        investigationId,
        asset,
        wavBuffer: buf,
        durationSeconds: result.durationSeconds,
      });
    } catch (err) {
      setLastError(`Save failed: ${(err as Error).message}`);
      setSavingMessage(null);
    }
  };

  // Scene-driven auto-start. Fires once when investigationId becomes
  // non-null + status is idle + the parent has armed autoStart. The latch
  // resets when investigationId changes (new session / new case) so the
  // recorder picks up the next case's auto-start too. Behind both an
  // investigation-id check AND an idle-status check so re-renders never
  // double-fire start.
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (!investigationId) return;
    if (state.status !== "idle") return;
    autoStartedRef.current = true;
    void handleStart();
    // handleStart is intentionally omitted — the autoStartedRef latch ensures
    // we fire once per (investigationId × idle-status) edge, regardless of
    // whether handleStart's identity changes between renders. Adding it would
    // re-fire start on every render until the latch closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, investigationId, state.status]);

  // Scene-driven auto-stop. When the parent flips `active` from true to
  // false (e.g. the operator ended the session), flush the in-flight clip
  // so we don't lose audio when the camera surface tears down. Tracks the
  // previous value in a ref so we only fire on the transition, not when
  // active starts as undefined.
  const prevActiveRef = useRef<boolean | undefined>(active);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (prev === true && active === false && state.status === "recording") {
      void handleStop();
    }
    // handleStop intentionally omitted — the prev-active edge check is the
    // gate; identity changes to handleStop between renders shouldn't trigger
    // a stop. Same rationale as the autoStart effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.status]);

  // Cleanup on unmount — stop the recorder if it's still running.
  useEffect(() => {
    const recorder = recorderRef.current!;
    return () => {
      if (recorder) recorder.stop().catch(() => { /* ignore */ });
    };
  }, []);

  const isRecording = state.status === "recording";
  const isStarting = state.status === "starting";
  const isStopping = state.status === "stopping";
  const wrapClass = variant === "compact" ? `${s.wrap} ${s.compact}` : s.wrap;

  return (
    <div className={wrapClass}>
      <div className={s.head}>
        <span className={s.eyebrow}>EVP CAPTURE</span>
        <span className={s.note}>16-bit · 48 kHz · mono · raw PCM (no AGC, no AEC).</span>
      </div>

      <div className={s.row}>
        {!isRecording ? (
          <button
            type="button"
            className={s.startBtn}
            onClick={handleStart}
            disabled={isStarting || isStopping || !investigationId}
            aria-label="Start EVP recording"
          >
            <span className={s.dot} aria-hidden="true" />
            <span>{isStarting ? "Opening mic…" : investigationId ? "Start recording" : "Begin a session first"}</span>
          </button>
        ) : (
          <button
            type="button"
            className={s.stopBtn}
            onClick={handleStop}
            aria-label="Stop EVP recording"
          >
            <span className={s.square} aria-hidden="true" />
            <span>Stop & save</span>
          </button>
        )}

        <span className={`${s.timer} ${isRecording ? s.timerActive : ""}`.trim()}>
          {formatDuration(state.durationSeconds)}
        </span>
      </div>

      {lastError && <p className={s.error}>{lastError}</p>}
      {savingMessage && <p className={s.success}>{savingMessage}</p>}
      {transcribeStatus && (
        <p className={transcribeStatus.startsWith("Transcribe failed") ? s.error : s.success}>
          {transcribeStatus}
        </p>
      )}
      {state.error && <p className={s.error}>{state.error}</p>}
    </div>
  );
}
