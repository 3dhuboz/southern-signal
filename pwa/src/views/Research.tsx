/**
 * Research — AI Investigator (venue archive deep-dive).
 *
 * Standalone tool: take a venue name + optional location hint, run a
 * cited deep search across Australian (or global) authoritative sources
 * via /api/ai/research, surface findings sorted by tier (HERITAGE,
 * DOCUMENTED_INCIDENT, CULTURAL_SIGNIFICANCE, FOLKLORE, SYNTHESIS) so
 * the operator can adjust EVP questions / contamination markers in
 * real time without leaving the site.
 *
 * Forensic guarantees the operator can rely on:
 *   - Every finding ships with the sources it was derived from. No
 *     sources → tier auto-downgrades to SYNTHESIS on the server.
 *   - Run start + complete both fire audit-chain entries so an external
 *     reviewer can trace what was researched and when.
 *   - Hard-blocked on culturally-sensitive sites (both client gate and
 *     server defence-in-depth).
 *   - 3 runs / device / 24h soft cap via localStorage, surfaced in the
 *     UI so operators see what they've used.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../lib/session";
import { usePreferences } from "../lib/preferences";
import {
  runResearch,
  getResearchRateState,
  ResearchRateLimitError,
  type ResearchResult,
  type ResearchFinding,
  type ResearchTier,
} from "../lib/research/api";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./View.module.css";
import r from "./Research.module.css";

const TIER_ORDER: ResearchTier[] = [
  "CULTURAL_SIGNIFICANCE",
  "HERITAGE",
  "DOCUMENTED_INCIDENT",
  "FOLKLORE",
  "SYNTHESIS",
];

const TIER_META: Record<ResearchTier, { label: string; description: string; tone: "warning" | "signal" | "neutral" | "muted" }> = {
  CULTURAL_SIGNIFICANCE: {
    label: "CULTURAL SIGNIFICANCE",
    description: "Country, sacred sites, contested histories — proceed only with Land Council consent.",
    tone: "warning",
  },
  HERITAGE: {
    label: "HERITAGE",
    description: "Government register entries, architectural history, building lifecycle.",
    tone: "signal",
  },
  DOCUMENTED_INCIDENT: {
    label: "DOCUMENTED INCIDENT",
    description: "Court / news / BDM primary-source events.",
    tone: "signal",
  },
  FOLKLORE: {
    label: "FOLKLORE",
    description: "Ghost tours, blogs, anecdotes — unverified, low prior.",
    tone: "neutral",
  },
  SYNTHESIS: {
    label: "SYNTHESIS — UNVERIFIED",
    description: "Model inference, no primary source. Verify before acting.",
    tone: "muted",
  },
};

function groupByTier(findings: ResearchFinding[]): Map<ResearchTier, ResearchFinding[]> {
  const map = new Map<ResearchTier, ResearchFinding[]>();
  for (const f of findings) {
    const list = map.get(f.tier) ?? [];
    list.push(f);
    map.set(f.tier, list);
  }
  return map;
}

function formatResetIn(ms: number | null): string {
  if (ms == null) return "";
  if (ms <= 0) return "";
  const hrs = ms / 3_600_000;
  if (hrs >= 1) return `Resets in ~${hrs.toFixed(1)}h`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `Resets in ~${mins}m`;
}

export function Research() {
  const session = useSession();
  const [prefs] = usePreferences();
  const [venueName, setVenueName] = useState<string>("");
  const [locationHint, setLocationHint] = useState<string>("");
  const [region, setRegion] = useState<"AU" | "GLOBAL">("AU");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [rate, setRate] = useState(() => getResearchRateState());

  // Prefill venue from the active investigation if it has a location_name.
  useEffect(() => {
    const inv = session.current;
    if (!inv) return;
    if (!venueName && inv.location_name) setVenueName(inv.location_name);
    if (!venueName && inv.title) setVenueName(inv.title);
    // intentionally not depending on venueName so first-load prefill wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  const culturallyBlocked = prefs.globalCulturalSensitivityFlag || (session.current?.culturally_sensitive === 1);
  const rateBlocked = rate.used >= rate.cap;
  const canRun = venueName.trim().length >= 2 && !busy && !culturallyBlocked && !rateBlocked;

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const startedAtMs = Date.now();
    const investigationId = session.current?.id ?? null;

    // Audit-chain OPEN — record what we're about to research.
    if (investigationId) {
      void recordEvent({
        investigation_id: investigationId,
        source: "ai",
        event_type: "research.ai_investigator_run",
        title: `AI Investigator — ${venueName.trim()}`,
        metadata: {
          venue: venueName.trim(),
          location_hint: locationHint.trim() || null,
          region,
          phase: "open",
          started_at_ms: startedAtMs,
        },
      }).catch(() => { /* don't break UI */ });
      void appendAuditEntry({
        actor: "ai",
        kind: "research.ai_investigator.open",
        payload: {
          investigation_id: investigationId,
          venue: venueName.trim(),
          location_hint: locationHint.trim() || null,
          region,
          started_at_ms: startedAtMs,
        },
      }).catch(() => { /* */ });
    }

    try {
      const res = await runResearch({
        venueName: venueName.trim(),
        locationHint: locationHint.trim() || undefined,
        region,
        culturallySensitive: culturallyBlocked,
      });
      setResult(res);
      setRate(getResearchRateState());
      const endedAtMs = Date.now();
      if (investigationId) {
        void appendAuditEntry({
          actor: "ai",
          kind: "research.ai_investigator.close",
          payload: {
            investigation_id: investigationId,
            venue: venueName.trim(),
            region,
            started_at_ms: startedAtMs,
            ended_at_ms: endedAtMs,
            duration_ms: endedAtMs - startedAtMs,
            findings_count: res.findings.length,
            citations_count: res.citations_raw.length,
            model: res.model,
            warnings: res.warnings,
          },
        }).catch(() => { /* */ });
        // Persist each finding as a research.finding event so the
        // Review timeline + Evidence Brief can see them.
        for (const f of res.findings) {
          void recordEvent({
            investigation_id: investigationId,
            source: "ai",
            event_type: "research.finding",
            title: `${TIER_META[f.tier].label} — ${f.title}`,
            description: f.body,
            metadata: {
              tier: f.tier,
              sources: f.sources,
              venue: venueName.trim(),
              region,
              model: res.model,
            },
          }).catch(() => { /* */ });
        }
      }
    } catch (err) {
      if (err instanceof ResearchRateLimitError) {
        setError(err.message);
      } else {
        setError((err as Error).message || "Research failed.");
      }
      setRate(getResearchRateState());
    } finally {
      setBusy(false);
    }
  }, [canRun, venueName, locationHint, region, culturallyBlocked, session]);

  const grouped = useMemo(() => result ? groupByTier(result.findings) : new Map<ResearchTier, ResearchFinding[]>(), [result]);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>AI Investigator · Archive deep-dive</span>
        <h1 className={s.title}>Venue research</h1>
        <p className={s.lede}>
          Walk the archives without leaving site. Pull heritage records, court files, news reports,
          Country / Land Council context, and folklore tiers for the venue — every claim
          comes back cited.
        </p>
      </div>

      {culturallyBlocked && (
        <div className={r.blockedCard}>
          <strong className={r.blockedTitle}>Hard-blocked — cultural sensitivity</strong>
          <p className={r.blockedBody}>
            This site is flagged as culturally sensitive
            {prefs.globalCulturalSensitivityFlag ? " (device-wide setting)" : " (this case)"}.
            The AI Investigator routes data off-device and is refused on sensitive sites.
            Contact the relevant Local Aboriginal Land Council (or equivalent custodial body) for
            consent before researching this venue.{" "}
            <Link to="/setup" className={r.blockedLink}>Manage sensitivity in Setup →</Link>
          </p>
        </div>
      )}

      <div className={r.formCard}>
        <label className={r.field}>
          <span className={r.fieldLabel}>Venue name</span>
          <input
            type="text"
            className={r.input}
            value={venueName}
            onChange={(e) => setVenueName(e.target.value)}
            placeholder="e.g. Old Marrickville Court House"
            disabled={busy || culturallyBlocked}
            maxLength={200}
          />
        </label>
        <label className={r.field}>
          <span className={r.fieldLabel}>Location hint (optional)</span>
          <input
            type="text"
            className={r.input}
            value={locationHint}
            onChange={(e) => setLocationHint(e.target.value)}
            placeholder="e.g. Sydney, NSW · or full address"
            disabled={busy || culturallyBlocked}
            maxLength={200}
          />
        </label>
        <div className={r.regionRow}>
          <span className={r.fieldLabel}>Region</span>
          <div className={r.segmented} role="radiogroup" aria-label="Region">
            <button
              type="button"
              role="radio"
              aria-checked={region === "AU"}
              className={`${r.segmentedOpt} ${region === "AU" ? r.segmentedOptActive : ""}`.trim()}
              onClick={() => setRegion("AU")}
              disabled={busy || culturallyBlocked}
            >
              Australia
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={region === "GLOBAL"}
              className={`${r.segmentedOpt} ${region === "GLOBAL" ? r.segmentedOptActive : ""}`.trim()}
              onClick={() => setRegion("GLOBAL")}
              disabled={busy || culturallyBlocked}
            >
              Global
            </button>
          </div>
        </div>

        <div className={r.runRow}>
          <button
            type="button"
            className={`btn btn-primary ${r.runBtn}`}
            onClick={handleRun}
            disabled={!canRun}
          >
            {busy ? "Walking the archives…" : "Run AI Investigator"}
          </button>
          <span className={r.rateNote}>
            <span className={rateBlocked ? r.rateNoteUsed : r.rateNoteOk}>
              {rate.used}/{rate.cap} runs today
            </span>
            {rateBlocked && rate.nextResetMs != null && (
              <span className={r.rateReset}> · {formatResetIn(rate.nextResetMs)}</span>
            )}
          </span>
        </div>

        {error && <p className={r.error}>{error}</p>}
      </div>

      {result && (
        <div className={r.resultsBlock}>
          <header className={r.resultsHead}>
            <span className={r.resultsEyebrow}>FINDINGS</span>
            <span className={r.resultsMeta}>
              {result.findings.length} tiered · {result.citations_raw.length} citations · model{" "}
              <code>{result.model.replace(/^.*\//, "")}</code>
            </span>
          </header>

          {result.findings.length === 0 ? (
            <p className={r.emptyFindings}>
              No archival footprint found for this venue.{" "}
              {result.suggestions.length > 0 ? "See suggestions below." : "Try a more specific location hint."}
            </p>
          ) : (
            <div className={r.findingsList}>
              {TIER_ORDER.map((tier) => {
                const items = grouped.get(tier);
                if (!items || items.length === 0) return null;
                const meta = TIER_META[tier];
                return (
                  <section key={tier} className={`${r.tierGroup} ${r[`tone_${meta.tone}`]}`.trim()}>
                    <header className={r.tierHead}>
                      <span className={r.tierLabel}>{meta.label}</span>
                      <span className={r.tierDescription}>{meta.description}</span>
                    </header>
                    {items.map((f, i) => (
                      <article key={`${tier}-${i}`} className={r.finding}>
                        <h3 className={r.findingTitle}>{f.title}</h3>
                        <p className={r.findingBody}>{f.body}</p>
                        {f.sources.length > 0 && (
                          <ul className={r.findingSources}>
                            {f.sources.map((src, j) => (
                              <li key={j}>
                                <a href={src.url} target="_blank" rel="noopener noreferrer" className={r.sourceLink}>
                                  <code className={r.sourceLabel}>{src.label}</code>
                                  <span className={r.sourceHost}>{(() => { try { return new URL(src.url).hostname; } catch { return src.url; } })()}</span>
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    ))}
                  </section>
                );
              })}
            </div>
          )}

          {result.suggestions.length > 0 && (
            <section className={r.suggestionsBlock}>
              <header className={r.suggestionsHead}>SUGGESTED INVESTIGATION ANGLES</header>
              <ul className={r.suggestionsList}>
                {result.suggestions.map((sug, i) => (
                  <li key={i} className={r.suggestionItem}>{sug}</li>
                ))}
              </ul>
            </section>
          )}

          {result.warnings.length > 0 && (
            <section className={r.warningsBlock}>
              <header className={r.warningsHead}>VALIDATION WARNINGS</header>
              <ul className={r.warningsList}>
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </section>
          )}

          <p className={r.disclaimer}>
            Findings are AI-derived. Audit markers fired on run start + complete.
            <strong> Verify every claim against the cited primary source before any on-camera assertion.</strong>
          </p>
        </div>
      )}
    </section>
  );
}
