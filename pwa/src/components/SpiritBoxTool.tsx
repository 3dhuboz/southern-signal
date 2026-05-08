import { useEffect, useRef, useState } from "react";
import { nextPhoneme, PHONEME_CORPUS } from "../lib/itc/phonemes";
import s from "./Tool.module.css";

interface SpiritBoxToolProps {
  /** Live entropy feed — magnetometer magnitude or accel magnitude. */
  entropy: number;
}

/**
 * Spirit Box (honest version): cycles through curated phonemes/morphemes
 * at a configurable interval, seeded from sensor entropy. Speaks each via
 * SpeechSynthesis. NOT a radio sweep.
 */
export function SpiritBoxTool({ entropy }: SpiritBoxToolProps) {
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState(220);
  const [current, setCurrent] = useState<string>("—");
  const [history, setHistory] = useState<string[]>([]);
  const seedRef = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(0);

  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setHistory((h) => [phoneme, ...h].slice(0, 12));
      try {
        const utterance = new SpeechSynthesisUtterance(phoneme);
        utterance.rate = 1.4;
        utterance.volume = 0.85;
        speechSynthesis.speak(utterance);
      } catch { /* speechSynthesis may throw on first use until user gesture */ }
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [running, intervalMs]);

  return (
    <div className={s.tool}>
      <header className={s.toolHeader}>
        <span className={s.toolEyebrow}>SPIRIT BOX</span>
        <button
          type="button"
          className={running ? s.toolStop : s.toolStart}
          onClick={() => setRunning((v) => !v)}
        >
          {running ? "Stop" : "Start"}
        </button>
      </header>

      <div className={s.toolDisplay}>
        <span className={s.toolDisplayValue}>{current}</span>
      </div>

      <div className={s.toolHistory}>
        {history.length === 0 ? <span className={s.toolHistoryEmpty}>—</span> : history.map((h, i) => (
          <span key={i} className={s.toolHistoryItem}>{h}</span>
        ))}
      </div>

      <div className={s.toolControls}>
        <label className={s.toolControl}>
          <span>Cycle (ms)</span>
          <input
            type="range"
            min={100}
            max={500}
            step={20}
            value={intervalMs}
            onChange={(e) => setIntervalMs(parseInt(e.target.value, 10))}
          />
          <span className={s.toolControlValue}>{intervalMs}</span>
        </label>
      </div>

      <p className={s.toolNote}>
        Cycles through {PHONEME_CORPUS.length} curated phonemes seeded by sensor entropy. <strong>Not a radio sweep</strong> — that capability does not exist in mobile browsers. The corpus and randomness are inspectable.
      </p>
    </div>
  );
}
