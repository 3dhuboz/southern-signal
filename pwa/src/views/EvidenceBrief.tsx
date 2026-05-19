/**
 * EvidenceBrief view — printable one-page case summary. Loaded at
 * /brief/:investigationId, or /brief which auto-resolves the most
 * recent investigation. Designed for the operator to:
 *
 *   • Print directly from the browser (Ctrl/Cmd + P)
 *   • Save as PDF via the system print dialog
 *   • Screenshot for sharing on social
 *
 * Body layout is intentionally narrow + serif-leaning so it reads as a
 * printable artefact, not a UI screen. The footer carries the four
 * brief-universal disclaimers (posterior is a model estimate; sector
 * accuracy ±60°; AI proposes / investigator decides; AHT eliminates not
 * confirms / H₀ INCONCLUSIVE rule). The other four ethical-floor
 * disclaimers — SimpleMissionView amateur framing, BaitTone infrasound
 * caveat, EvpEditor "saves appended to chain", AiAssistant "AI never
 * claims to hear voices" — are surface-specific and live with the
 * tool they qualify (see README "Standing disclaimers").
 */

import { useEffect, useState } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { buildEvidenceBrief, findMostRecentInvestigationId, type EvidenceBrief } from "../lib/forensic/evidenceBrief";
import { describeChannel, describeSector, plainEnglishReason } from "../lib/posterior/plainEnglish";
import { usePresentationMode } from "../hooks/usePresentationMode";
import type { ResearchTier } from "../lib/research/api";
import s from "./EvidenceBrief.module.css";

const TIER_LABEL: Record<ResearchTier, string> = {
  CULTURAL_SIGNIFICANCE: "Cultural significance",
  HERITAGE: "Heritage register",
  DOCUMENTED_INCIDENT: "Documented incident",
  FOLKLORE: "Folklore",
  SYNTHESIS: "Synthesis — unverified",
};

const DISPOSITION_LABEL: Record<string, string> = {
  null: "Null — nothing happened",
  inconclusive: "Inconclusive — something, not enough",
  flagged: "Flagged — worth reviewing",
  confirmed_mundane: "Mundane — explained at the time",
};

/**
 * Loose agreement check between the computed AHT verdict and the operator's
 * chosen disposition. "unexplained" and "flagged" agree; "null" and "null"
 * agree; "confirmed_mundane" agrees with "null"/"inconclusive"; everything
 * else is treated as a divergence worth flagging.
 */
function verdictDisagreesWithDisposition(verdict: string, disposition: string): boolean {
  const agree: Record<string, string[]> = {
    null: ["null", "confirmed_mundane"],
    inconclusive: ["inconclusive", "confirmed_mundane"],
    unexplained: ["flagged"],
  };
  return !(agree[verdict] ?? []).includes(disposition);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const t = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  if (hh > 0) return `${hh}h ${mm}m ${ss}s`;
  if (mm > 0) return `${mm}m ${ss}s`;
  return `${ss}s`;
}

