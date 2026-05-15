import { useCallback, useEffect, useRef, useState } from "react";
import { recordEvent } from "../lib/db/repo";
import { OVILUS_DICTIONARY, nextOvilusWord } from "../lib/itc/ovilusDictionary";
import { setOvilusEmission } from "./../lib/itc/itcChannels";
import s from "./Tool.module.css";

interface OvilusToolProps {
  /** Magnetometer (Android) or compass-heading (iOS) entropy. */
  entropy: number;
  investigationId: string | null;
}

/**
 * Ovilus-style word generator. Honest framing: deterministic seeded RNG
 * indexes a curated dictionary. Output is logged as a tool_emit event so
 * investigators can correlate words with sensor changes after the fact.
 */
export function OvilusTool({ entropy, investigationId }: OvilusToolProps) {
  const [autoEmit, setAutoEmit] = useState(false);
  const [intervalMs, setIntervalMs] = useState(8000);
  const [current, setCurrent] = useState<string>("—");
  const [history, setHistory] = useState<string[]>([]);
  const seedRef = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(0);

  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  const emit = useCallback(async () => {
    const { word, nextSeed } = nextOvilusWord(seedRef.current, entropyRef.current);
    seedRef.current = nextSeed;
    setCurrent(word);
    setHistory((h) => [word, ...h].slice(0, 16));
    // Publish to the live overlay channel.
    setOvilusEmission(word);
    try {
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.rate = 0.95;
      speechSynthesis.speak(utterance);
    } catch { /* requires user gesture on iOS first time */ }
    if (investigationId) {
      void recordEvent({
        investigation_id: investigationId,
        source: "ai",
        event_type: "tool_emit",
        title: word,
        description: "Ovilus word generator",
        metadata: { tool: "ovilus", entropy: entropyRef.current },
      });
    }
  }, [investigationId]);

  useEffect(() => {
    if (!autoEmit) return;
    const handle = window.setInterval(emit, intervalMs);
    return () => window.clearInterval(handle);
  }, [autoEmit, intervalMs, emit]);

  return (
    <div className={s.tool}>
      <header className={s.toolHeader}>
        <span className={s.toolEyebrow}>OVILUS</span>
        <div className={s.toolHeaderActions}>
          <button type="button" className={s.toolStart} onClick={emit}>Emit</button>
          <button
            type="button"
            className={autoEmit ? s.toolStop : s.toolSecondary}
            onClick={() => setAutoEmit((v) => !v)}
          >
            {autoEmit ? "Auto: on" : "Auto: off"}
          </button>
        </div>
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
          <span>Auto-emit (ms)</span>
          <input
            type="range"
            min={2000}
            max={30000}
            step={500}
            value={intervalMs}
            onChange={(e) => setIntervalMs(parseInt(e.target.value, 10))}
          />
          <span className={s.toolControlValue}>{(intervalMs / 1000).toFixed(1)}s</span>
        </label>
      </div>

      <p className={s.toolNote}>
        Sensor entropy seeds a {OVILUS_DICTIONARY.length}-word dictionary. Each emit is logged with the entropy reading at the moment of emission so you can verify correlation later.
      </p>
    </div>
  );
}
