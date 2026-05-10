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
import { recordEvent, saveDossier, listDossiers, getDossier } from "../lib/db/repo";
import type { ResearchDossierRow } from "../lib/db/schema";
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
  /** v4: past dossiers persisted to research_dossiers. Scoped to the
   *  current investigation (or to standalone runs when no case is open).
   *  Lets the operator re-open prior research without burning a new
   *  cloud-AI call. */
  const [pastDossiers, setPastDossiers] = useState<ResearchDossierRow[]>([]);
  const [loadedFromDossierId, setLoadedFromDossierId] = useState<string | null>(null);
  const [savedDossierId, setSavedDossierId] = useState<string | null>(null);

  /** v4: follow-up turn state. Keyed by `${tier}-${index}` of the parent
   *  finding so each card runs independently. Map values hold the input
   *  question, busy flag, error, and the appended findings to render
   *  beneath the parent. */
  interface FollowupState {
    open: boolean;
    question: string;
    busy: boolean;
    error: string | null;
    findings: ResearchFinding[] | null;
    sourcesCount: number;
  }
  const [followups, setFollowups] = useState<Record<string, FollowupState>>({});

  // Prefill venue from the active investigation if it has a location_name.
  useEffect(() => {
    const inv = session.current;
    if (!inv) return;
    if (!venueName && inv.location_name) setVenueName(inv.location_name);
    if (!venueName && inv.title) setVenueName(inv.title);
    // intentionally not depending on venueName so first-load prefill wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  // Load past dossiers for this investigation (or recent standalone runs
  // when no case is open). Cheap query — at most 20 rows.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listDossiers(session.current?.id ?? null, 20);
        if (!cancelled) setPastDossiers(rows);
      } catch (err) {
        console.warn("[research] listDossiers failed", err);
      }
    })();
    return () => { cancelled = true; };
  }, [session.current?.id, savedDossierId]);

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
      setLoadedFromDossierId(null);
      setFollowups({});
      setRate(getResearchRateState());

      // v4: persist the dossier so it survives the session and feeds
      // the Evidence Brief. Fire-and-forget — UI doesn't gate on it,
      // but we surface the saved id so the user sees a confirmation.
      void saveDossier({
        investigation_id: investigationId,
        venue_name: venueName.trim(),
        location_hint: locationHint.trim() || null,
        region,
        model: res.model,
        result: res as unknown as Record<string, unknown>,
      }).then((row) => setSavedDossierId(row.id)).catch((err) => {
        console.warn("[research] saveDossier failed (run still succeeded)", err);
      });

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
        // Server-enforced cap (429) is sticky — clearing localStorage
        // won't help. Spell that out so the operator doesn't fight a
        // wall they can't move.
        setError(err.fromServer
          ? `${err.message} This is the network-wide server cap — clearing app data won't reset it.`
          : err.message);
      } else {
        setError((err as Error).message || "Research failed.");
      }
      setRate(getResearchRateState());
    } finally {
      setBusy(false);
    }
  }, [canRun, venueName, locationHint, region, culturallyBlocked, session]);

  const grouped = useMemo(() => result ? groupByTier(result.findings) : new Map<ResearchTier, ResearchFinding[]>(), [result]);

  // Drill deeper on a single finding. Same rate-limit budget; we
  // anchor the user prompt to the parent so the model extends instead
  // of re-researching the venue at the top level. Findings are
  // appended to the parent in-place.
  const handleFollowup = useCallback(async (key: string, parent: ResearchFinding) => {
    const cur = followups[key];
    setFollowups((m) => ({ ...m, [key]: { ...(cur ?? { open: true, question: "", busy: false, error: null, findings: null, sourcesCount: 0 }), busy: true, error: null } }));
    const investigationId = session.current?.id ?? null;
    const question = (cur?.question ?? "").trim();
    const startedAtMs = Date.now();
    try {
      const res = await runResearch({
        venueName: venueName.trim(),
        locationHint: locationHint.trim() || undefined,
        region,
        culturallySensitive: culturallyBlocked,
        followup: {
          parentTitle: parent.title,
          parentBody: parent.body,
          parentSources: parent.sources,
          question: question || `What more do you know about "${parent.title}"?`,
        },
      });
      const sourcesCount = res.findings.reduce((n, f) => n + f.sources.length, 0);
      setFollowups((m) => ({ ...m, [key]: { open: true, question, busy: false, error: null, findings: res.findings, sourcesCount } }));
      setRate(getResearchRateState());

      // Audit chain — record the drill-down as a discrete event so the
      // reviewer can see the parent → child link.
      if (investigationId) {
        const endedAtMs = Date.now();
        void appendAuditEntry({
          actor: "ai",
          kind: "research.ai_investigator.followup",
          payload: {
            investigation_id: investigationId,
            venue: venueName.trim(),
            region,
            parent_title: parent.title,
            parent_tier: parent.tier,
            question: question || null,
            started_at_ms: startedAtMs,
            ended_at_ms: endedAtMs,
            duration_ms: endedAtMs - startedAtMs,
            findings_count: res.findings.length,
            model: res.model,
          },
        }).catch(() => { /* */ });
        for (const f of res.findings) {
          void recordEvent({
            investigation_id: investigationId,
            source: "ai",
            event_type: "research.finding.followup",
            title: `${f.tier} — ${f.title}`,
            description: f.body,
            metadata: {
              tier: f.tier,
              sources: f.sources,
              venue: venueName.trim(),
              region,
              model: res.model,
              parent_title: parent.title,
              parent_tier: parent.tier,
              question: question || null,
            },
          }).catch(() => { /* */ });
        }
      }
    } catch (err) {
      const msg = err instanceof ResearchRateLimitError
        ? (err.fromServer
            ? `${err.message} (network-wide cap)`
            : err.message)
        : ((err as Error).message || "Drill-down failed.");
      setFollowups((m) => ({ ...m, [key]: { ...(m[key] ?? { open: true, question, busy: false, error: null, findings: null, sourcesCount: 0 }), busy: false, error: msg } }));
      setRate(getResearchRateState());
    }
  }, [followups, session, venueName, locationHint, region, culturallyBlocked]);

  const setFollowupField = useCallback((key: string, patch: Partial<{ open: boolean; question: string }>) => {
    setFollowups((m) => ({
      ...m,
      [key]: {
        open: patch.open ?? m[key]?.open ?? true,
        question: patch.question ?? m[key]?.question ?? "",
        busy: m[key]?.busy ?? false,
        error: m[key]?.error ?? null,
        findings: m[key]?.findings ?? null,
        sourcesCount: m[key]?.sourcesCount ?? 0,
      },
    }));
  }, []);

  // Open a past dossier without burning a cloud-AI call. Hydrates
  // result/venueName/locationHint/region so the UI looks identical to a
  // live run — but tagged as "loaded from saved dossier" so the operator
  // sees we didn't re-research.
  const handleOpenDossier = useCallback(async (id: string) => {
    try {
      const row = await getDossier(id);
      if (!row) return;
      const parsed = JSON.parse(row.result_json) as ResearchResult;
      setResult(parsed);
      setVenueName(row.venue_name);
      setLocationHint(row.location_hint ?? "");
      setRegion(row.region === "GLOBAL" ? "GLOBAL" : "AU");
      setLoadedFromDossierId(row.id);
      setFollowups({});
      setError(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.warn("[research] handleOpenDossier failed", err);
    }
  }, []);

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

      {pastDossiers.length > 0 && (
        <details className={r.pastDossiers} open={result == null}>
          <summary className={r.pastDossiersSummary}>
            <span>Saved dossiers for {session.current ? "this case" : "this device"}</span>
            <span className={r.pastDossiersCount}>{pastDossiers.length}</span>
          </summary>
          <ul className={r.pastDossiersList}>
            {pastDossiers.map((d) => {
              const ts = new Date(d.created_at);
              const findingCount = (() => {
                try {
                  const p = JSON.parse(d.result_json) as ResearchResult;
                  return p.findings?.length ?? 0;
                } catch { return 0; }
              })();
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    className={`${r.pastDossierItem} ${loadedFromDossierId === d.id ? r.pastDossierItemActive : ""}`.trim()}
                    onClick={() => handleOpenDossier(d.id)}
                  >
                    <span className={r.pastDossierVenue}>{d.venue_name}</span>
                    <span className={r.pastDossierMeta}>
                      {ts.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                      {" · "}{findingCount} findings{" · "}{d.region}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
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
          {loadedFromDossierId ? (
            <p className={r.savedBadge} role="status">
              <span aria-hidden="true">↺</span> Loaded from saved dossier — no cloud-AI call made.
            </p>
          ) : savedDossierId ? (
            <p className={r.savedBadge} role="status">
              <span aria-hidden="true">✓</span> Saved to {session.current ? "this case" : "your device"} — flows into the Evidence Brief.
            </p>
          ) : null}

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
                    {items.map((f, i) => {
                      const key = `${tier}-${i}`;
                      const fu = followups[key];
                      const fuOpen = fu?.open === true;
                      const fuBusy = fu?.busy === true;
                      const fuFindings = fu?.findings ?? null;
                      const drillDisabled = rateBlocked || busy || fuBusy || culturallyBlocked || loadedFromDossierId != null;
                      return (
                        <article key={key} className={r.finding}>
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
                          {/* Drill-down trigger. Disabled when viewing a
                              saved dossier — those are immutable; the
                              user can re-run from a fresh form if they
                              want a deeper pass. */}
                          {!fuOpen && !fuFindings && (
                            <div className={r.drillRow}>
                              <button
                                type="button"
                                className={r.drillBtn}
                                onClick={() => setFollowupField(key, { open: true })}
                                disabled={drillDisabled}
                                title={loadedFromDossierId
                                  ? "Saved dossiers are immutable. Run a fresh search to drill deeper."
                                  : "Pull more cited detail on this finding."}
                              >
                                ↳ Drill deeper
                              </button>
                              {loadedFromDossierId && (
                                <span className={r.drillNote}>Saved dossiers are read-only.</span>
                              )}
                            </div>
                          )}
                          {fuOpen && (
                            <div className={r.drillPanel}>
                              <textarea
                                className={r.drillInput}
                                rows={2}
                                placeholder={`Optional — e.g. "Find the date the courthouse was decommissioned" or "Was anyone killed on site?"`}
                                value={fu?.question ?? ""}
                                onChange={(e) => setFollowupField(key, { question: e.target.value })}
                                disabled={fuBusy}
                                maxLength={500}
                              />
                              <div className={r.drillActions}>
                                <button
                                  type="button"
                                  className={`btn btn-primary ${r.drillRun}`}
                                  onClick={() => handleFollowup(key, f)}
                                  disabled={drillDisabled}
                                >
                                  {fuBusy ? "Drilling…" : "Run drill-down"}
                                </button>
                                <button
                                  type="button"
                                  className={r.drillCancel}
                                  onClick={() => setFollowupField(key, { open: false })}
                                  disabled={fuBusy}
                                >
                                  Cancel
                                </button>
                                <span className={r.drillRateNote}>Uses 1 of your daily runs.</span>
                              </div>
                              {fu?.error && <p className={r.drillError}>{fu.error}</p>}
                            </div>
                          )}
                          {fuFindings && fuFindings.length > 0 && (
                            <div className={r.drillResults}>
                              <header className={r.drillResultsHead}>
                                <span className={r.drillResultsEyebrow}>DRILL-DOWN · {fuFindings.length} new {fuFindings.length === 1 ? "finding" : "findings"} · {fu?.sourcesCount ?? 0} sources</span>
                              </header>
                              {fuFindings.map((child, ci) => (
                                <article key={ci} className={r.drillChild}>
                                  <span className={`${r.drillChildTier} ${r[`tone_${TIER_META[child.tier].tone}`]}`.trim()}>{TIER_META[child.tier].label}</span>
                                  <h4 className={r.drillChildTitle}>{child.title}</h4>
                                  <p className={r.drillChildBody}>{child.body}</p>
                                  {child.sources.length > 0 && (
                                    <ul className={r.findingSources}>
                                      {child.sources.map((src, j) => (
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
                            </div>
                          )}
                          {fuFindings && fuFindings.length === 0 && (
                            <p className={r.drillEmpty}>
                              No additional sources found on this drill-down. The parent finding stands as written.
                            </p>
                          )}
                        </article>
                      );
                    })}
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
