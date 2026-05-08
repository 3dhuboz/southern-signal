/**
 * DispositionPicker — appears immediately after a session stops. Forces
 * the investigator to classify the session before moving on:
 *
 *   • Null         — nothing happened
 *   • Inconclusive — something but not enough
 *   • Flagged      — interesting; deserves further review
 *   • Mundane      — explained at the time (e.g. HVAC kick caught us)
 *
 * Why mandatory: without explicit dispositions the database silently
 * collects only the "interesting" sessions, and the base-rate panel
 * lies. A picker that's hard to skip is the cheapest way to keep the
 * data honest.
 */

import { useCallback, useState } from "react";
import { setDisposition } from "../lib/db/repo";
import s from "./DispositionPicker.module.css";

type Disposition = "null" | "inconclusive" | "flagged" | "confirmed_mundane";

interface DispositionPickerProps {
  investigationId: string;
  onChosen: (d: Disposition) => void;
}

const OPTIONS: { id: Disposition; label: string; sub: string; tone: string }[] = [
  { id: "null", label: "Null", sub: "Nothing happened", tone: "muted" },
  { id: "inconclusive", label: "Inconclusive", sub: "Something — not enough", tone: "warning" },
  { id: "flagged", label: "Flagged", sub: "Worth reviewing", tone: "danger" },
  { id: "confirmed_mundane", label: "Mundane", sub: "Explained at the time", tone: "signal" },
];

export function DispositionPicker({ investigationId, onChosen }: DispositionPickerProps) {
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Disposition | null>(null);

  const handle = useCallback(async (d: Disposition) => {
    setBusy(true);
    setChosen(d);
    try {
      await setDisposition(investigationId, d);
      onChosen(d);
    } finally {
      setBusy(false);
    }
  }, [investigationId, onChosen]);

  return (
    <div className={s.wrap} aria-label="Classify session disposition">
      <header className={s.head}>
        <span className={s.eyebrow}>CLASSIFY THIS SESSION</span>
        <span className={s.note}>Required — feeds the base-rate dashboard.</span>
      </header>
      <div className={s.grid}>
        {OPTIONS.map((opt) => {
          const isChosen = chosen === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className={`${s.opt} ${s[opt.tone]} ${isChosen ? s.chosen : ""}`.trim()}
              onClick={() => handle(opt.id)}
              disabled={busy && !isChosen}
            >
              <span className={s.optLabel}>{opt.label}</span>
              <span className={s.optSub}>{opt.sub}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
