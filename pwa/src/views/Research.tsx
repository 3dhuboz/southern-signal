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
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "../lib/session";
import { usePreferences, setPreferences } from "../lib/preferences";
import {
  runResearch,
  getResearchRateState,
  ResearchRateLimitError,
  type ResearchResult,
  type ResearchFinding,
  type ResearchTier,
} from "../lib/research/api";
import { diffResearchResults, type DossierDiff } from "../lib/research/diff";
import { recordEvent, saveDossier, listDossiers, getDossier, deleteDossier, findingKeyFor, saveFindingNote, listFindingNotesForDossier } from "../lib/db/repo";
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

/**
 * Tier-aware verification-angle templates that seed the reviewer note
 * input on demand. Local-only — no AI call, no rate-limit impact —
 * these are scaffolds the operator edits in place. The point is to
 * lower the activation energy for actually writing a note: an empty
 * textarea gets ignored, a templated starting point gets refined.
 */
const NOTE_TEMPLATES: Record<ResearchTier, (f: ResearchFinding) => string> = {
  HERITAGE: (f) => {
    const url = f.sources[0]?.url ?? "(citation URL)";
    return `Verify against the heritage register entry: ${url}\n` +
      `Confirm: listing date, listing number, current status. Note any caveats on the citation.`;
  },
  DOCUMENTED_INCIDENT: (f) => {
    const url = f.sources[0]?.url ?? "(citation URL)";
    return `Pull the primary source (${url}) and confirm: date, named parties, jurisdiction.\n` +
      `Watch for secondary republications looping back to the same original — if all citations trace to one source, weight accordingly.`;
  },
  CULTURAL_SIGNIFICANCE: () =>
    `Before any on-site activity, contact the relevant Local Aboriginal Land Council (or equivalent custodial body) and confirm protocols.\n` +
    `Note who you spoke with, when, and what permissions were granted. Do NOT proceed on assumption.`,
  FOLKLORE: () =>
    `Folklore tier — verify with caution. Look for conflicting versions, dates that drift between retellings, and identifiable original sources.\n` +
    `Never present this on camera as documented fact; frame it as "what locals say".`,
  SYNTHESIS: () =>
    `AI-inferred only — no primary source. Either: (a) find a primary source and re-research, OR (b) drop from the on-camera read.\n` +
    `Do not repeat synthesis-tier claims as fact. Recommendation: do not use without independent verification.`,
};

/**
 * Progress labels rotated while a run is in flight. These are
 * illustrative — Perplexity Sonar doesn't actually emit per-source
 * progress events — but they tie the wait time to the *kind* of work
 * the system prompt asks for. AU and GLOBAL lists differ because the
 * source ordering in the prompt differs.
 */
const PROGRESS_LABELS_AU: string[] = [
  "Walking the archives…",
  "Pulling state heritage register entries…",
  "Cross-referencing AustLII court records…",
  "Searching Trove newspaper archive…",
  "Checking First Nations Country layer…",
  "Reviewing local-council heritage citations…",
  "Synthesising sources…",
];
const PROGRESS_LABELS_GLOBAL: string[] = [
  "Walking the archives…",
  "Querying government heritage registers…",
  "Reviewing court records and primary news…",
  "Checking indigenous-land databases…",
  "Pulling newspaper / library archive entries…",
  "Synthesising sources…",
];

