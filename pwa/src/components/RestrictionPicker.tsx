/**
 * RestrictionPicker — sets the ICIP restriction level on a media asset or
 * evidence event before it leaves the device.
 *
 * Two modes
 *   compact=true  — inline styled <select> for list rows; tinted border when
 *                   a non-open level is active so it reads at a glance.
 *   compact=false — 5-option tile grid (same idiom as DispositionPicker),
 *                   plus a TK label reference block for non-open selections.
 *
 * The component is stateless — the caller persists the chosen level to the DB
 * and reflects the new value back via the `value` prop.
 *
 * Why this matters: Traditional Owners retain ICIP rights over recordings made
 * at culturally significant sites regardless of who holds the recording device.
 * Asset-level tagging lets the export bundle redact only the restricted items
 * rather than applying a coarse case-wide exclusion.
 */

import type { RestrictionLevel } from "../lib/db/schema";
import {
  ALL_RESTRICTION_LEVELS,
  RESTRICTION_LABELS,
  RESTRICTION_SHORT,
  tkLabelForRestriction,
} from "../lib/restricted/tkLabels";
import s from "./RestrictionPicker.module.css";

interface RestrictionPickerProps {
  value: RestrictionLevel;
  onChange: (level: RestrictionLevel) => void;
  /** Compact inline mode for list rows. Full tile grid when false (default). */
  compact?: boolean;
}

const TONE: Record<RestrictionLevel, string> = {
  open:              "muted",
  pending:           "warning",
  men_only:          "signal",
  women_only:        "signal",
  restricted_sacred: "danger",
};

export function RestrictionPicker({ value, onChange, compact = false }: RestrictionPickerProps) {
  if (compact) {
    return (
      <div className={s.selectWrap} data-tone={TONE[value]}>
        <select
          className={s.select}
          value={value}
          onChange={(e) => onChange(e.target.value as RestrictionLevel)}
          aria-label="ICIP restriction level"
        >
          {ALL_RESTRICTION_LEVELS.map((level) => (
            <option key={level} value={level}>{RESTRICTION_SHORT[level]}</option>
          ))}
        </select>
      </div>
    );
  }

  const tkLabel = tkLabelForRestriction(value);

  return (
    <div className={s.wrap} aria-label="Set ICIP restriction level">
      <header className={s.head}>
        <span className={s.eyebrow}>ICIP RESTRICTION</span>
        <span className={s.note}>Controls what leaves this device on export.</span>
      </header>
      <div className={s.grid}>
        {ALL_RESTRICTION_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            className={`${s.opt} ${s[TONE[level]]} ${value === level ? s.chosen : ""}`.trim()}
            onClick={() => onChange(level)}
          >
            <span className={s.optLabel}>{RESTRICTION_SHORT[level]}</span>
            <span className={s.optSub}>{RESTRICTION_LABELS[level]}</span>
          </button>
        ))}
      </div>
      {tkLabel && (
        <div className={s.tkNotice}>
          <strong className={s.tkName}>{tkLabel.name}</strong>
          <span className={s.tkDesc}>{tkLabel.description}</span>
          <a href={tkLabel.url} target="_blank" rel="noopener noreferrer" className={s.tkLink}>
            Full label ↗
          </a>
        </div>
      )}
    </div>
  );
}
