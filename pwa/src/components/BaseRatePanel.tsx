/**
 * BaseRatePanel — the skeptic's baseline. Renders per-investigator and
 * per-location null-result rates, computed from the disposition column.
 *
 * Why: a paranormal investigation app that only shows "interesting"
 * sessions is selection-biased. Showing the lifetime null rate alongside
 * any one session's posterior is the strongest single signal that we
 * take false-positives seriously.
 */

import { useEffect, useState } from "react";
import { query } from "../lib/db/db";
import type { Investigation } from "../lib/db/schema";
import s from "./BaseRatePanel.module.css";

interface BaseRateRow {
  label: string;
  total: number;
  null_rate: number;
  inconclusive_rate: number;
  flagged_rate: number;
  confirmed_mundane_rate: number;
}

function summarise(label: string, items: Investigation[]): BaseRateRow {
  const total = items.length || 1;
  const counts = { null: 0, inconclusive: 0, flagged: 0, confirmed_mundane: 0 } as Record<string, number>;
  for (const inv of items) {
    const d = inv.disposition || "null";
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return {
    label,
    total: items.length,
    null_rate: (counts.null ?? 0) / total,
    inconclusive_rate: (counts.inconclusive ?? 0) / total,
    flagged_rate: (counts.flagged ?? 0) / total,
    confirmed_mundane_rate: (counts.confirmed_mundane ?? 0) / total,
  };
}

export function BaseRatePanel() {
  const [lifetime, setLifetime] = useState<BaseRateRow | null>(null);
  const [byLocation, setByLocation] = useState<BaseRateRow[]>([]);

  useEffect(() => {
    void (async () => {
      const all = await query<Investigation>("SELECT * FROM investigations ORDER BY created_at ASC");
      setLifetime(summarise("Lifetime", all));
      const groups = new Map<string, Investigation[]>();
      for (const inv of all) {
        const key = inv.location_name || "(no location)";
        const arr = groups.get(key) ?? [];
        arr.push(inv);
        groups.set(key, arr);
      }
      setByLocation(
        Array.from(groups.entries())
          .map(([loc, items]) => summarise(loc, items))
          .sort((a, b) => b.total - a.total)
          .slice(0, 6),
      );
    })();
  }, []);

  if (!lifetime || lifetime.total === 0) return null;

  const renderRow = (row: BaseRateRow) => (
    <li key={row.label} className={s.row}>
      <div className={s.rowHead}>
        <span className={s.rowLabel}>{row.label}</span>
        <span className={s.rowCount}>n = {row.total}</span>
      </div>
      <div className={s.bar} role="img" aria-label={`Null ${(row.null_rate * 100).toFixed(0)}%, mundane ${(row.confirmed_mundane_rate * 100).toFixed(0)}%, inconclusive ${(row.inconclusive_rate * 100).toFixed(0)}%, flagged ${(row.flagged_rate * 100).toFixed(0)}%`}>
        <span className={s.segNull} style={{ flexGrow: row.null_rate || 0.0001 }} title={`Null ${(row.null_rate * 100).toFixed(0)}%`} />
        <span className={s.segMundane} style={{ flexGrow: row.confirmed_mundane_rate || 0.0001 }} title={`Confirmed mundane ${(row.confirmed_mundane_rate * 100).toFixed(0)}%`} />
        <span className={s.segInconclusive} style={{ flexGrow: row.inconclusive_rate || 0.0001 }} title={`Inconclusive ${(row.inconclusive_rate * 100).toFixed(0)}%`} />
        <span className={s.segFlagged} style={{ flexGrow: row.flagged_rate || 0.0001 }} title={`Flagged ${(row.flagged_rate * 100).toFixed(0)}%`} />
      </div>
      <div className={s.rowFooter}>
        <span className={s.swatch + " " + s.dotNull} /> Null {(row.null_rate * 100).toFixed(0)}%
        <span className={s.swatch + " " + s.dotMundane} /> Mundane {(row.confirmed_mundane_rate * 100).toFixed(0)}%
        <span className={s.swatch + " " + s.dotInconclusive} /> Inconclusive {(row.inconclusive_rate * 100).toFixed(0)}%
        <span className={s.swatch + " " + s.dotFlagged} /> Flagged {(row.flagged_rate * 100).toFixed(0)}%
      </div>
    </li>
  );

  return (
    <div className={s.wrap} aria-label="Base-rate dashboard">
      <header className={s.head}>
        <span className={s.eyebrow}>BASE RATES</span>
        <span className={s.note}>Disposition split — null results count.</span>
      </header>
      <ul className={s.list}>
        {renderRow(lifetime)}
        {byLocation.map(renderRow)}
      </ul>
    </div>
  );
}