export function Research() {
  const session = useSession();
  const [prefs] = usePreferences();
  const [searchParams] = useSearchParams();
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

  /** v5: reviewer notes per finding. Keyed by finding_key (sha256
   *  prefix over tier|title|body). Values: { text, savedText, dirty }.
   *  `savedText` mirrors what's in the DB so we can mark dirty / show
   *  a Save indicator without re-querying on every keystroke. */
  interface NoteState { text: string; savedText: string; saving: boolean }
  const [notes, setNotes] = useState<Record<string, NoteState>>({});
  const [findingKeys, setFindingKeys] = useState<Record<string, string>>({});

  /** v5: rotating progress label shown while the run is in flight.
   *  Cycles through archive layers the system prompt actually asks the
   *  model to consult — illustrative, not literal. Index resets on
   *  busy↑ so each run gets a fresh sequence. */
  const [progressIndex, setProgressIndex] = useState(0);

  /** v5: diff against the most recent prior dossier for the same
   *  venue. Computed after a successful run; null when this is the
   *  first dossier for the venue, or when the user opened a saved
   *  dossier (read-only mode — diff would compare to itself). */
  const [diff, setDiff] = useState<DossierDiff | null>(null);
  const [diffPriorAt, setDiffPriorAt] = useState<string | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false);

  /** v5: AoC-from-dossier capture. Keyed by finding_key — clicking the
   *  "Use as Acknowledgement of Country" button on a CULTURAL_SIGNIFICANCE
   *  finding opens an inline editor pre-filled with the body. Save
   *  updates prefs.acknowledgementOfCountry + fires an audit entry
   *  tagged so the chain reflects "this came from research". */
  const [aocDraftFor, setAocDraftFor] = useState<string | null>(null);
  const [aocDraftText, setAocDraftText] = useState<string>("");

  // Prefill priority: URL params (deep link from CaseManager) → active
  // investigation. URL takes precedence so a "Research this case"
  // shortcut from a non-active case still prefills correctly.
  useEffect(() => {
    const urlVenue = searchParams.get("venue");
    const urlLocation = searchParams.get("location");
    const urlRegion = searchParams.get("region");
    if (urlVenue && !venueName) setVenueName(urlVenue);
    if (urlLocation && !locationHint) setLocationHint(urlLocation);
    if (urlRegion === "AU" || urlRegion === "GLOBAL") setRegion(urlRegion);
    // intentionally not depending on local state so the URL-driven
    // prefill only happens once per mount / query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Prefill venue from the active investigation when no URL prefill
  // has taken hold. Same one-shot-per-id pattern as before.
  useEffect(() => {
    const inv = session.current;
    if (!inv) return;
    if (!venueName && inv.location_name) setVenueName(inv.location_name);
    if (!venueName && inv.title) setVenueName(inv.title);
    // intentionally not depending on venueName so first-load prefill wins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  // Active dossier id — the row reviewer notes attach to. Either the
  // dossier we just saved (after a fresh run) or the one currently
  // open (loaded from past dossiers).
  const activeDossierId = loadedFromDossierId ?? savedDossierId;

  // v5: compute stable finding keys whenever findings change. Keys are
  // sha256(tier|title|body) prefixes so notes survive findings being
  // re-ordered, and so we can lookup by content rather than index.
  useEffect(() => {
    if (!result) {
      setFindingKeys({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const built: Record<string, string> = {};
      for (let i = 0; i < result.findings.length; i++) {
        const f = result.findings[i];
        const cacheKey = `${f.tier}-${i}`;
        built[cacheKey] = await findingKeyFor(f);
      }
      // Also process drill-down children so notes can attach to those too.
      for (const [parentKey, fu] of Object.entries(followups)) {
        const list = fu?.findings;
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          built[`${parentKey}-child-${i}`] = await findingKeyFor(f);
        }
      }
      if (!cancelled) setFindingKeys(built);
    })();
    return () => { cancelled = true; };
  }, [result, followups]);

  // v5: load saved notes for the active dossier. Re-runs when the
  // dossier id changes (open / save / delete).
  useEffect(() => {
    if (!activeDossierId) {
      setNotes({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listFindingNotesForDossier(activeDossierId);
        if (cancelled) return;
        const next: Record<string, NoteState> = {};
        for (const r of rows) {
          next[r.finding_key] = { text: r.text, savedText: r.text, saving: false };
        }
        setNotes(next);
      } catch (err) {
        console.warn("[research] listFindingNotesForDossier failed", err);
      }
    })();
    return () => { cancelled = true; };
  }, [activeDossierId]);

  const handleNoteChange = useCallback((findingKey: string, text: string) => {
    setNotes((m) => ({
      ...m,
      [findingKey]: {
        text,
        savedText: m[findingKey]?.savedText ?? "",
        saving: m[findingKey]?.saving ?? false,
      },
    }));
  }, []);

  const handleOpenAocDraft = useCallback((findingKey: string, body: string) => {
    setAocDraftFor(findingKey);
    setAocDraftText(body);
  }, []);

  const handleSaveAocDraft = useCallback(async () => {
    const text = aocDraftText.trim();
    if (!text || !aocDraftFor) return;
    const ts = new Date().toISOString();
    setPreferences({
      acknowledgementOfCountry: {
        accepted: true,
        acceptedAt: ts,
        statement: text,
      },
    });
    void appendAuditEntry({
      actor: "user",
      kind: "acknowledgement.country.from_dossier",
      payload: {
        finding_key: aocDraftFor,
        dossier_id: activeDossierId,
        statement_length: text.length,
        ts,
      },
    }).catch(() => { /* */ });
    setAocDraftFor(null);
    setAocDraftText("");
  }, [aocDraftFor, aocDraftText, activeDossierId]);

  const handleNoteSave = useCallback(async (findingKey: string) => {
    if (!activeDossierId) return;
    const cur = notes[findingKey];
    if (!cur || cur.text === cur.savedText) return;
    setNotes((m) => ({ ...m, [findingKey]: { ...m[findingKey]!, saving: true } }));
    try {
      const saved = await saveFindingNote({
        dossier_id: activeDossierId,
        finding_key: findingKey,
        text: cur.text,
      });
      setNotes((m) => ({
        ...m,
        [findingKey]: {
          text: saved ? saved.text : "",
          savedText: saved ? saved.text : "",
          saving: false,
        },
      }));
    } catch (err) {
      console.warn("[research] saveFindingNote failed", err);
      setNotes((m) => ({ ...m, [findingKey]: { ...m[findingKey]!, saving: false } }));
    }
  }, [activeDossierId, notes]);

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
  const researchDisabled = !prefs.research.enabled;
  const rateBlocked = rate.used >= rate.cap;
  const canRun = venueName.trim().length >= 2 && !busy && !culturallyBlocked && !researchDisabled && !rateBlocked;

  // Rotate the progress label while a run is in flight. Reset to 0 on
  // busy=false so each new run starts at "Walking the archives…".
  useEffect(() => {
    if (!busy) { setProgressIndex(0); return; }
    const labels = region === "AU" ? PROGRESS_LABELS_AU : PROGRESS_LABELS_GLOBAL;
    const id = window.setInterval(() => {
      setProgressIndex((i) => Math.min(i + 1, labels.length - 1));
    }, 2200);
    return () => window.clearInterval(id);
  }, [busy, region]);

  const progressLabel = (() => {
    const labels = region === "AU" ? PROGRESS_LABELS_AU : PROGRESS_LABELS_GLOBAL;
    return labels[Math.min(progressIndex, labels.length - 1)] ?? labels[0];
  })();

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

      // v5: diff against the most recent prior dossier for this venue
      // (matched case-insensitively). Computed BEFORE save fires so
      // the prior is still the prior, not the just-saved row.
      const venueLower = venueName.trim().toLowerCase();
      const prior = pastDossiers.find((d) => d.venue_name.toLowerCase() === venueLower);
      if (prior) {
        try {
          const priorResult = JSON.parse(prior.result_json) as ResearchResult;
          const computedDiff = await diffResearchResults(priorResult, res);
          setDiff(computedDiff);
          setDiffPriorAt(prior.created_at);
          setDiffExpanded(false);
        } catch (err) {
          console.warn("[research] diff against prior dossier failed", err);
          setDiff(null);
          setDiffPriorAt(null);
        }
      } else {
        setDiff(null);
        setDiffPriorAt(null);
      }

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

  // Delete a saved dossier. Hard-confirm because dossiers carry the
  // citation chain — deleting one removes it from the Evidence Brief
  // and breaks the forensic record of "we looked, here's what we
  // found". The repo helper fires a research.dossier.delete audit
  // entry so the chain still records the deletion even after the row
  // is gone.
  const handleDeleteDossier = useCallback(async (row: ResearchDossierRow) => {
    const ts = new Date(row.created_at).toLocaleString();
    if (!window.confirm(
      `Delete the dossier "${row.venue_name}" (${ts})?\n\n`
        + `It will no longer appear in the Evidence Brief for this case. `
        + `An audit entry will record the deletion.`,
    )) return;
    try {
      await deleteDossier(row.id);
      // If the currently-displayed result came from this dossier, clear it.
      if (loadedFromDossierId === row.id) {
        setResult(null);
        setLoadedFromDossierId(null);
      }
      // Bump savedDossierId to trigger the list-reload effect even when
      // the operator hadn't just saved one.
      setSavedDossierId((cur) => cur === row.id ? null : cur);
      setPastDossiers((rows) => rows.filter((r) => r.id !== row.id));
    } catch (err) {
      console.warn("[research] handleDeleteDossier failed", err);
      window.alert(`Couldn't delete dossier: ${(err as Error).message}`);
    }
  }, [loadedFromDossierId]);

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
      setDiff(null);
      setDiffPriorAt(null);
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

      {researchDisabled && !culturallyBlocked && (
        <div className={r.blockedCard}>
          <strong className={r.blockedTitle}>Disabled in Setup</strong>
          <p className={r.blockedBody}>
            The AI Investigator is turned off on this device. You can still view past dossiers
            below (read-only), but new runs are blocked. Re-enable in Setup → AI Investigator.{" "}
            <Link to="/setup" className={r.blockedLink}>Open Setup →</Link>
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
                <li key={d.id} className={r.pastDossierRow}>
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
                  <Link
                    to={`/dossier/${d.id}`}
                    className={r.pastDossierPrint}
                    aria-label={`Print dossier for ${d.venue_name}`}
                    title="Open print-friendly view of this dossier"
                  >
                    🖨
                  </Link>
                  <button
                    type="button"
                    className={r.pastDossierDelete}
                    onClick={() => handleDeleteDossier(d)}
                    aria-label={`Delete dossier for ${d.venue_name}`}
                    title="Delete this dossier (audit entry will record the deletion)"
                  >
                    ✕
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
            disabled={busy || culturallyBlocked || researchDisabled}
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
            disabled={busy || culturallyBlocked || researchDisabled}
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
              disabled={busy || culturallyBlocked || researchDisabled}
            >
              Australia
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={region === "GLOBAL"}
              className={`${r.segmentedOpt} ${region === "GLOBAL" ? r.segmentedOptActive : ""}`.trim()}
              onClick={() => setRegion("GLOBAL")}
              disabled={busy || culturallyBlocked || researchDisabled}
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
            {busy ? progressLabel : "Run AI Investigator"}
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

          {/* v5: dossier diff vs the prior dossier for this venue.
              Counts header is always visible; the full added/removed
              detail expands on click. Surfaces "the archive changed
              since last time" — useful for re-research as a case
              progresses, or to spot model output drift. */}
          {diff && (diff.counts.added > 0 || diff.counts.removed > 0) && diffPriorAt && (
            <section className={r.diffBlock}>
              <header className={r.diffHead}>
                <span className={r.diffEyebrow}>SINCE LAST RESEARCH · {new Date(diffPriorAt).toLocaleDateString()}</span>
                <span className={r.diffCounts}>
                  {diff.counts.added > 0 && <span className={r.diffAdded}>+{diff.counts.added} new</span>}
                  {diff.counts.removed > 0 && <span className={r.diffRemoved}>−{diff.counts.removed} missing</span>}
                  {diff.counts.unchanged > 0 && <span className={r.diffUnchanged}>{diff.counts.unchanged} unchanged</span>}
                </span>
                <button
                  type="button"
                  className={r.diffToggle}
                  onClick={() => setDiffExpanded((v) => !v)}
                  aria-expanded={diffExpanded}
                >
                  {diffExpanded ? "Hide detail" : "Show detail"}
                </button>
              </header>
              {diffExpanded && (
                <div className={r.diffDetail}>
                  {diff.added.length > 0 && (
                    <div>
                      <span className={r.diffSectionLabel}>Appeared in this run</span>
                      <ul className={r.diffList}>
                        {diff.added.map((f, i) => (
                          <li key={`a-${i}`} className={`${r.diffItem} ${r.diffItemAdded}`}>
                            <span className={r.diffTier}>{f.tier}</span>
                            <span className={r.diffTitle}>{f.title}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {diff.removed.length > 0 && (
                    <div>
                      <span className={r.diffSectionLabel}>No longer in the dossier</span>
                      <ul className={r.diffList}>
                        {diff.removed.map((f, i) => (
                          <li key={`r-${i}`} className={`${r.diffItem} ${r.diffItemRemoved}`}>
                            <span className={r.diffTier}>{f.tier}</span>
                            <span className={r.diffTitle}>{f.title}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

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
                      const drillDisabled = rateBlocked || busy || fuBusy || culturallyBlocked || researchDisabled || loadedFromDossierId != null;
                      const fKey = findingKeys[key];
                      const note = fKey ? notes[fKey] : undefined;
                      const noteDirty = note != null && note.text !== note.savedText;
                      const canNote = activeDossierId != null && fKey != null;
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
                          {/* AoC capture from CULTURAL_SIGNIFICANCE findings.
                              Surfaces a quiet "Use as Acknowledgement of
                              Country" button that opens an inline editor
                              pre-filled with the finding body. Saves to
                              preferences with an audit entry tagged
                              acknowledgement.country.from_dossier so the
                              chain shows the provenance. */}
                          {f.tier === "CULTURAL_SIGNIFICANCE" && fKey && (
                            <div className={r.aocBlock}>
                              {aocDraftFor === fKey ? (
                                <>
                                  <span className={r.aocLabel}>Use as Acknowledgement of Country</span>
                                  <textarea
                                    className={r.aocInput}
                                    rows={3}
                                    value={aocDraftText}
                                    onChange={(e) => setAocDraftText(e.target.value)}
                                    placeholder="Acknowledge the Traditional Custodians of this Country. Edit before saving."
                                  />
                                  <div className={r.aocActions}>
                                    <button
                                      type="button"
                                      className={`btn btn-primary ${r.aocSave}`}
                                      onClick={handleSaveAocDraft}
                                      disabled={!aocDraftText.trim()}
                                    >
                                      Save as Acknowledgement
                                    </button>
                                    <button
                                      type="button"
                                      className={r.aocCancel}
                                      onClick={() => { setAocDraftFor(null); setAocDraftText(""); }}
                                    >
                                      Cancel
                                    </button>
                                    <span className={r.aocHint}>
                                      Appears on every exported case report. You can edit it any time in Setup.
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className={r.aocOpen}
                                  onClick={() => handleOpenAocDraft(fKey, f.body)}
                                  title={prefs.acknowledgementOfCountry.accepted
                                    ? "Replace your existing Acknowledgement of Country with this finding's text."
                                    : "Use this finding's text as your Acknowledgement of Country."}
                                >
                                  ↑ Use as Acknowledgement of Country
                                  {prefs.acknowledgementOfCountry.accepted && (
                                    <span className={r.aocReplaces}> (replaces current)</span>
                                  )}
                                </button>
                              )}
                            </div>
                          )}

                          {/* Reviewer note — anchored to a stable content
                              key so it survives the findings array being
                              re-ordered. Disabled (with a hint) until the
                              dossier is saved or loaded, since the note
                              row needs a dossier_id foreign key. */}
                          {canNote && fKey ? (
                            <div className={r.noteBlock}>
                              <label className={r.noteLabel}>
                                Reviewer note
                                {note?.savedText && note.savedText.length > 0 && !noteDirty && (
                                  <span className={r.noteSaved}> · saved</span>
                                )}
                                {noteDirty && <span className={r.noteDirty}> · unsaved</span>}
                                {/* Tier-aware seed template — fills the
                                    textarea with a verification scaffold the
                                    operator can edit. No AI call, no rate
                                    limit impact. Disabled when there's
                                    already user content to avoid blowing it
                                    away accidentally. */}
                                <button
                                  type="button"
                                  className={r.noteSeed}
                                  onClick={() => handleNoteChange(fKey, NOTE_TEMPLATES[f.tier](f))}
                                  disabled={(note?.text ?? "").trim().length > 0}
                                  title={(note?.text ?? "").trim().length > 0
                                    ? "Clear the note first if you want to seed a fresh template."
                                    : "Seed a tier-appropriate verification scaffold you can edit."}
                                >
                                  Seed template
                                </button>
                              </label>
                              <textarea
                                className={r.noteInput}
                                rows={2}
                                placeholder={`e.g. "Verified via Trove on ${new Date().toLocaleDateString()}", or context for the on-camera read`}
                                value={note?.text ?? ""}
                                onChange={(e) => handleNoteChange(fKey, e.target.value)}
                                onBlur={() => handleNoteSave(fKey)}
                                maxLength={2000}
                              />
                            </div>
                          ) : null}
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
