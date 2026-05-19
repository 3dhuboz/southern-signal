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
import { decodeWav, decodeStereoWav, computeWaveformPeaks, computeRms } from "../lib/audio/wavDecoder";
import type { StereoChannels } from "../lib/audio/wavDecoder";
import { analyzeStereoSegment } from "../lib/audio/stereoAnalysis";
import type { StereoAnalysis } from "../lib/audio/stereoAnalysis";
import { encodeWavFromFloat32 } from "../lib/wav";
import { registerMedia, recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { exec } from "../lib/db/db";
import { sha256HexBytes } from "../lib/forensic/canonicalJson";
import { transcribeAudio } from "../lib/ai/cloudTranscribe";
import { setEvpEmission } from "../lib/itc/itcChannels";
import {
  DEFAULT_LOCAL_MODEL,
  loadLocalWhisperModel,
  transcribeOnDevice,
  useLocalTranscribeStatus,
} from "../lib/audio/localTranscribe";
import { getInvestigation, listDossiers } from "../lib/db/repo";
import { usePreferences } from "../lib/preferences";
import { Link } from "react-router-dom";
import type { MediaAsset } from "../lib/db/schema";
import { computeNoiseFloor } from "../lib/audio/spectrogram";
import { SpectrogramViewer } from "./SpectrogramViewer";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useEd25519Support } from "../hooks/useEd25519Support";
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

/** Shape of the JSON returned by /api/ai/evp-review. Mirrors the
 *  Functions endpoint's ReviewResponse — duplicated here so the
 *  component doesn't need to import a server-side type. */
interface DeepReview {
  headline: string;
  mundaneScore: number;
  pareidoliaRisk: number;
  contextNotes: string;
  mundaneHypotheses: Array<{ label: string; reasoning: string }>;
  dossierMatches: Array<{ findingTitle: string; matchReason: string }>;
  falsificationProbe: string;
  model: string;
  citations?: string[];
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
  // Cloud transcribe just failed — surface a one-tap recovery offer.
  // Cleared when any new transcribe attempt starts (cloud or local).
  const [cloudFailed, setCloudFailed] = useState(false);
  // User clicked "Use on-device" while the model wasn't loaded — we
  // kicked off the download and want to auto-retry once it's ready.
  const [pendingLocalRetry, setPendingLocalRetry] = useState(false);
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
  // Deep AI EVP review (second pass, in-context against the venue dossier).
  // Distinct from Whisper: Whisper writes down the words; this assesses
  // them against the venue history + the operator's posterior + baseline z-scores.
  const [deepReview, setDeepReview] = useState<DeepReview | null>(null);
  const [deepReviewBusy, setDeepReviewBusy] = useState(false);
  const [deepReviewErr, setDeepReviewErr] = useState<string | null>(null);
  // Deep review hits the signed /api/ai/evp-review endpoint → needs
  // Ed25519 the same as every other AI call.
  const ed25519Support = useEd25519Support();
  const signingUnsupported = ed25519Support !== null && !ed25519Support.ok;

  // --- Headphone gate (per session, not persisted) -----------------------
  const [headphoneChecked, setHeadphoneChecked]   = useState(false);
  const [headphoneConfirmed, setHeadphoneConfirmed] = useState(false);

  // --- Spectrogram tab ---------------------------------------------------
  type ActiveTab = "waveform" | "spectrogram";
  const [activeTab, setActiveTab] = useState<ActiveTab>("waveform");

  // --- Noise floor (computed once after decode) --------------------------
  const [noiseFloor, setNoiseFloor] = useState<{ p50dBFS: number; p95dBFS: number } | null>(null);

  // --- Stereo channels (null for mono recordings) -----------------------
  const [stereoChannels, setStereoChannels] = useState<StereoChannels | null>(null);

