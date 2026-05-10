/**
 * EvpEditor — open a WAV from OPFS, scrub through it, select a region,
 * tag the region with reviewer class (A/B/C voice), trim it down, and
 * export the trimmed clip as a new audit-chained media asset.
 *
 * The waveform canvas renders min/max peaks per pixel column. Drag on
 * the canvas to define a selection range. Play All / Play Selection /
 * Loop Selection let the reviewer audition without committing.
 *
 * Class A/B/C convention (reviewer-class consensus standard):
 *   • Class A — clearly intelligible, multiple reviewers agree on words.
 *   • Class B — partially intelligible, possibly disputable.
 *   • Class C — needs the reviewer to be told the words to "hear" them.
 *
 * Anything saved here is logged to the audit chain — no silent edits,
 * no hidden cuts. Original recordings are never modified.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFile, writeBytes } from "../lib/opfs";
import { decodeWav, computeWaveformPeaks, computeRms } from "../lib/audio/wavDecoder";
import { encodeWavFromFloat32 } from "../lib/wav";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { exec } from "../lib/db/db";
import { transcribeAudio } from "../lib/ai/cloudTranscribe";
import {
  transcribeOnDevice,
  useLocalTranscribeStatus,
} from "../lib/audio/localTranscribe";
import { getInvestigation } from "../lib/db/repo";
import { usePreferences } from "../lib/preferences";
import { Link } from "react-router-dom";
import type { MediaAsset } from "../lib/db/schema";
import s from "./EvpEditor.module.css";

interface Props {
  asset: MediaAsset;
  onClose: () => void;
  onSavedTrim?: () => void;
}

interface Selection {
  startSec: number;
  endSec: number;
}

const REVIEWER_CLASSES = [
  { value: "A", label: "Class A — Clear", hint: "Multiple reviewers would agree on the words." },
  { value: "B", label: "Class B — Partial", hint: "Some words intelligible, possibly disputable." },
  { value: "C", label: "Class C — Suggested", hint: "Only audible after being told what to hear." },
  { value: "noise", label: "Mundane / contamination", hint: "Confirmed prosaic source — log to base rate." },
] as const;

type ReviewerClass = (typeof REVIEWER_CLASSES)[number]["value"];

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m.toString().padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

export function EvpEditor({ asset, onClose, onSavedTrim }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<{ samples: Float32Array; sampleRate: number; durationSec: number } | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loopSelection, setLoopSelection] = useState(false);
  const [reviewerClass, setReviewerClass] = useState<ReviewerClass>("B");
  const [reviewerText, setReviewerText] = useState("");
  const [reviewerNotes, setReviewerNotes] = useState("");
  const [savingTag, setSavingTag] = useState(false);
  const [savingTrim, setSavingTrim] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribingLocal, setTranscribingLocal] = useState(false);
  const localStatus = useLocalTranscribeStatus();
  const [prefs] = usePreferences();
  // Per-case sensitivity flag (mirrors investigations.culturally_sensitive).
  // Defaults to true — fail-closed until we know otherwise — so the cloud
  // button never flashes on for a sensitive case during the load race.
  const [caseSensitive, setCaseSensitive] = useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    void getInvestigation(asset.investigation_id).then((inv) => {
      if (!cancelled) setCaseSensitive(!!inv && inv.culturally_sensitive === 1);
    });
    return () => { cancelled = true; };
  }, [asset.investigation_id]);
  const cloudBlocked = caseSensitive || prefs.globalCulturalSensitivityFlag;
  const [transcript, setTranscript] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startTime: number } | null>(null);

  // Decode WAV on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const file = await readFile(asset.file_path);
        const buf = await file.arrayBuffer();
        const wav = decodeWav(buf);
        if (cancelled) return;
        setDecoded({ samples: wav.samples, sampleRate: wav.sampleRate, durationSec: wav.durationSeconds });
        const blob = new Blob([buf], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [asset.file_path]);

  // Revoke audio blob URL on unmount.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  // Audio element time tracker. Depend on audioUrl so the effect re-runs
  // once the <audio> mounts (it renders conditionally after decode finishes;
  // without this, audioRef.current is null on first run and the listeners
  // never attach — which is why the playhead never moved).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if (loopSelection && selection && audio.currentTime >= selection.endSec) {
        audio.currentTime = selection.startSec;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [loopSelection, selection, audioUrl]);

  // Smooth the playhead between coarse `timeupdate` events (which fire
  // ~3-4Hz on most browsers) — drive currentTime off requestAnimationFrame
  // while playing so the cursor glides instead of stepping.
  useEffect(() => {
    if (!playing) return;
    const audio = audioRef.current;
    if (!audio) return;
    let raf = 0;
    const tick = () => {
      setCurrentTime(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !decoded) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width * dpr)) canvas.width = Math.floor(rect.width * dpr);
    if (canvas.height !== Math.floor(rect.height * dpr)) canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Background.
    ctx.fillStyle = "rgba(8, 12, 18, 0.95)";
    ctx.fillRect(0, 0, w, h);

    // Centerline.
    ctx.strokeStyle = "rgba(127, 252, 215, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Selection band.
    if (selection && decoded.durationSec > 0) {
      const x0 = (selection.startSec / decoded.durationSec) * w;
      const x1 = (selection.endSec / decoded.durationSec) * w;
      ctx.fillStyle = "rgba(127, 252, 215, 0.18)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.strokeStyle = "rgba(127, 252, 215, 0.7)";
      ctx.beginPath();
      ctx.moveTo(x0, 0); ctx.lineTo(x0, h);
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
      ctx.stroke();
    }

    // Peaks.
    const peaks = computeWaveformPeaks(decoded.samples, Math.floor(w));
    ctx.fillStyle = "rgba(127, 252, 215, 0.85)";
    for (let x = 0; x < Math.floor(w); x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      const y0 = mid - max * mid;
      const y1 = mid - min * mid;
      const barH = Math.max(1, y1 - y0);
      ctx.fillRect(x, y0, 1, barH);
    }

    // Playhead.
    if (decoded.durationSec > 0) {
      const px = (currentTime / decoded.durationSec) * w;
      ctx.strokeStyle = "rgba(255, 90, 90, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }, [decoded, currentTime, selection]);

  // Redraw on changes.
  useEffect(() => { drawWaveform(); }, [drawWaveform]);

  // Redraw on resize.
  useEffect(() => {
    const onResize = () => drawWaveform();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawWaveform]);

  const xToTime = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || !decoded) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(decoded.durationSec, ratio * decoded.durationSec));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const t = xToTime(e.clientX);
    dragStateRef.current = { startX: e.clientX, startTime: t };
    setSelection({ startSec: t, endSec: t });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const t = xToTime(e.clientX);
    const startSec = Math.min(drag.startTime, t);
    const endSec = Math.max(drag.startTime, t);
    setSelection({ startSec, endSec });
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    if (!drag || !decoded) return;
    const t = xToTime(e.clientX);
    // If the drag was effectively a click (very small range), seek instead.
    const diff = Math.abs(t - drag.startTime);
    if (diff < 0.05) {
      setSelection(null);
      const audio = audioRef.current;
      if (audio) audio.currentTime = t;
    }
  };

  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // If selection exists and we're outside it, jump to its start.
      if (selection && (audio.currentTime < selection.startSec || audio.currentTime >= selection.endSec)) {
        audio.currentTime = selection.startSec;
      }
      audio.play().catch(() => { /* ignore */ });
    } else {
      audio.pause();
    }
  };

  const handlePlaySelection = () => {
    const audio = audioRef.current;
    if (!audio || !selection) return;
    audio.currentTime = selection.startSec;
    audio.play().catch(() => { /* ignore */ });
  };

  const handleClearSelection = () => {
    setSelection(null);
    setLoopSelection(false);
  };

  const handleSelectAll = () => {
    if (!decoded) return;
    setSelection({ startSec: 0, endSec: decoded.durationSec });
  };

  const selectionStats = useMemo(() => {
    if (!selection || !decoded) return null;
    const startIdx = Math.floor(selection.startSec * decoded.sampleRate);
    const endIdx = Math.min(decoded.samples.length, Math.floor(selection.endSec * decoded.sampleRate));
    const rms = computeRms(decoded.samples, startIdx, endIdx);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    return {
      durationSec: selection.endSec - selection.startSec,
      rms,
      dbfs,
    };
  }, [selection, decoded]);

  const handleSaveTag = async () => {
    if (!selection || !decoded) return;
    setSavingTag(true);
    setStatusMsg(null);
    try {
      const startMs = new Date(asset.timestamp_start).getTime() + Math.round(selection.startSec * 1000);
      const endMs = new Date(asset.timestamp_start).getTime() + Math.round(selection.endSec * 1000);
      await recordEvent({
        investigation_id: asset.investigation_id,
        source: "user",
        event_type: "audio.evp_review",
        title: `EVP review · Class ${reviewerClass.toUpperCase()}`,
        description: reviewerText.trim() || `Class ${reviewerClass.toUpperCase()} segment in ${asset.file_path}`,
        linked_file: asset.file_path,
        timestamp: new Date(startMs).toISOString(),
        metadata: {
          source_media_id: asset.id,
          source_path: asset.file_path,
          reviewer_class: reviewerClass,
          reviewer_text: reviewerText.trim() || null,
          reviewer_notes: reviewerNotes.trim() || null,
          start_offset_s: selection.startSec,
          end_offset_s: selection.endSec,
          start_iso: new Date(startMs).toISOString(),
          end_iso: new Date(endMs).toISOString(),
          rms: selectionStats?.rms ?? null,
          dbfs: Number.isFinite(selectionStats?.dbfs ?? -Infinity) ? selectionStats!.dbfs : null,
        },
      });
      setStatusMsg(`Tag saved — Class ${reviewerClass.toUpperCase()}`);
      setReviewerText("");
      setReviewerNotes("");
    } catch (err) {
      setError(`Tag failed: ${(err as Error).message}`);
    } finally {
      setSavingTag(false);
    }
  };

  const handleSaveTrim = async () => {
    if (!selection || !decoded) return;
    setSavingTrim(true);
    setStatusMsg(null);
    try {
      const startIdx = Math.floor(selection.startSec * decoded.sampleRate);
      const endIdx = Math.min(decoded.samples.length, Math.floor(selection.endSec * decoded.sampleRate));
      const slice = decoded.samples.slice(startIdx, endIdx);
      const wav = encodeWavFromFloat32(slice, decoded.sampleRate, 1);
      const owned = new Uint8Array(wav.length);
      owned.set(wav);
      const buf: ArrayBuffer = owned.buffer;
      const sha = await sha256Hex(buf);
      const ts = Date.now();
      const finalPath = `media/${asset.investigation_id}/evp-trim-${ts}-${sha.slice(0, 8)}.wav`;
      await writeBytes(finalPath, buf);

      await registerMedia({
        investigation_id: asset.investigation_id,
        media_type: "audio",
        file_path: finalPath,
        timestamp_start: new Date(new Date(asset.timestamp_start).getTime() + Math.round(selection.startSec * 1000)).toISOString(),
        timestamp_end: new Date(new Date(asset.timestamp_start).getTime() + Math.round(selection.endSec * 1000)).toISOString(),
        checksum_sha256: sha,
        metadata: {
          source: "evp_trim",
          parent_media_id: asset.id,
          parent_path: asset.file_path,
          start_offset_s: selection.startSec,
          end_offset_s: selection.endSec,
          sample_rate: decoded.sampleRate,
          channels: 1,
          bits_per_sample: 16,
          duration_s: slice.length / decoded.sampleRate,
          reviewer_class: reviewerClass,
          reviewer_text: reviewerText.trim() || null,
        },
      });
      await recordEvent({
        investigation_id: asset.investigation_id,
        source: "user",
        event_type: "audio.evp_trim",
        title: `EVP trim · Class ${reviewerClass.toUpperCase()}`,
        description: reviewerText.trim() || `Trimmed segment from ${asset.file_path}`,
        linked_file: finalPath,
        metadata: {
          parent_media_id: asset.id,
          parent_path: asset.file_path,
          new_path: finalPath,
          sha256: sha,
          start_offset_s: selection.startSec,
          end_offset_s: selection.endSec,
          reviewer_class: reviewerClass,
        },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "audio.evp.trim_saved",
        payload: {
          investigation_id: asset.investigation_id,
          parent_media_id: asset.id,
          new_path: finalPath,
          sha256: sha,
          start_offset_s: selection.startSec,
          end_offset_s: selection.endSec,
          reviewer_class: reviewerClass,
        },
      });
      setStatusMsg(`Trim saved · ${(buf.byteLength / 1024).toFixed(0)} KB · ${sha.slice(0, 12)}…`);
      onSavedTrim?.();
    } catch (err) {
      setError(`Trim failed: ${(err as Error).message}`);
    } finally {
      setSavingTrim(false);
    }
  };

  const handleTranscribe = async () => {
    if (!decoded) return;
    setTranscribing(true);
    setStatusMsg(null);
    setTranscript(null);
    try {
      let samples: Float32Array;
      let startSec = 0;
      let endSec = decoded.durationSec;
      if (selection) {
        const startIdx = Math.floor(selection.startSec * decoded.sampleRate);
        const endIdx = Math.min(decoded.samples.length, Math.floor(selection.endSec * decoded.sampleRate));
        samples = decoded.samples.slice(startIdx, endIdx);
        startSec = selection.startSec;
        endSec = selection.endSec;
      } else {
        samples = decoded.samples;
      }
      const wav = encodeWavFromFloat32(samples, decoded.sampleRate, 1);
      const owned = new Uint8Array(wav.length);
      owned.set(wav);
      const blob = new Blob([owned], { type: "audio/wav" });
      const result = await transcribeAudio(blob, { investigationId: asset.investigation_id, culturallySensitive: caseSensitive }, {
        language: "en",
        filename: "evp-clip.wav",
        prompt: reviewerText.trim() ? `Possible utterance: ${reviewerText.trim()}` : undefined,
      });
      setTranscript(result.text);

      // Persist transcript segments to the transcripts table for downstream review.
      const transcriptId = crypto.randomUUID();
      await exec(
        `INSERT INTO transcripts (id, media_id, investigation_id, segment_start_s, segment_end_s, text, confidence, engine, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptId,
          asset.id,
          asset.investigation_id,
          startSec,
          endSec,
          result.text,
          null,
          `cloud-${result.model}`,
          JSON.stringify({ segments: result.segments, language: result.language, duration: result.duration }),
        ],
      );
      await recordEvent({
        investigation_id: asset.investigation_id,
        source: "ai",
        event_type: "audio.evp_transcribe",
        title: "EVP transcribed",
        description: result.text.slice(0, 200),
        linked_file: asset.file_path,
        metadata: {
          source_media_id: asset.id,
          transcript_id: transcriptId,
          start_offset_s: startSec,
          end_offset_s: endSec,
          model: result.model,
          language: result.language,
        },
      });
      await appendAuditEntry({
        actor: "ai",
        kind: "audio.evp.transcribe",
        payload: {
          investigation_id: asset.investigation_id,
          media_id: asset.id,
          transcript_id: transcriptId,
          model: result.model,
          start_offset_s: startSec,
          end_offset_s: endSec,
        },
      });
      setStatusMsg(`Transcribed (${result.model})`);
    } catch (err) {
      setError(`Transcribe failed: ${(err as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  };

  const handleTranscribeLocal = async () => {
    if (!decoded) return;
    if (localStatus.state !== "ready") {
      setError("On-device transcription not loaded — enable it in Setup first.");
      return;
    }
    setTranscribingLocal(true);
    setStatusMsg(null);
    setTranscript(null);
    setError(null);
    try {
      let samples: Float32Array;
      let startSec = 0;
      let endSec = decoded.durationSec;
      if (selection) {
        const startIdx = Math.floor(selection.startSec * decoded.sampleRate);
        const endIdx = Math.min(decoded.samples.length, Math.floor(selection.endSec * decoded.sampleRate));
        samples = decoded.samples.slice(startIdx, endIdx);
        startSec = selection.startSec;
        endSec = selection.endSec;
      } else {
        samples = decoded.samples;
      }
      // Transfer a copy — transcribeOnDevice transfers the buffer to the
      // worker, so the operator's `decoded.samples` ref stays valid for
      // playback / re-transcription on the same clip.
      const audio = new Float32Array(samples.length);
      audio.set(samples);
      const result = await transcribeOnDevice(audio, decoded.sampleRate, {
        language: "en",
        returnTimestamps: true,
      });
      setTranscript(result.text);

      const transcriptId = crypto.randomUUID();
      await exec(
        `INSERT INTO transcripts (id, media_id, investigation_id, segment_start_s, segment_end_s, text, confidence, engine, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptId,
          asset.id,
          asset.investigation_id,
          startSec,
          endSec,
          result.text,
          null,
          result.engine,
          JSON.stringify({ segments: result.segments, language: "en", on_device: true }),
        ],
      );
      await recordEvent({
        investigation_id: asset.investigation_id,
        source: "ai",
        event_type: "audio.evp_transcribe",
        title: "EVP transcribed (on-device)",
        description: result.text.slice(0, 200),
        linked_file: asset.file_path,
        metadata: {
          source_media_id: asset.id,
          transcript_id: transcriptId,
          start_offset_s: startSec,
          end_offset_s: endSec,
          engine: result.engine,
          on_device: true,
        },
      });
      await appendAuditEntry({
        actor: "ai",
        kind: "audio.evp.transcribe",
        payload: {
          investigation_id: asset.investigation_id,
          media_id: asset.id,
          transcript_id: transcriptId,
          engine: result.engine,
          on_device: true,
          start_offset_s: startSec,
          end_offset_s: endSec,
        },
      });
      setStatusMsg(`Transcribed on-device (${result.engine})`);
    } catch (err) {
      setError(`On-device transcribe failed: ${(err as Error).message}`);
    } finally {
      setTranscribingLocal(false);
    }
  };

  const handleExportSelection = () => {
    if (!selection || !decoded) return;
    const startIdx = Math.floor(selection.startSec * decoded.sampleRate);
    const endIdx = Math.min(decoded.samples.length, Math.floor(selection.endSec * decoded.sampleRate));
    const slice = decoded.samples.slice(startIdx, endIdx);
    const wav = encodeWavFromFloat32(slice, decoded.sampleRate, 1);
    const owned = new Uint8Array(wav.length);
    owned.set(wav);
    const blob = new Blob([owned], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `evp-selection-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportFull = () => {
    if (!audioUrl) return;
    const stamp = new Date(asset.timestamp_start).toISOString().replace(/[:.]/g, "-");
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = `evp-${stamp}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className={s.modal} role="dialog" aria-modal="true" aria-labelledby="evp-editor-title">
      <div className={s.dialog}>
        <header className={s.header}>
          <div>
            <h2 id="evp-editor-title" className={s.title}>EVP editor</h2>
            <p className={s.subtitle}>{asset.file_path}</p>
          </div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close editor">×</button>
        </header>

        {loading && <p className={s.loading}>Decoding…</p>}
        {error && <p className={s.error}>{error}</p>}

        {decoded && (
          <>
            <div className={s.canvasWrap}>
              <canvas
                ref={canvasRef}
                className={s.canvas}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              />
              <div className={s.timeRail}>
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(decoded.durationSec)}</span>
              </div>
            </div>

            <audio ref={audioRef} src={audioUrl ?? undefined} preload="auto" className={s.hiddenAudio} />

            <div className={s.transportRow}>
              <button type="button" className={s.transportBtn} onClick={handlePlayPause}>
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button type="button" className={s.transportBtn} onClick={handlePlaySelection} disabled={!selection}>
                ▶ Selection
              </button>
              <label className={s.checkbox}>
                <input type="checkbox" checked={loopSelection} onChange={(e) => setLoopSelection(e.target.checked)} disabled={!selection} />
                <span>Loop selection</span>
              </label>
              <button type="button" className={s.ghostBtn} onClick={handleSelectAll}>Select all</button>
              <button type="button" className={s.ghostBtn} onClick={handleClearSelection} disabled={!selection}>Clear</button>
            </div>

            {selection && (
              <div className={s.selectionStats}>
                <span><strong>Selection:</strong> {formatTime(selection.startSec)} → {formatTime(selection.endSec)}</span>
                <span>Duration: {(selection.endSec - selection.startSec).toFixed(2)} s</span>
                {selectionStats && Number.isFinite(selectionStats.dbfs) && (
                  <span>RMS: {selectionStats.dbfs.toFixed(1)} dBFS</span>
                )}
              </div>
            )}

            <div className={s.tagPanel}>
              <div className={s.classGroup}>
                {REVIEWER_CLASSES.map((cls) => (
                  <label key={cls.value} className={`${s.classChip} ${reviewerClass === cls.value ? s.classChipActive : ""}`.trim()}>
                    <input
                      type="radio"
                      name="reviewer-class"
                      value={cls.value}
                      checked={reviewerClass === cls.value}
                      onChange={() => setReviewerClass(cls.value)}
                    />
                    <span className={s.classLabel}>{cls.label}</span>
                    <span className={s.classHint}>{cls.hint}</span>
                  </label>
                ))}
              </div>
              <label className={s.field}>
                <span className={s.fieldLabel}>Heard words / transcription</span>
                <input
                  type="text"
                  className={s.input}
                  value={reviewerText}
                  onChange={(e) => setReviewerText(e.target.value)}
                  placeholder="e.g. 'help me' (Class A) or 'something like, get out' (Class C)"
                  maxLength={200}
                />
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}>Reviewer notes</span>
                <textarea
                  className={s.textarea}
                  rows={2}
                  value={reviewerNotes}
                  onChange={(e) => setReviewerNotes(e.target.value)}
                  placeholder="Context that doesn't fit in the transcription field — possible mundane sources you ruled out, etc."
                  maxLength={600}
                />
              </label>
            </div>

            <div className={s.actionRow}>
              <button type="button" className={s.primaryBtn} onClick={handleSaveTag} disabled={!selection || savingTag}>
                {savingTag ? "Saving…" : "Save tag"}
              </button>
              <button type="button" className={s.primaryBtn} onClick={handleSaveTrim} disabled={!selection || savingTrim}>
                {savingTrim ? "Saving…" : "Save trim to case"}
              </button>
              {!cloudBlocked && (
                <button
                  type="button"
                  className={s.secondaryBtn}
                  onClick={handleTranscribe}
                  disabled={transcribing || transcribingLocal}
                  title="Cloud transcription via Whisper. Blocked on culturally-sensitive cases."
                >
                  {transcribing ? "Transcribing…" : selection ? "Transcribe selection (cloud)" : "Transcribe full (cloud)"}
                </button>
              )}
              {localStatus.state === "ready" && (
                <button
                  type="button"
                  className={s.secondaryBtn}
                  onClick={handleTranscribeLocal}
                  disabled={transcribing || transcribingLocal}
                  title="Runs Whisper entirely on this device — no audio leaves the phone."
                >
                  {transcribingLocal ? "Transcribing on-device… (~1× clip length)" : selection ? "Transcribe selection (on-device)" : "Transcribe full (on-device)"}
                </button>
              )}
              {cloudBlocked && localStatus.state !== "ready" && (
                <span className={s.transcribeBlockedHint}>
                  Cloud transcription is blocked for this case ({caseSensitive ? "culturally-sensitive site" : "device-wide protection on"}).{" "}
                  <Link to="/setup">Enable on-device transcription</Link> to transcribe locally.
                </span>
              )}
              {cloudBlocked && localStatus.state === "ready" && (
                <span className={s.transcribeBlockedHint}>
                  On-device only — cloud transcription is blocked for this case.
                </span>
              )}
              <button type="button" className={s.secondaryBtn} onClick={handleExportSelection} disabled={!selection}>
                Export selection (.wav)
              </button>
              <button type="button" className={s.secondaryBtn} onClick={handleExportFull}>
                Export full (.wav)
              </button>
            </div>

            {statusMsg && <p className={s.success}>{statusMsg}</p>}
            {transcript && (
              <div className={s.transcriptBox}>
                <span className={s.transcriptLabel}>Transcript</span>
                <p className={s.transcriptText}>{transcript}</p>
              </div>
            )}

            <p className={s.disclaimer}>
              Drag on the waveform to select a region. All saves are appended to the audit chain — original recording is never altered.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
