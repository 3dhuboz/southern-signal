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

  useEffect(() => {
    return recorderRef.current!.subscribe(setState);
  }, []);

  const handleStart = async () => {
    if (!investigationId) {
      setLastError("Begin a session first.");
      return;
    }
    setLastError(null);
    setSavingMessage(null);
    const ts = Date.now();
    const tmpPath = `media/${investigationId}/_evp-pending-${ts}.wav`;
    try {
      await recorderRef.current!.start(tmpPath);
    } catch (err) {
      const e = err as Error & { name?: string };
      setLastError(
        e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in browser settings."
        : e.name === "NotFoundError" ? "No microphone found."
        : e.name === "NotReadableError" ? "Microphone is busy in another app."
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

      await registerMedia({
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
      {state.error && <p className={s.error}>{state.error}</p>}
    </div>
  );
}
