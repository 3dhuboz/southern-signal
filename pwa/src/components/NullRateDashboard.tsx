/**
 * NullRateDashboard — Negative Results Base-Rate Dashboard.
 *
 * Tier 1 #3: surfaces the lifetime null-rate banner and a per-location
 * breakdown table so investigators can see their base rates at a glance.
 * Only completed sessions (WHERE disposition IS NOT NULL) count — a
 * session without a disposition means the investigator hasn't closed it,
 * so including it would deflate the null rate.
 *
 * Visual approach: dense mono labels, subtle borders, inline bar-chart
 * segments (no chart library). Null% colored amber >60%, green <30%.
 */

import { useEffect, useState } from "react";
import { getLifetimeBaseRate, getLocationBaseRates } from "../lib/db/repo";
import type { LifetimeBaseRate, LocationBaseRate } from "../lib/db/repo";
import s from "./NullRateDashboard.module.css";

interface NullRateDashboardProps {
  className?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function nullRateClass(rate: number): string {
  if (rate > 0.6) return s.nullHigh;
  if (rate < 0.3) return s.nullLow;
  return "";
}

export function NullRateDashboard({ className }: NullRateDashboardProps) {
  const [lifetime, setLifetime] = useState<LifetimeBaseRate | null>(null);
  const [locations, setLocations] = useState<LocationBaseRate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [lt, locs] = await Promise.all([
          getLifetimeBaseRate(),
          getLocationBaseRates(),
        ]);
        setLifetime(lt);
        setLocations(locs);
      } catch (err) {
        setError((err as Error).message ?? "Failed to load base rates.");
      }
    })();
  }, []);

  const loading = lifetime === null && locations === null && error === null;
  const empty = lifetime !== null && lifetime.total === 0;

  return (
    <details className={`${s.wrap}${className ? ` ${className}` : ""}`} open>
      <summary className={s.summary}>
        <span className={s.summaryEyebrow}>BASE RATES</span>
        {lifetime !== null && lifetime.total > 0 && (
          <span className={s.summaryMeta}>
            {lifetime.total} sessions
          </span>
        )}
      </summary>

      <div className={s.body}>
        {/* Error state */}
        {error && (
          <p className={s.errorMsg}>{error}</p>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className={s.skeleton} aria-label="Loading base rates…">
            <div className={s.skeletonBanner} />
            <div className={s.skeletonRow} />
            <div className={s.skeletonRow} />
          </div>
        )}

        {/* Empty state */}
        {empty && !loading && (
          <p className={s.empty}>No completed sessions yet. Close a session and set its disposition to see base rates.</p>
        )}

        {/* Lifetime banner */}
        {lifetime !== null && lifetime.total > 0 && (
          <div className={s.banner} aria-label="Lifetime base rate">
            <span className={s.bannerStat}>
              <span className={s.bannerValue}>{lifetime.total}</span>
              <span className={s.bannerLabel}>sessions</span>
            </span>
            <span className={s.bannerDivider} aria-hidden="true">·</span>
            <span className={s.bannerStat}>
              <span className={`${s.bannerValue} ${nullRateClass(lifetime.null_rate)}`}>
                {pct(lifetime.null_rate)}
              </span>
              <span className={s.bannerLabel}>null</span>
            </span>
            <span className={s.bannerDivider} aria-hidden="true">·</span>
            <span className={s.bannerStat}>
              <span className={s.bannerValue}>{pct(lifetime.flagged_rate)}</span>
              <span className={s.bannerLabel}>flagged</span>
            </span>
            <span className={s.bannerDivider} aria-hidden="true">·</span>
            <span className={s.bannerStat}>
              <span className={s.bannerValue}>
                {pct(lifetime.total > 0 ? lifetime.inconclusive_count / lifetime.total : 0)}
              </span>
              <span className={s.bannerLabel}>inconclusive</span>
            </span>
          </div>
        )}

        {/* Per-location table */}
        {locations !== null && locations.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table} aria-label="Per-location base rates">
              <thead>
                <tr className={s.thead}>
                  <th className={s.thLocation}>Location</th>
                  <th className={s.thNum}>Sessions</th>
                  <th className={s.thNum}>Null%</th>
                  <th className={s.thNum}>Flagged%</th>
                  <th className={s.thNum}>Incon%</th>
                  <th className={s.thNum}>Mundane%</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((loc) => {
                  const flaggedRate = loc.total > 0 ? loc.flagged_count / loc.total : 0;
                  const inconclusiveRate = loc.total > 0 ? loc.inconclusive_count / loc.total : 0;
                  const mundaneRate = loc.total > 0 ? loc.confirmed_mundane_count / loc.total : 0;
                  return (
                    <tr key={loc.location_name} className={s.trow}>
                      <td className={s.tdLocation}>{loc.location_name}</td>
                      <td className={s.tdNum}>{loc.total}</td>
                      <td className={s.tdBar}>
                        <span className={s.barCell} role="img" aria-label={pct(loc.null_rate)}>
                          <span
                            className={`${s.barFill} ${s.barNull} ${nullRateClass(loc.null_rate)}`}
                            style={{ width: pct(loc.null_rate) }}
                          />
                          <span className={s.barPct}>{pct(loc.null_rate)}</span>
                        </span>
                      </td>
                      <td className={s.tdBar}>
                        <span className={s.barCell} role="img" aria-label={pct(flaggedRate)}>
                          <span
                            className={`${s.barFill} ${s.barFlagged}`}
                            style={{ width: pct(flaggedRate) }}
                          />
                          <span className={s.barPct}>{pct(flaggedRate)}</span>
                        </span>
                      </td>
                      <td className={s.tdBar}>
                        <span className={s.barCell} role="img" aria-label={pct(inconclusiveRate)}>
                          <span
                            className={`${s.barFill} ${s.barInconclusive}`}
                            style={{ width: pct(inconclusiveRate) }}
                          />
                          <span className={s.barPct}>{pct(inconclusiveRate)}</span>
                        </span>
                      </td>
                      <td className={s.tdBar}>
                        <span className={s.barCell} role="img" aria-label={pct(mundaneRate)}>
                          <span
                            className={`${s.barFill} ${s.barMundane}`}
                            style={{ width: pct(mundaneRate) }}
                          />
                          <span className={s.barPct}>{pct(mundaneRate)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
