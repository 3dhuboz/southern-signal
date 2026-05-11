/**
 * DossierPrint — a single AI Investigator dossier rendered in the same
 * print-friendly idiom as the Evidence Brief. Loaded at /dossier/:id.
 *
 * Use cases:
 *   - Operator wants to share recon findings without exposing the rest
 *     of the case file.
 *   - Reviewer wants a paper trail anchored to one venue.
 *   - Pre-visit handout: hit "Save as PDF" from the system print
 *     dialog, attach to a team brief.
 *
 * Mirrors the Evidence Brief's dossier section, lifted into a
 * standalone artefact with its own cover, disclaimer footer, and
 * SHA-256 of the canonical result_json so the printout carries the
 * same integrity anchor the manifest does.
 */

import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { getDossier, listFindingNotesForDossier, findingKeyFor } from "../lib/db/repo";
import type { ResearchTier, ResearchFinding, ResearchResult } from "../lib/research/api";
import type { ResearchFindingNoteRow } from "../lib/db/schema";
import s from "./EvidenceBrief.module.css";

const TIER_LABEL: Record<ResearchTier, string> = {
  CULTURAL_SIGNIFICANCE: "Cultural significance",
  HERITAGE: "Heritage register",
  DOCUMENTED_INCIDENT: "Documented incident",
  FOLKLORE: "Folklore",
  SYNTHESIS: "Synthesis — unverified",
};

const TIER_DISPLAY_ORDER: ResearchTier[] = [
  "CULTURAL_SIGNIFICANCE",
  "HERITAGE",
  "DOCUMENTED_INCIDENT",
  "FOLKLORE",
  "SYNTHESIS",
];