  // --- Auto-loop state for headphone review -----------------------------
  // loopCount tracks how many complete loops have played for the current selection.
  const [loopCount, setLoopCount]   = useState(0);
  const loopCountRef = useRef(0);
  const loopStartRef = useRef<number | null>(null);
  // SNR override: maps selection key (startSec|endSec) → typed reason
  const [snrOverrideReason, setSnrOverrideReason] = useState("");
  const [snrOverrideActive, setSnrOverrideActive] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startTime: number } | null>(null);

  // a11y: trap focus inside the editor while it's mounted. The parent owns
  // mount/unmount, so we trap unconditionally — Escape forwards to onClose.
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: onClose,
  });

  // Decode WAV on mount (mono mix + optional stereo channels).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setStereoChannels(null);
        const file = await readFile(asset.file_path);
        const buf = await file.arrayBuffer();
        const wav = decodeWav(buf);
        if (cancelled) return;
        setDecoded({ samples: wav.samples, sampleRate: wav.sampleRate, durationSec: wav.durationSeconds });
        // Decode stereo channels separately when the file has ≥ 2 channels.
        setStereoChannels(decodeStereoWav(buf));
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

  // Compute noise floor once decoded samples are available.
  useEffect(() => {
    if (!decoded) { setNoiseFloor(null); return; }
    const nf = computeNoiseFloor(decoded.samples, decoded.sampleRate, 10);
    setNoiseFloor(nf);
  }, [decoded]);

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
      // Auto-loop [t-3, t+2] for headphone review. Track completed loops.
      if (headphoneConfirmed && selection && loopStartRef.current !== null) {
        const loopEnd = selection.endSec + 2;
        if (audio.currentTime >= loopEnd) {
          loopCountRef.current += 1;
          setLoopCount(loopCountRef.current);
          const loopStart = Math.max(0, selection.startSec - 3);
          audio.currentTime = loopStart;
        }
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
  }, [loopSelection, selection, audioUrl, headphoneConfirmed]);

  // Reset loop counter whenever the selection changes (headphone review mode).
  useEffect(() => {
    loopCountRef.current = 0;
    setLoopCount(0);
    loopStartRef.current = selection ? selection.startSec : null;
    setSnrOverrideActive(false);
    setSnrOverrideReason("");
  }, [selection]);

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

    // Theme-driven colours. Read from CSS custom properties on the
    // canvas element so the waveform retints on scotopic / daylight
    // without rewriting the draw code. Fallbacks match the previous
    // phosphor-default values so an offline browser doesn't render
    // black-on-black.
    const cs = getComputedStyle(canvas);
    const signal = cs.getPropertyValue("--signal").trim() || "#7FFCD7";
    const danger = cs.getPropertyValue("--danger").trim() || "#FF5A5A";
    const bgInset = cs.getPropertyValue("--bg-inset").trim() || "rgba(8, 12, 18, 0.95)";

    // Background.
    ctx.fillStyle = bgInset;
    ctx.fillRect(0, 0, w, h);

    // Centerline.
    ctx.strokeStyle = signal;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Selection band.
    if (selection && decoded.durationSec > 0) {
      const x0 = (selection.startSec / decoded.durationSec) * w;
      const x1 = (selection.endSec / decoded.durationSec) * w;
      ctx.fillStyle = signal;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = signal;
      ctx.beginPath();
      ctx.moveTo(x0, 0); ctx.lineTo(x0, h);
      ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Peaks.
    const peaks = computeWaveformPeaks(decoded.samples, Math.floor(w));
    ctx.fillStyle = signal;
    ctx.globalAlpha = 0.85;
    for (let x = 0; x < Math.floor(w); x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      const y0 = mid - max * mid;
      const y1 = mid - min * mid;
      const barH = Math.max(1, y1 - y0);
      ctx.fillRect(x, y0, 1, barH);
    }
    ctx.globalAlpha = 1;

    // Playhead.
    if (decoded.durationSec > 0) {
      const px = (currentTime / decoded.durationSec) * w;
      ctx.strokeStyle = danger;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
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
    if (headphoneConfirmed) {
      // Auto-loop [t-3, t+2]: start 3 s before selection.
      const loopStart = Math.max(0, selection.startSec - 3);
      loopStartRef.current = selection.startSec;
      loopCountRef.current = 0;
      setLoopCount(0);
      audio.currentTime = loopStart;
    } else {
      audio.currentTime = selection.startSec;
    }
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
    // Peak dBFS: max absolute sample in the selection, converted to dBFS.
    let peakAbs = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const a = Math.abs(decoded.samples[i]);
      if (a > peakAbs) peakAbs = a;
    }
    const peakDbfs = peakAbs > 0 ? 20 * Math.log10(peakAbs) : -Infinity;
    const snrDb = noiseFloor && Number.isFinite(peakDbfs)
      ? peakDbfs - noiseFloor.p95dBFS
      : null;
    return {
      durationSec: selection.endSec - selection.startSec,
      rms,
      dbfs,
      peakDbfs,
      snrDb,
    };
  }, [selection, decoded, noiseFloor]);

  // Stereo differential analysis — null when mono or no selection.
  const stereoAnalysis = useMemo((): StereoAnalysis | null => {
    if (!selection || !stereoChannels) return null;
    const sr = stereoChannels.sampleRate;
    const startFrame = Math.floor(selection.startSec * sr);
    const endFrame = Math.min(stereoChannels.left.length, Math.floor(selection.endSec * sr));
    if (endFrame <= startFrame) return null;
    return analyzeStereoSegment(stereoChannels.left, stereoChannels.right, sr, startFrame, endFrame);
  }, [selection, stereoChannels]);

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
          snr_db: selectionStats?.snrDb ?? null,
          snr_override_reason: snrOverrideActive && snrOverrideReason.trim() ? snrOverrideReason.trim() : null,
          noise_floor_p50: noiseFloor?.p50dBFS ?? null,
          noise_floor_p95: noiseFloor?.p95dBFS ?? null,
          itd_ms: stereoAnalysis?.itdMs ?? null,
          ild_db: stereoAnalysis?.ildDb ?? null,
          stereo_conflict: stereoAnalysis?.conflictFlag ?? null,
          stereo_impossible_itd: stereoAnalysis?.impossibleItd ?? null,
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
      const sha = await sha256HexBytes(buf);
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
          snr_db: selectionStats?.snrDb ?? null,
          snr_override_reason: snrOverrideActive && snrOverrideReason.trim() ? snrOverrideReason.trim() : null,
          noise_floor_p50: noiseFloor?.p50dBFS ?? null,
          noise_floor_p95: noiseFloor?.p95dBFS ?? null,
          itd_ms: stereoAnalysis?.itdMs ?? null,
          ild_db: stereoAnalysis?.ildDb ?? null,
          stereo_conflict: stereoAnalysis?.conflictFlag ?? null,
          stereo_impossible_itd: stereoAnalysis?.impossibleItd ?? null,
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
    setCloudFailed(false);
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
      // Push to live overlay's EVP channel — disappears from the overlay after
      // the channel's age window expires; permanent storage stays in the DB.
      if (result.text.trim()) setEvpEmission(result.text);

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
      setCloudFailed(true);
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
    setCloudFailed(false);
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
      if (result.text.trim()) setEvpEmission(result.text);

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

  // One-tap recovery from a cloud-transcribe failure. If the on-device
  // model is already loaded, fire it immediately. Otherwise kick off
  // the download and set pendingLocalRetry so the effect below auto-
  // retries once the model reports "ready".
  const handleRecoverLocal = async () => {
    if (!decoded || transcribingLocal) return;
    if (localStatus.state === "ready") {
      void handleTranscribeLocal();
      return;
    }
    if (localStatus.state === "loading") {
      // Already downloading — just queue the retry.
      setPendingLocalRetry(true);
      return;
    }
    // unloaded / error — start the download then queue the retry.
    setError(null);
    setStatusMsg("Downloading Whisper model — clip will transcribe automatically when ready…");
    setPendingLocalRetry(true);
    try {
      await loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    } catch (err) {
      setPendingLocalRetry(false);
      setError(`Model download failed: ${(err as Error).message}`);
      setStatusMsg(null);
    }
  };

  // Auto-retry once the model becomes ready after a pending recovery
  // request. Effect runs every time localStatus.state changes; the
  // pendingLocalRetry guard makes sure it only fires for the operator's
  // explicit recovery click, not for ambient state changes elsewhere.
  useEffect(() => {
    if (!pendingLocalRetry) return;
    if (localStatus.state !== "ready") return;
    setPendingLocalRetry(false);
    void handleTranscribeLocal();
    // handleTranscribeLocal closes over `decoded` + `selection`; we don't
    // want the effect to re-fire when those change — only on state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocalRetry, localStatus.state]);

  /**
   * Deep AI review — second pass against the venue dossier + Bayesian
   * context. Calls /api/ai/evp-review with the current transcript,
   * pulls the most-recent dossier for this case from local SQLite so
   * the model sees what the operator already knows, and writes the
   * returned review card to the audit chain as an evidence event.
   *
   * Blocked on culturally-sensitive cases regardless of the global
   * cloud setting — same fail-closed contract as cloud transcribe.
   */
  const handleDeepAiReview = async () => {
    if (!transcript || cloudBlocked) return;
    setDeepReviewBusy(true);
    setDeepReviewErr(null);
    try {
      const inv = await getInvestigation(asset.investigation_id);
      const dossiers = await listDossiers(asset.investigation_id, 1).catch(() => []);
      const latest = dossiers[0];
      let findings: Array<{ tier?: string; title?: string; body?: string }> = [];
      if (latest) {
        try {
          const parsed = JSON.parse(latest.result_json) as { findings?: Array<{ tier?: string; title?: string; body?: string }> };
          if (Array.isArray(parsed.findings)) findings = parsed.findings.slice(0, 8);
        } catch { /* keep findings empty if the dossier blob is malformed */ }
      }
      const durationSeconds = selection ? selection.endSec - selection.startSec : decoded?.durationSec ?? 0;
      const body = {
        transcriptText: transcript,
        perceivedText: reviewerText.trim() || undefined,
        durationSeconds,
        reviewerClass,
        culturallySensitive: caseSensitive || prefs.globalCulturalSensitivityFlag,
        context: {
          venueName: inv?.title ?? latest?.venue_name ?? undefined,
          locationName: inv?.location_name ?? undefined,
          region: (latest?.region as "AU" | "GLOBAL" | undefined) ?? "AU",
          dossierFindings: findings,
        },
      };
      const { signedJson } = await import("../lib/ai/signedFetch");
      const res = await signedJson("/api/ai/evp-review", body);
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try { detail = (JSON.parse(text) as { error?: string; detail?: string }).error ?? text; } catch { /* keep raw */ }
        throw new Error(`HTTP ${res.status} · ${detail.slice(0, 200)}`);
      }
      const parsed = JSON.parse(text) as DeepReview;
      setDeepReview(parsed);

      await recordEvent({
        investigation_id: asset.investigation_id,
        source: "ai",
        event_type: "audio.evp_deep_review",
        title: "Deep AI EVP review",
        description: parsed.headline.slice(0, 200),
        linked_file: asset.file_path,
        metadata: {
          media_id: asset.id,
          model: parsed.model,
          mundane_score: parsed.mundaneScore,
          pareidolia_risk: parsed.pareidoliaRisk,
          dossier_matches: parsed.dossierMatches.length,
          mundane_hypotheses: parsed.mundaneHypotheses.length,
        },
      });
      await appendAuditEntry({
        actor: "ai",
        kind: "audio.evp.deep_review",
        payload: {
          investigation_id: asset.investigation_id,
          media_id: asset.id,
          model: parsed.model,
          mundane_score: parsed.mundaneScore,
          pareidolia_risk: parsed.pareidoliaRisk,
          headline: parsed.headline.slice(0, 200),
        },
      });
    } catch (err) {
      setDeepReviewErr((err as Error).message || "Review failed");
    } finally {
      setDeepReviewBusy(false);
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

  const snrBlocked =
    selectionStats?.snrDb != null &&
    selectionStats.snrDb < 3 &&
    (!snrOverrideActive || snrOverrideReason.trim() === "");
  const loopBlocked = headphoneConfirmed && loopCount < 3;
  const submitBlocked = snrBlocked || loopBlocked;
  const submitTitle = snrBlocked
    ? `SNR too low (${selectionStats!.snrDb!.toFixed(1)} dB) — instrument noise floor`
    : loopBlocked
    ? `Play ${3 - loopCount} more loop${3 - loopCount !== 1 ? "s" : ""} before submitting`
    : undefined;

  return (
    <div className={s.modal} role="dialog" aria-modal="true" aria-labelledby="evp-editor-title" ref={trapRef} tabIndex={-1}>
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
        {cloudFailed && !cloudBlocked && (
          <div className={s.recovery}>
            {localStatus.state === "ready" && (
              <button
                type="button"
                className={s.recoveryBtn}
                onClick={handleRecoverLocal}
                disabled={transcribingLocal}
              >
                {transcribingLocal ? "Transcribing on-device…" : "Retry on-device (no audio leaves this phone)"}
              </button>
            )}
            {localStatus.state === "unloaded" && (
              <button
                type="button"
                className={s.recoveryBtn}
                onClick={handleRecoverLocal}
                disabled={pendingLocalRetry || transcribingLocal}
              >
                Download Whisper model (~40&nbsp;MB) &amp; retry on-device
              </button>
            )}
            {localStatus.state === "loading" && (
              <span className={s.recoveryHint}>
                Downloading Whisper model
                {localStatus.progress?.total
                  ? ` · ${Math.round((localStatus.progress.loaded / localStatus.progress.total) * 100)}%`
                  : "…"}
                {pendingLocalRetry ? " · will transcribe automatically when ready" : ""}
              </span>
            )}
            {localStatus.state === "error" && (
              <span className={s.recoveryHint}>
                On-device model failed to load. Open Setup → On-device transcription for details.
              </span>
            )}
          </div>
        )}

        {decoded && (
          <>
            {/* ── Headphone gate ─────────────────────────────────────────
                One-time per session. The segment list + submit buttons
                are not revealed until the reviewer confirms they have
                headphones on. State lives in React only — never persisted. */}
            {!headphoneConfirmed && (
              <div className={s.headphoneGate}>
                <span className={s.headphoneGateEyebrow}>Headphone review required</span>
                <p className={s.headphoneGateBody}>
                  For review accuracy, headphones must be worn. Each clip
                  plays 3&times; automatically before you can submit.
                </p>
                <label className={s.headphoneGateCheck}>
                  <input
                    type="checkbox"
                    checked={headphoneChecked}
                    onChange={(e) => setHeadphoneChecked(e.target.checked)}
                  />
                  I&apos;m wearing headphones
                </label>
                <button
                  type="button"
                  className={s.primaryBtn}
                  disabled={!headphoneChecked}
                  onClick={() => setHeadphoneConfirmed(true)}
                >
                  Confirm
                </button>
              </div>
            )}

            {/* ── Noise floor banner ─────────────────────────────────────
                Shown once the noise floor has been computed from the first
                10 s of the recording. */}
            {noiseFloor && (
              <div className={s.noiseFloorBanner}>
                <span className={s.noiseFloorLabel}>Noise floor</span>
                <span className={s.noiseFloorStat}>
                  p50: {noiseFloor.p50dBFS.toFixed(1)} dBFS
                </span>
                <span className={s.noiseFloorSep}>&middot;</span>
                <span className={s.noiseFloorStat}>
                  p95: {noiseFloor.p95dBFS.toFixed(1)} dBFS
                </span>
              </div>
            )}

            {/* Forensic file chrome — mono readout of the underlying WAV's
                technical properties. An external reviewer skimming the
                editor immediately sees the source format without having
                to ask: sample rate, channel count, bit depth, exact
                duration. Same idiom as the spirit-box instrument
                chrome. */}
            <div className={s.fileChrome}>
              <span className={s.fileChromeStat}>
                fmt <code>WAV · 16-bit · mono</code>
              </span>
              <span className={s.fileChromeStat}>
                sr <code>{decoded.sampleRate.toLocaleString()} Hz</code>
              </span>
              <span className={s.fileChromeStat}>
                dur <code>{formatTime(decoded.durationSec)}</code>
              </span>
              <span className={s.fileChromeStat}>
                samples <code>{decoded.samples.length.toLocaleString()}</code>
              </span>
            </div>
            {/* Tab bar — Waveform / Spectrogram */}
            <div className={s.tabBar}>
              <button
                type="button"
                className={`${s.tabBtn} ${activeTab === "waveform" ? s.tabBtnActive : ""}`}
                onClick={() => setActiveTab("waveform")}
              >
                Waveform
              </button>
              <button
                type="button"
                className={`${s.tabBtn} ${activeTab === "spectrogram" ? s.tabBtnActive : ""}`}
                onClick={() => setActiveTab("spectrogram")}
              >
                Spectrogram
              </button>
            </div>

            {activeTab === "waveform" && (
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
            )}

            {activeTab === "spectrogram" && (
              <SpectrogramViewer
                samples={decoded.samples}
                sampleRate={decoded.sampleRate}
                noiseFloor={noiseFloor ?? undefined}
                playheadS={currentTime}
                onSeek={(t) => {
                  const audio = audioRef.current;
                  if (audio) audio.currentTime = t;
                }}
                onMark={(t) => {
                  // Record a quick event marker at the clicked time.
                  const absMs = new Date(asset.timestamp_start).getTime() + Math.round(t * 1000);
                  void recordEvent({
                    investigation_id: asset.investigation_id,
                    source: "user",
                    event_type: "audio.spectrogram_mark",
                    title: "Spectrogram mark",
                    description: `Manual mark at ${t.toFixed(2)} s`,
                    linked_file: asset.file_path,
                    timestamp: new Date(absMs).toISOString(),
                    metadata: { offset_s: t, source_media_id: asset.id },
                  });
                }}
              />
            )}

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
                {selectionStats?.snrDb != null && (
                  <span className={
                    selectionStats.snrDb >= 6 ? s.snrChipGood
                    : selectionStats.snrDb >= 3 ? s.snrChipAmber
                    : s.snrChipBad
                  }>
                    SNR: {selectionStats.snrDb.toFixed(1)} dB
                  </span>
                )}
                {headphoneConfirmed && (
                  <span className={s.loopCounter}>
                    Loop {Math.min(loopCount + 1, 3)}/3
                    {loopCount >= 3 && " ✓"}
                  </span>
                )}
                {stereoAnalysis && (
                  <>
                    <span
                      className={stereoAnalysis.impossibleItd ? s.stereoChipWarn : s.stereoChip}
                      title="Inter-Aural Time Difference — positive = right-leading"
                    >
                      ITD: {stereoAnalysis.itdMs > 0 ? "+" : ""}{stereoAnalysis.itdMs.toFixed(2)} ms
                      {" · "}{Math.abs(stereoAnalysis.itdMs) <= 0.05 ? "centre" : stereoAnalysis.itdMs > 0 ? "→R" : "→L"}
                    </span>
                    <span
                      className={s.stereoChip}
                      title="Inter-Aural Level Difference — positive = left louder"
                    >
                      ILD: {stereoAnalysis.ildDb > 0 ? "+" : ""}{stereoAnalysis.ildDb.toFixed(1)} dB
                    </span>
                    {stereoAnalysis.conflictFlag && (
                      <span className={s.stereoChipConflict} title="ITD and ILD disagree on source direction">
                        ⚠ Direction conflict
                      </span>
                    )}
                    {stereoAnalysis.impossibleItd && (
                      <span className={s.stereoChipWarn} title="ITD exceeds human-head physical maximum — may reflect reverb or channel latency mismatch">
                        ⚠ ITD &gt; head max
                      </span>
                    )}
                  </>
                )}
              </div>
            )}

            <div className={s.tagPanel}>
              <div className={s.classGroup}>
                {REVIEWER_CLASSES.map((cls) => (
                  <label
                    key={cls.value}
                    className={`${s.classChip} ${reviewerClass === cls.value ? s.classChipActive : ""}`.trim()}
                    data-class={cls.value}
                  >
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

            {/* SNR override input — shown when SNR is below 3 dB and
                the reviewer explicitly wants to override the gate. */}
            {selectionStats?.snrDb != null && selectionStats.snrDb < 3 && !snrOverrideActive && (
              <div className={s.snrGateBanner}>
                <span className={s.snrGateText}>
                  SNR too low ({selectionStats.snrDb.toFixed(1)} dB) — instrument noise floor.
                  Submit is disabled. You may override with a documented reason.
                </span>
                <button
                  type="button"
                  className={s.snrOverrideBtn}
                  onClick={() => setSnrOverrideActive(true)}
                >
                  Override
                </button>
              </div>
            )}
            {snrOverrideActive && (
              <div className={s.snrOverrideRow}>
                <label className={s.field} style={{ flex: 1 }}>
                  <span className={s.fieldLabel}>Override reason (required)</span>
                  <input
                    type="text"
                    className={s.input}
                    value={snrOverrideReason}
                    onChange={(e) => setSnrOverrideReason(e.target.value)}
                    placeholder="State why this clip warrants review despite low SNR…"
                    maxLength={300}
                  />
                </label>
              </div>
            )}

            <div className={s.actionRow}>
              <button
                type="button"
                className={s.primaryBtn}
                onClick={handleSaveTag}
                disabled={!selection || savingTag || submitBlocked}
                title={submitTitle}
              >
                {savingTag ? "Saving…" : "Save tag"}
              </button>
              <button
                type="button"
                className={s.primaryBtn}
                onClick={handleSaveTrim}
                disabled={!selection || savingTrim || submitBlocked}
                title={submitTitle}
              >
                {savingTrim ? "Saving…" : "Save trim to case"}
              </button>
              {!cloudBlocked && (
                <button
                  type="button"
                  className={s.secondaryBtn}
                  onClick={handleTranscribe}
                  disabled={transcribing || transcribingLocal || signingUnsupported}
                  title={signingUnsupported
                    ? "Requires iOS 17 or later — Ed25519 signing is unavailable on this device."
                    : "Cloud transcription via Whisper. Blocked on culturally-sensitive cases."}
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
                {!cloudBlocked && (
                  <div className={s.deepReviewActionRow}>
                    <button
                      type="button"
                      className={s.deepReviewBtn}
                      onClick={handleDeepAiReview}
                      disabled={deepReviewBusy || signingUnsupported}
                      title={signingUnsupported
                        ? "Requires iOS 17 or later — Ed25519 signing is unavailable on this device."
                        : "Second-pass AI review against the venue dossier + baseline context. Audit-chained."}
                    >
                      {deepReviewBusy ? "Reviewing in context…" : "Deep AI review (in context)"}
                    </button>
                    {deepReview && (
                      <span className={s.deepReviewHint}>
                        Model: {deepReview.model}
                      </span>
                    )}
                  </div>
                )}
                {deepReviewErr && <p className={s.deepReviewErr}>{deepReviewErr}</p>}
              </div>
            )}

            {deepReview && (
              <div className={s.deepReviewCard}>
                <header className={s.deepReviewHead}>
                  <span className={s.deepReviewEyebrow}>DEEP AI REVIEW · IN CONTEXT</span>
                  <h3 className={s.deepReviewHeadline}>{deepReview.headline}</h3>
                </header>
                <div className={s.deepReviewMeterRow}>
                  <div className={s.deepReviewMeter}>
                    <span className={s.deepReviewMeterLabel}>Mundane fit</span>
                    <div className={s.deepReviewMeterBar}>
                      <div
                        className={s.deepReviewMeterFill}
                        style={{ width: `${Math.round(deepReview.mundaneScore * 100)}%` }}
                      />
                    </div>
                    <span className={s.deepReviewMeterValue}>{Math.round(deepReview.mundaneScore * 100)}%</span>
                  </div>
                  <div className={s.deepReviewMeter}>
                    <span className={s.deepReviewMeterLabel}>Pareidolia risk</span>
                    <div className={s.deepReviewMeterBar}>
                      <div
                        className={`${s.deepReviewMeterFill} ${s.deepReviewMeterFillWarn}`}
                        style={{ width: `${Math.round(deepReview.pareidoliaRisk * 100)}%` }}
                      />
                    </div>
                    <span className={s.deepReviewMeterValue}>{Math.round(deepReview.pareidoliaRisk * 100)}%</span>
                  </div>
                </div>
                {deepReview.contextNotes && (
                  <p className={s.deepReviewNotes}>{deepReview.contextNotes}</p>
                )}
                {deepReview.mundaneHypotheses.length > 0 && (
                  <div className={s.deepReviewBlock}>
                    <span className={s.deepReviewBlockHead}>Mundane hypotheses</span>
                    <ul className={s.deepReviewList}>
                      {deepReview.mundaneHypotheses.map((h, i) => (
                        <li key={i}>
                          <strong>{h.label}</strong> — {h.reasoning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {deepReview.dossierMatches.length > 0 && (
                  <div className={s.deepReviewBlock}>
                    <span className={s.deepReviewBlockHead}>Dossier matches</span>
                    <ul className={s.deepReviewList}>
                      {deepReview.dossierMatches.map((m, i) => (
                        <li key={i}>
                          <strong>{m.findingTitle}</strong> — {m.matchReason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {deepReview.falsificationProbe && (
                  <div className={s.deepReviewBlock}>
                    <span className={s.deepReviewBlockHead}>Falsification probe</span>
                    <p className={s.deepReviewProbe}>{deepReview.falsificationProbe}</p>
                  </div>
                )}
                {deepReview.citations && deepReview.citations.length > 0 && (
                  <div className={s.deepReviewBlock}>
                    <span className={s.deepReviewBlockHead}>Citations</span>
                    <ul className={s.deepReviewList}>
                      {deepReview.citations.map((c, i) => (
                        <li key={i}><a href={c} target="_blank" rel="noreferrer noopener">{c}</a></li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className={s.deepReviewFoot}>
                  Audit-chained as <code>audio.evp.deep_review</code> · model {deepReview.model}
                </p>
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
