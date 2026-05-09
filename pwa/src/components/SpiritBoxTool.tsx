import { useCallback, useEffect, useRef, useState } from "react";
import { nextPhoneme, PHONEME_CORPUS } from "../lib/itc/phonemes";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./Tool.module.css";

interface SpiritBoxToolProps {
  /** Live entropy feed — magnetometer magnitude or accel magnitude. */
  entropy: number;
  investigationId?: string | null;
}

/**
 * Spirit Box (honest version): cycles through curated phonemes/morphemes
 * at a configurable interval, seeded from sensor entropy. Speaks each via
 * SpeechSynthesis. NOT a radio sweep.
 *
 * Behaviour notes:
 *   • SpeechSynthesis utterances queue. We `cancel()` before each new
 *     `speak()` so utterances never pile up beyond the cycle, and on
 *     stop we cancel the queue so audio stops *immediately*.
 *   • Tap a phoneme in the history strip to mark it as a meaningful
 *     response — that lands in the audit chain with a timestamp so the
 *     post-roll review can find it.
 *   • Volume slider is real (NOT cosmetic) — it's mapped to
 *     `utterance.volume` per cycle.
 */
export function SpiritBoxTool({ entropy, investigationId }: SpiritBoxToolProps) {
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState(280);
  const [volume, setVolume] = useState(0.85);
  const [current, setCurrent] = useState<string>("—");
  const [history, setHistory] = useState<string[]>([]);
  const [markedCount, setMarkedCount] = useState(0);
  const seedRef = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(0);
  const volumeRef = useRef<number>(volume);
  const intervalHandleRef = useRef<number | null>(null);

  useEffect(() => { entropyRef.current = entropy; }, [entropy]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  const stopSpeech = useCallback(() => {
    try {
      if (typeof speechSynthesis !== "undefined") {
        speechSynthesis.cancel();
      }
    } catch { /* some platforms throw on cancel before any speak — ignore */ }
  }, []);

  // Drive the speak loop while running.
  useEffect(() => {
    if (!running) return;
    intervalHandleRef.current = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setHistory((h) => [phoneme, ...h].slice(0, 24));
      try {
        // Cancel any in-flight utterance so cycle stays tight and audio
        // never piles up.
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(phoneme);
        utterance.rate = 1.4;
        utterance.volume = volumeRef.current;
        speechSynthesis.speak(utterance);
      } catch { /* speechSynthesis may throw before user gesture */ }
    }, intervalMs);
    return () => {
      if (intervalHandleRef.current != null) {
        window.clearInterval(intervalHandleRef.current);
        intervalHandleRef.current = null;
      }
      stopSpeech();
    };
  }, [running, intervalMs, stopSpeech]);

  // Final cleanup on unmount — also kills any audio that hadn't ticked yet.
  useEffect(() => {
    return () => {
      if (intervalHandleRef.current != null) {
        window.clearInterval(intervalHandleRef.current);
        intervalHandleRef.current = null;
      }
      stopSpeech();
    };
  }, [stopSpeech]);

  // Stop speech on browser tab hide so it doesn't keep cycling in the
  // background.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stopSpeech();
        setRunning(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stopSpeech]);

  const handleToggle = async () => {
    if (running) {
      stopSpeech();
      setRunning(false);
      if (investigationId) {
        try {
          await recordEvent({
            investigation_id: investigationId,
            source: "user",
            event_type: "tool.spirit_box_stop",
            title: "Spirit box stopped",
            metadata: { interval_ms: intervalMs, volume, history_size: history.length },
          });
        } catch { /* don't crash UI */ }
      }
      return;
    }
    setRunning(true);
    if (investigationId) {
      try {
        await recordEvent({
          investigation_id: investigationId,
          source: "user",
          event_type: "tool.spirit_box_start",
          title: "Spirit box started",
          metadata: { interval_ms: intervalMs, volume, corpus_size: PHONEME_CORPUS.length },
        });
      } catch { /* ignore */ }
    }
  };

  const handleMarkPhoneme = async (phoneme: string) => {
    if (!investigationId) return;
    try {
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "tool.spirit_box_mark",
        title: `Marked: "${phoneme}"`,
        description: `Reviewer flagged the spirit box token "${phoneme}" as a meaningful response.`,
        metadata: { phoneme, marked_at: new Date().toISOString(), interval_ms: intervalMs },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "tool.spirit_box.mark",
        payload: { investigation_id: investigationId, phoneme, marked_at: new Date().toISOString() },
      });
      setMarkedCount((n) => n + 1);
    } catch { /* ignore */ }
  };

  const handleClearHistory = () => {
    setHistory([]);
    setCurrent("—");
  };

  return (
    <div className={s.tool}>
      <header className={s.toolHeader}>
        <span className={s.toolEyebrow}>SPIRIT BOX</span>
        <button
          type="button"
          className={running ? s.toolStop : s.toolStart}
          onClick={handleToggle}
        >
          {running ? "Stop" : "Start"}
        </button>
      </header>

      <div className={s.toolDisplay}>
        <span className={s.toolDisplayValue}>{current}</span>
      </div>

      <div className={s.toolHistory}>
        {history.length === 0 ? (
          <span className={s.toolHistoryEmpty}>tap a token to mark it as a response</span>
        ) : (
          history.map((h, i) => (
            <button
              key={`${i}-${h}`}
              type="button"
              className={s.toolHistoryItem}
              onClick={() => handleMarkPhoneme(h)}
              disabled={!investigationId}
              title={investigationId ? "Mark as meaningful response" : "Begin a session to mark"}
            >
              {h}
            </button>
          ))
        )}
      </div>

      <div className={s.toolControls}>
        <label className={s.toolControl}>
          <span>Cycle (ms)</span>
          <input
            type="range"
            min={180}
            max={500}
            step={20}
            value={intervalMs}
            onChange={(e) => setIntervalMs(parseInt(e.target.value, 10))}
          />
          <span className={s.toolControlValue}>{intervalMs}</span>
        </label>
        <label className={s.toolControl}>
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
          />
          <span className={s.toolControlValue}>{Math.round(volume * 100)}%</span>
        </label>
        <button
          type="button"
          className={s.toolGhostBtn}
          onClick={handleClearHistory}
          disabled={history.length === 0}
        >
          Clear history
        </button>
      </div>

      <p className={s.toolNote}>
        Cycles through {PHONEME_CORPUS.length} curated phonemes seeded by sensor entropy. <strong>Not a radio sweep</strong> — that capability does not exist in mobile browsers. Tap any history token to mark it as a meaningful response in the audit chain
        {markedCount > 0 ? <> · <strong>{markedCount}</strong> marked this session</> : null}
        .
      </p>
    </div>
  );
}
