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
import { getPreferences } from "../lib/preferences";
import s from "./EvpRecorderControl.module.css";

interface Props {
  investigationId: string | null;
  onSaved?: () => void;
  variant?: "default" | "compact";
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export function EvpRecorderControl({ investigationId, onSaved, variant = "default" }: Props) {
  const recorderRef = useRef<EvpRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new EvpRecorder();

  const [state, setState] = useState<EvpRecorderState>({ status: "idle", startedAt: null, durationSeconds: 0, error: null });
  const [savingMessage, setSavingMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [transcribeStatus, setTranscribeStatus] = useState<string | null>(null);

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
    const prefs = getPreferences();
    if (!prefs.evp.autoTranscribe) return;
    if (args.durationSeconds < 1) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (prefs.globalCulturalSensitivityFlag) return;
    if (await isInvestigationSensitive(args.investigationId)) return;

    setTranscribeStatus("Transcribing…");
    try {
      const blob = new Blob([args.wavBuffer], { type: "audio/wav" });
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
      const sha = await sha256Hex(buf);
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