interface Loaded {
  id: string;
  venueName: string;
  locationHint: string | null;
  region: string;
  createdAt: string;
  model: string;
  result: ResearchResult;
  resultSha: string;
  notesByKey: Map<string, ResearchFindingNoteRow>;
  findingKeys: string[];
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

export function DossierPrint() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("No dossier id in the URL.");
      return;
    }
    void (async () => {
      try {
        const row = await getDossier(id);
        if (!row) {
          setError(`Dossier ${id} not found on this device.`);
          return;
        }
        const result = JSON.parse(row.result_json) as ResearchResult;
        if (!Array.isArray(result.findings)) {
          setError("Dossier result_json is malformed (no findings array).");
          return;
        }
        const notes = await listFindingNotesForDossier(row.id);
        const notesByKey = new Map<string, ResearchFindingNoteRow>();
        for (const n of notes) notesByKey.set(n.finding_key, n);
        const findingKeys: string[] = [];
        for (const f of result.findings) findingKeys.push(await findingKeyFor(f));
        const resultSha = await sha256Hex(row.result_json);
        setLoaded({
          id: row.id,
          venueName: row.venue_name,
          locationHint: row.location_hint,
          region: row.region,
          createdAt: row.created_at,
          model: row.model,
          result,
          resultSha,
          notesByKey,
          findingKeys,
        });
      } catch (err) {
        setError(`Couldn't load dossier: ${(err as Error).message}`);
      }
    })();
  }, [id]);

  if (error) {
    return (
      <article className={s.page}>
        <p className={s.error}>{error}</p>
        <button type="button" className={`btn btn-ghost ${s.buttonSize}`} onClick={() => navigate("/research")}>← Back to Research</button>
      </article>
    );
  }

  if (!loaded) {
    return (
      <article className={s.page}>
        <p className={s.loading}>Loading dossier…</p>
      </article>
    );
  }

  const findingsByTier: { tier: ResearchTier; findings: { f: ResearchFinding; key: string }[] }[] = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    const list: { f: ResearchFinding; key: string }[] = [];
    loaded.result.findings.forEach((f, i) => {
      if (f.tier === tier) list.push({ f, key: loaded.findingKeys[i] });
    });
    if (list.length > 0) findingsByTier.push({ tier, findings: list });
  }
  const totalCitations = loaded.result.findings.reduce((n, f) => n + f.sources.length, 0);
  const reviewerNoteCount = loaded.findingKeys.reduce((n, k) => n + (loaded.notesByKey.has(k) ? 1 : 0), 0);

  return (
    <article className={s.page}>
      {/* Toolbar — hidden when printing */}
      <header className={s.toolbar}>
        <Link to="/research" className={s.toolbarLink}>← Research</Link>
        <button type="button" className={`btn btn-ghost ${s.buttonSize}`} onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </header>

      {/* COVER */}
      <section className={s.cover}>
        <span className={s.brand}>SOUTHERN SIGNAL · AI INVESTIGATOR DOSSIER</span>
        <h1 className={s.title}>{loaded.venueName}</h1>
        {loaded.locationHint && <p className={s.location}>{loaded.locationHint}</p>}
        <dl className={s.coverGrid}>
          <div><dt>Generated</dt><dd>{formatDate(loaded.createdAt)}</dd></div>
          <div><dt>Region</dt><dd>{loaded.region}</dd></div>
          <div><dt>Model</dt><dd><code>{loaded.model.replace(/^.*\//, "")}</code></dd></div>
          <div><dt>Findings</dt><dd>{loaded.result.findings.length} · {totalCitations} citation{totalCitations === 1 ? "" : "s"}{reviewerNoteCount > 0 ? ` · ${reviewerNoteCount} reviewer note${reviewerNoteCount === 1 ? "" : "s"}` : ""}</dd></div>
        </dl>
      </section>

      {/* FINDINGS BY TIER */}
      {findingsByTier.length === 0 ? (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Findings</h2>
          <p className={s.empty}>
            No archival footprint found for this venue. The dossier records the empty result so a
            reviewer can see we looked — that's still data.
          </p>
        </section>
      ) : (
        findingsByTier.map((group) => (
          <section key={group.tier} className={s.section}>
            <h2 className={s.sectionTitle}>{TIER_LABEL[group.tier]}</h2>
            <div className={`${s.dossier} ${s[`tier_${group.tier}`] ?? ""}`.trim()}>
              <ul className={s.dossierFindings}>
                {group.findings.map(({ f, key }, i) => {
                  const note = loaded.notesByKey.get(key);
                  return (
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
                      {note && (
                        <div className={s.dossierNote}>
                          <span className={s.dossierNoteLabel}>Reviewer note · {formatDate(note.updated_at)}</span>
                          <span className={s.dossierNoteText}>{note.text}</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ))
      )}

      {/* SUGGESTIONS */}
      {loaded.result.suggestions.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Suggested investigation angles</h2>
          <ul className={s.tally}>
            {loaded.result.suggestions.map((sug, i) => (
              <li key={i}>{sug}</li>
            ))}
          </ul>
        </section>
      )}

      {/* WARNINGS */}
      {loaded.result.warnings.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Validation warnings</h2>
          <p className={s.dossierWarnings}>{loaded.result.warnings.join(" · ")}</p>
        </section>
      )}

      {/* INTEGRITY */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Forensic integrity</h2>
        <ul className={s.integrityList}>
          <li>
            <strong>result_json SHA-256:</strong>{" "}
            <code>{loaded.resultSha}</code>
            <span className={s.muted}> — this dossier's bytes hash to this value. A reviewer can recompute and compare against the case manifest.</span>
          </li>
          <li>
            <strong>Dossier id:</strong> <code>{loaded.id}</code>
          </li>
        </ul>
      </section>

      {/* DISCLAIMERS */}
      <footer className={s.disclaimers}>
        <p>
          <strong>Findings are AI-derived</strong>, model: <code>{loaded.model.replace(/^.*\//, "")}</code>.
          Folklore and synthesis tiers are not verified primary-source claims. Operators must verify
          every assertion against the cited source before on-camera repetition.
        </p>
        <p>
          The AI Investigator is hard-blocked on culturally-sensitive sites. Where Cultural
          Significance findings appear, contact the relevant Local Aboriginal Land Council (or
          equivalent custodial body) before any on-site activity.
        </p>
        <p className={s.briefMeta}>
          Dossier printed {new Date().toLocaleString()} · Southern Signal v0.1.0
        </p>
      </footer>
    </article>
  );
}