export function EvidenceBrief() {
  const { investigationId: paramId } = useParams<{ investigationId?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isPro } = usePresentationMode();
  const [brief, setBrief] = useState<EvidenceBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoPrint = searchParams.get("print") === "1";

  useEffect(() => {
    void (async () => {
      try {
        const id = paramId ?? (await findMostRecentInvestigationId());
        if (!id) {
          setError("No investigations yet. Start a hunt from the Camera tab first.");
          return;
        }
        const result = await buildEvidenceBrief(id);
        if (!result) {
          setError(`Investigation ${id} not found.`);
          return;
        }
        setBrief(result);
      } catch (err) {
        setError(`Couldn't build brief: ${(err as Error).message}`);
      }
    })();
  }, [paramId]);

  // Auto-print: when ?print=1 is in the URL, fire window.print() once
  // the brief has rendered. The setTimeout lets the layout settle so
  // the print dialog sees the final pixel layout, not the mid-mount
  // state. Only fires once per mount, even if React re-renders.
  useEffect(() => {
    if (!autoPrint || !brief) return;
    const id = window.setTimeout(() => {
      try { window.print(); } catch { /* some browsers throw when no printer; harmless */ }
    }, 300);
    return () => window.clearTimeout(id);
  }, [autoPrint, brief]);

  if (error) {
    return (
      <article className={s.page}>
        <p className={s.error}>{error}</p>
        <button type="button" className={`btn btn-ghost ${s.buttonSize}`} onClick={() => navigate("/review")}>← Back to Review</button>
      </article>
    );
  }

  if (!brief) {
    return (
      <article className={s.page}>
        <p className={s.loading}>Assembling brief…</p>
      </article>
    );
  }

  const inv = brief.investigation;
  const dispositionText = inv.disposition ? (DISPOSITION_LABEL[inv.disposition] ?? inv.disposition) : "Unclassified";

  return (
    <article className={s.page}>
      {/* Toolbar — hidden when printing */}
      <header className={s.toolbar}>
        <Link to="/review" className={s.toolbarLink}>← Review</Link>
        <button type="button" className={`btn btn-ghost ${s.buttonSize}`} onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </header>

      {/* COVER */}
      <section className={s.cover}>
        <span className={s.brand}>SOUTHERN SIGNAL · CASE BRIEF</span>
        <h1 className={s.title}>{inv.title}</h1>
        {inv.location_name && <p className={s.location}>{inv.location_name}</p>}
        <dl className={s.coverGrid}>
          <div><dt>Started</dt><dd>{formatDate(inv.started_at)}</dd></div>
          <div><dt>Ended</dt><dd>{formatDate(inv.ended_at)}</dd></div>
          <div><dt>Duration</dt><dd>{formatDuration(brief.durationSeconds)}</dd></div>
          <div><dt>Disposition</dt><dd>{dispositionText}</dd></div>
        </dl>
      </section>

      {/* AHT POST-ROLL VERDICT — the headline conclusion */}
      <section className={`${s.verdict} ${s[`verdict_${brief.ahtVerdict.verdict}`]}`.trim()}>
        <div className={s.verdictHead}>
          <span className={s.verdictEyebrow}>AHT POST-ROLL VERDICT</span>
          <span className={s.verdictLabel}>{brief.ahtVerdict.label}</span>
        </div>
        <p className={s.verdictDetail}>{brief.ahtVerdict.detail}</p>
        <p className={s.verdictMeta}>
          H₀ insufficiency {brief.h0Confidence.toFixed(2)}
          {brief.h0FromData ? ` (n=${brief.h0SampleCount} debunk requests)` : " (no debunk history — default applied)"}
          {" · "}peak posterior {(brief.peakPosterior * 100).toFixed(0)}%
          {brief.ahtVerdict.verdict !== "suspended" && brief.investigation.disposition
            ? ` · operator marked: ${dispositionText}`
            : ""}
        </p>
        {brief.ahtVerdict.verdict !== "suspended"
          && brief.investigation.disposition
          && verdictDisagreesWithDisposition(brief.ahtVerdict.verdict, brief.investigation.disposition) && (
          <p className={s.verdictDivergence}>
            Note: the computed post-roll verdict and the operator's disposition diverge. Both are recorded; a reviewer should weigh them together.
          </p>
        )}
      </section>

      {/* KEY FINDINGS */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Key findings</h2>
        <div className={s.findingsGrid}>
          <div className={s.finding}>
            <span className={s.findingLabel}>Peak score</span>
            <span className={`${s.findingValue} ${s[`band_${brief.peakPosteriorBand}`]}`.trim()}>
              {(brief.peakPosterior * 100).toFixed(0)}%
            </span>
            <span className={s.findingHint}>highest posterior reached</span>
          </div>
          <div className={s.finding}>
            <span className={s.findingLabel}>At session end</span>
            <span className={s.findingValue}>{(brief.finalPosterior * 100).toFixed(0)}%</span>
            <span className={s.findingHint}>posterior after final increment</span>
          </div>
          <div className={s.finding}>
            <span className={s.findingLabel}>Increments</span>
            <span className={s.findingValue}>{brief.totalIncrements}</span>
            <span className={s.findingHint}>posterior updates this session</span>
          </div>
          <div className={s.finding}>
            <span className={s.findingLabel}>Interference tags</span>
            <span className={s.findingValue}>{brief.contaminationCount}</span>
            <span className={s.findingHint}>contaminations the operator flagged</span>
          </div>
        </div>
      </section>

      {/* TOP MOMENTS */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Top moments {brief.topMoments.length > 0 ? `(top ${brief.topMoments.length} by evidence weight)` : ""}</h2>
        {brief.topMoments.length === 0 ? (
          <p className={s.empty}>
            No anomalies above noise this session. A quiet room is honest data — the base-rate dashboard counts null sessions too.
          </p>
        ) : (
          <ol className={s.moments}>
            {brief.topMoments.map((m, i) => {
              const ch = describeChannel(m.channel);
              const sector = describeSector(m.sector);
              return (
                <li key={`${m.ts}-${i}`} className={s.moment}>
                  <span className={s.momentRank}>{i + 1}</span>
                  <div className={s.momentBody}>
                    <span className={s.momentKind}>
                      {ch.label}
                      {sector ? ` · ${sector}` : ""}
                    </span>
                    <span className={s.momentReason}>{plainEnglishReason(m.reason)}</span>
                    <span className={s.momentMath}>
                      P {(m.posteriorBefore * 100).toFixed(0)}% → {(m.posteriorAfter * 100).toFixed(0)}%
                      {" · "}log LR {m.logLr >= 0 ? "+" : ""}{m.logLr.toFixed(2)}
                      {m.capped ? " · CAPPED" : ""}
                    </span>
                  </div>
                  <span className={s.momentTs}>{new Date(m.ts).toLocaleTimeString()}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ARCHIVE RESEARCH — AI Investigator dossiers saved for this case.
          Each finding ships with its sources; tier downgrade rules already
          fired server-side (no-source claims drop to SYNTHESIS), so what
          renders here is what the citation chain supports. */}
      {brief.researchDossiers.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>
            Archive research
            {" "}
            <span className={s.sectionSub}>
              {brief.researchDossiers.length} dossier{brief.researchDossiers.length === 1 ? "" : "s"}
              {brief.researchDossiers.some((d) => d.hasPrimarySources)
                ? " · with primary-source corroboration"
                : " · folklore / synthesis only"}
            </span>
          </h2>
          {brief.researchDossiers.map((dossier) => (
            <article key={dossier.id} className={s.dossier}>
              <header className={s.dossierHead}>
                <span className={s.dossierVenue}>{dossier.venueName}</span>
                <span className={s.dossierMeta}>
                  {dossier.findingCount} finding{dossier.findingCount === 1 ? "" : "s"}
                  {" · "}{dossier.citationCount} citation{dossier.citationCount === 1 ? "" : "s"}
                  {dossier.reviewerNoteCount > 0 && <>{" · "}{dossier.reviewerNoteCount} reviewer note{dossier.reviewerNoteCount === 1 ? "" : "s"}</>}
                  {" · "}{dossier.region}
                  {" · "}{formatDate(dossier.createdAt)}
                  {" · "}<code>{dossier.model.replace(/^.*\//, "")}</code>
                </span>
              </header>
              {dossier.findingsByTier.map((group) => (
                <div key={group.tier} className={`${s.dossierTier} ${s[`tier_${group.tier}`] ?? ""}`.trim()}>
                  <span className={s.dossierTierLabel}>{TIER_LABEL[group.tier]}</span>
                  <ul className={s.dossierFindings}>
                    {group.findings.map((f, i) => (
                      <li key={`${group.tier}-${i}`} className={s.dossierFinding}>
                        <span className={s.dossierFindingTitle}>{f.title}</span>
                        <span className={s.dossierFindingBody}>{f.body}</span>
                        {f.sources.length > 0 && (
                          <ul className={s.dossierSources}>
                            {f.sources.map((src, j) => {
                              const host = (() => { try { return new URL(src.url).hostname; } catch { return src.url; } })();
                              return (
                                <li key={j} className={s.dossierSource}>
                                  <a href={src.url} target="_blank" rel="noopener noreferrer">{src.label}</a>
                                  <span className={s.dossierSourceHost}> — {host}</span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {f.reviewerNote && (
                          <div className={s.dossierNote}>
                            <span className={s.dossierNoteLabel}>Reviewer note · {formatDate(f.reviewerNote.updatedAt)}</span>
                            <span className={s.dossierNoteText}>{f.reviewerNote.text}</span>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {dossier.raw.warnings.length > 0 && (
                <p className={s.dossierWarnings}>
                  Validation warnings: {dossier.raw.warnings.join(" · ")}
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {/* SECTION 2: WITNESS ACCOUNTS */}
      {brief.interviews.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>
            Section 2: Witness accounts
            {" "}
            <span className={s.sectionSub}>
              {brief.interviews.length} interview{brief.interviews.length === 1 ? "" : "s"}
            </span>
          </h2>
          {brief.interviews.map((iv) => (
            <article key={iv.id} className={s.dossier}>
              <header className={s.dossierHead}>
                <span className={s.dossierVenue}>{iv.witnessName}</span>
                <span className={s.dossierMeta}>
                  {iv.relationship ? iv.relationship.replace(/-/g, "‑") : "witness"}
                  {iv.occurredAt ? ` · ${formatDate(iv.occurredAt)}` : ""}
                  {iv.linkedEventIds.length > 0
                    ? ` · ${iv.linkedEventIds.length} linked event${iv.linkedEventIds.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </header>
              <p style={{ margin: "8px 0", fontSize: 13, lineHeight: 1.55 }}>{iv.statement}</p>
              {iv.notableClaims && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
                  {iv.notableClaims
                    .split(/\n/)
                    .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
                    .filter(Boolean)
                    .map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                </ul>
              )}
              {iv.linkedEventIds.length > 0 && (
                <p className={s.dossierMeta} style={{ marginTop: 6 }}>
                  Linked event IDs:{" "}
                  {iv.linkedEventIds.map((id) => (
                    <code key={id} style={{ marginRight: 6 }}>{id.slice(0, 8)}…</code>
                  ))}
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {/* MEDIA + EVENTS */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Recordings &amp; events</h2>
        <ul className={s.tally}>
          <li><strong>{brief.mediaByType.video}</strong> video clip{brief.mediaByType.video === 1 ? "" : "s"}</li>
          <li><strong>{brief.mediaByType.audio}</strong> audio clip{brief.mediaByType.audio === 1 ? "" : "s"}</li>
          <li><strong>{brief.mediaByType.image}</strong> still{brief.mediaByType.image === 1 ? "" : "s"}</li>
          <li><strong>{brief.markerCount}</strong> manual marker{brief.markerCount === 1 ? "" : "s"}</li>
          <li><strong>{brief.observationCount}</strong> observation note{brief.observationCount === 1 ? "" : "s"}</li>
        </ul>
      </section>

      {/* MOMENT MARKERS WITH REVIEWER NOTES — surfaces operator/reviewer
          context that would otherwise live only in the audit chain. Only
          renders rows with notes or non-default categories; dismissed
          markers are filtered out at brief-build time. */}
      {brief.markersWithNotes.some((m) => m.note || m.category) && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Reviewer notes on moment markers</h2>
          <ul className={s.markerNotesList}>
            {brief.markersWithNotes
              .filter((m) => m.note || m.category)
              .map((m) => (
                <li key={m.id} className={s.markerNoteRow}>
                  <div className={s.markerNoteHead}>
                    <span className={s.markerNoteTs}>{m.elapsed ?? new Date(m.ts).toLocaleString()}</span>
                    {m.category && (
                      <span className={s.markerNoteCat} data-category={m.category}>{m.category}</span>
                    )}
                  </div>
                  {m.note && <blockquote className={s.markerNoteText}>{m.note}</blockquote>}
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* FORENSIC INTEGRITY */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Forensic integrity</h2>
        <ul className={s.integrityList}>
          <li>
            {brief.chainStatus.ok ? (
              <><strong>Audit chain verified.</strong> Every posterior update, marker, contamination tag, and disposition is hash-chained — no entry has been altered since capture.</>
            ) : (
              <><strong>Audit chain BROKEN.</strong> Entry seq {brief.chainStatus.brokenAtSeq} failed verification ({brief.chainStatus.reason}). Treat this case's data with caution.</>
            )}
          </li>
          {/* Merkle root is forensic-chain detail. Pro reviewers want it
              for offline verification; amateurs reading the brief just
              need the "chain verified" assurance one line up. The
              chainStatus line above keeps the integrity message visible
              in both modes; this just hides the 64-char hex digest. */}
          {brief.merkleRoot && isPro && (
            <li>
              <strong>Merkle root: </strong>
              <code>{brief.merkleRoot}</code>
              <span className={s.muted}> — the export bundle for this device hashes to this value.</span>
            </li>
          )}
          {brief.culturallySensitive && (
            <li><strong>Cultural-sensitivity flag: ON.</strong> Cloud AI and cloud sync are blocked for this case. Audio and notes never left the device.</li>
          )}
        </ul>
      </section>

      {/* ACKNOWLEDGEMENT */}
      {brief.acknowledgementStatement && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Acknowledgement of Country</h2>
          <blockquote className={s.acknowledgement}>
            {brief.acknowledgementStatement}
          </blockquote>
          {brief.acknowledgementAcceptedAt && (
            <p className={s.muted}>Recorded {formatDate(brief.acknowledgementAcceptedAt)}</p>
          )}
        </section>
      )}

      {/* DISCLAIMERS */}
      <footer className={s.disclaimers}>
        <p>
          <strong>Posterior is a model estimate, not a measurement of presence.</strong> Sector accuracy ±60° (calibrated) or unknown (uncalibrated). AI proposes; the investigator decides — AI never claims to hear voices or see ghosts.
        </p>
        <p>
          The Adversarial Hypothesis Tournament (AHT) eliminates explanations; it does not confirm causes. When the H₀ "AI insufficiency" confidence exceeds 0.4, the verdict is INCONCLUSIVE, never confirmed.
        </p>
        <p>
          Additional tool-specific disclaimers are surfaced inside the relevant in-app tools (Bait-Tone, EVP Editor, AI Assist, Simple Mission View).
        </p>
        <p className={s.briefMeta}>
          Brief generated {formatDate(brief.generatedAt)} · Southern Signal v0.1.0
        </p>
      </footer>
    </article>
  );
}
