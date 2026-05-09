/**
 * BaitToneTool — UI for the sub-audible bait-tone generator.
 *
 * Honest framing baked in: the disclaimer block is non-dismissable and
 * states upfront that phone speakers can't reproduce the SPL-coupled
 * infrasound effects from the literature. Use this as a marker, not a
 * causal stimulator.
 */

import { useEffect, useRef, useState } from "react";
import { BaitToneEngine } from "../lib/audio/baitTone";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./BaitToneTool.module.css";

interface Props {
  investigationId: string | null;
}

export function BaitToneTool({ investigationId }: Props) {
  const engineRef = useRef<BaitToneEngine | null>(null);
  const [running, setRunning] = useState(false);
  const [frequency, setFrequency] = useState(18);
  const [gain, setGain] = useState(0.15);
  const [sweep, setSweep] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureEngine = () => {
    if (!engineRef.current) {
      engineRef.current = new BaitToneEngine({
        frequencyHz: frequency,
        gain,
        sweepRangeHz: sweep ? 4 : 0,
        sweepPeriodSec: sweep ? 12 : 0,
      });
    }
    return engineRef.current;
  };

  const handleToggle = async () => {
    const engine = ensureEngine();
    if (running) {
      const { durationMs } = engine.stop();
      setRunning(false);
      if (investigationId) {
        try {
          await recordEvent({
            investigation_id: investigationId,
            source: "user",
            event_type: "bait.tone_stop",
            title: "Bait tone stopped",
            metadata: { duration_ms: durationMs, last_frequency_hz: frequency, last_gain: gain, sweep },
          });
          await appendAuditEntry({
            actor: "user",
            kind: "bait.tone.stop",
            payload: { investigation_id: investigationId, duration_ms: durationMs, frequency_hz: frequency, gain },
          });
        } catch { /* don't crash UI on audit failure */ }
      }
      return;
    }
    try {
      engine.setOptions({
        frequencyHz: frequency,
        gain,
        sweepRangeHz: sweep ? 4 : 0,
        sweepPeriodSec: sweep ? 12 : 0,
      });
      engine.start();
      setRunning(true);
      setError(null);
      if (investigationId) {
        try {
          await recordEvent({
            investigation_id: investigationId,
            source: "user",
            event_type: "bait.tone_start",
            title: `Bait tone started · ${frequency.toFixed(1)} Hz`,
            metadata: { frequency_hz: frequency, gain, sweep, sweep_range_hz: sweep ? 4 : 0 },
          });
          await appendAuditEntry({
            actor: "user",
            kind: "bait.tone.start",
            payload: { investigation_id: investigationId, frequency_hz: frequency, gain, sweep },
          });
        } catch { /* ignore */ }
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Live param updates while running.
  useEffect(() => {
    if (!engineRef.current || !running) return;
    engineRef.current.setOptions({
      frequencyHz: frequency,
      gain,
      sweepRangeHz: sweep ? 4 : 0,
      sweepPeriodSec: sweep ? 12 : 0,
    });
  }, [frequency, gain, sweep, running]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try { engineRef.current?.stop(); } catch { /* ignore */ }
    };
  }, []);

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}>BAIT · INFRASOUND CARRIER</span>
        <span className={s.note}>17–19 Hz literature anchor · sweep optional</span>
      </header>

      <div className={s.controls}>
        <label className={s.field}>
          <span className={s.fieldLabel}>Frequency</span>
          <span className={s.fieldValue}>{frequency.toFixed(1)} Hz</span>
          <input
            type="range"
            min={14}
            max={22}
            step={0.1}
            value={frequency}
            onChange={(e) => setFrequency(parseFloat(e.target.value))}
          />
        </label>
        <label className={s.field}>
          <span className={s.fieldLabel}>Gain</span>
          <span className={s.fieldValue}>{(gain * 100).toFixed(0)}%</span>
          <input
            type="range"
            min={0}
            max={0.35}
            step={0.01}
            value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
          />
        </label>
        <label className={s.checkbox}>
          <input type="checkbox" checked={sweep} onChange={(e) => setSweep(e.target.checked)} />
          <span>Sweep ±2 Hz / 12 s</span>
        </label>
      </div>

      <button
        type="button"
        className={running ? s.stopBtn : s.startBtn}
        onClick={handleToggle}
        disabled={!investigationId}
      >
        {running ? "Stop carrier" : investigationId ? "Start carrier" : "Begin a session first"}
      </button>

      {error && <p className={s.error}>{error}</p>}

      <p className={s.disclaimer}>
        Phone speakers cannot reproduce the SPL-coupled physiological effects from the Tandy / NASA infrasound literature.
        Treat this as a <strong>timed marker</strong> in the audit chain — useful for synchronising review against a known
        carrier — not as a causal stimulator. Hard gain cap is 35% to protect the speaker.
      </p>
    </div>
  );
}
