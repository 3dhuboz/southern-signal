/**
 * ReviewerSignoffsPanel — Setup-page panel for recording external
 * reviewer sign-offs on the methodology.
 *
 * The README commits to "an external Bayesian and an external acoustician
 * will sign off on the methodology" before any TV-grade premiere. This
 * panel turns that promise into a verifiable artefact: every sign-off is
 * persisted to the on-device DB, hash-chained through audit_log, and
 * included in the forensic export bundle so any reviewer can confirm who
 * blessed the methodology, when, and on which app version.
 *
 * The default app_version comes from the literal in manifest.ts /
 * exportBundle.ts — kept in sync by hand so the export and the sign-off
 * record agree. The form still lets the operator override it (e.g. a
 * sign-off captured against an earlier release).
 */

import { useCallback, useEffect, useState } from "react";
import {
  createSignoff,
  deleteSignoff,
  listSignoffs,
  updateSignoff,
  type SignoffInput,
} from "../lib/db/repo";
import type { ReviewerDiscipline, ReviewerSignoffRow } from "../lib/db/schema";
import st from "../views/Setup.module.css";
import s from "./ReviewerSignoffsPanel.module.css";

const DEFAULT_APP_VERSION = "0.1.0";

const DISCIPLINE_OPTIONS: { value: ReviewerDiscipline; label: string; hint: string }[] = [
  { value: "bayesian",    label: "Bayesian",    hint: "Posterior math, AHT verdict, likelihoods." },
  { value: "acoustician", label: "Acoustician", hint: "Mic capture, SRP-PHAT direction, infrasound." },
  { value: "cultural",    label: "Cultural",    hint: "AoC, sensitivity flag, Country protocols." },
  { value: "other",       label: "Other",       hint: "Forensics, archive methodology, IRB." },
];

interface FormState {
  reviewer_name: string;
  discipline: ReviewerDiscipline;
  affiliation: string;
  identifier: string;
  signed_at: string;
  app_version: string;
  source_url: string;
  statement: string;
}

function emptyForm(): FormState {
  return {
    reviewer_name: "",
    discipline: "bayesian",
    affiliation: "",
    identifier: "",
    signed_at: new Date().toISOString().slice(0, 10),
    app_version: DEFAULT_APP_VERSION,
    source_url: "",
    statement: "",
  };
}

function fromRow(row: ReviewerSignoffRow): FormState {
  return {
    reviewer_name: row.reviewer_name,
    discipline: row.discipline,
    affiliation: row.affiliation ?? "",
    identifier: row.identifier ?? "",
    signed_at: row.signed_at,
    app_version: row.app_version,
    source_url: row.source_url ?? "",
    statement: row.statement,
  };
}

function toInput(form: FormState): SignoffInput {
  return {
    reviewer_name: form.reviewer_name,
    discipline: form.discipline,
    affiliation: form.affiliation || null,
    identifier: form.identifier || null,
    signed_at: form.signed_at,
    app_version: form.app_version,
    source_url: form.source_url || null,
    statement: form.statement,
  };
}

function disciplineLabel(d: ReviewerDiscipline): string {
  return DISCIPLINE_OPTIONS.find((o) => o.value === d)?.label ?? d;
}

function formatDate(iso: string): string {
  // Treat YYYY-MM-DD as a calendar date, not a UTC midnight that drifts in
  // timezones west of UTC. Anything else falls back to the Date parser.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) {
    const [, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return dt.toLocaleDateString();
  }
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString();
}

export function ReviewerSignoffsPanel() {
  const [rows, setRows] = useState<ReviewerSignoffRow[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; form: FormState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSignoffs();
      setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleAdd = useCallback(() => {
    setError(null);
    setEditing({ id: null, form: emptyForm() });
  }, []);

  const handleEdit = useCallback((row: ReviewerSignoffRow) => {
    setError(null);
    setEditing({ id: row.id, form: fromRow(row) });
  }, []);

  const handleCancel = useCallback(() => {
    setError(null);
    setEditing(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const input = toInput(editing.form);
      if (editing.id) await updateSignoff(editing.id, input);
      else await createSignoff(input);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editing, refresh]);

  const handleDelete = useCallback(async (row: ReviewerSignoffRow) => {
    const ok = window.confirm(
      `Remove the sign-off from ${row.reviewer_name}? The deletion is recorded in the audit chain.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSignoff(row.id);
      if (editing?.id === row.id) setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editing, refresh]);

  return (
    <div className={s.wrap}>
      <p className={st.panelLede}>
        The methodology commitment: an external Bayesian and an external
        acoustician sign off before any TV-grade premiere. Recorded sign-offs
        appear on every exported case bundle's cover sheet, in
        <code> reviewers.json</code>, and as <code>reviewer.signoff.create</code>
        entries on the hash-chained audit log — a forger would have to break
        the chain to alter them.
      </p>

      {rows.length === 0 && !editing && (
        <p className={s.empty}>No sign-offs recorded yet.</p>
      )}

      {rows.length > 0 && (
        <ul className={s.list}>
          {rows.map((row) => (
            <li key={row.id} className={s.item}>
              <header className={s.itemHeader}>
                <div>
                  <span className={s.itemName}>{row.reviewer_name}</span>
                  <span className={s.itemDiscipline} data-discipline={row.discipline}>
                    {disciplineLabel(row.discipline)}
                  </span>
                </div>
                <span className={s.itemMeta}>
                  {formatDate(row.signed_at)} · v{row.app_version}
                </span>
              </header>
              {row.affiliation && (
                <p className={s.itemSubline}>{row.affiliation}</p>
              )}
              <blockquote className={s.itemStatement}>{row.statement}</blockquote>
              {(row.identifier || row.source_url) && (
                <p className={s.itemRefs}>
                  {row.identifier && <code>{row.identifier}</code>}
                  {row.identifier && row.source_url && " · "}
                  {row.source_url && (
                    <a href={row.source_url} target="_blank" rel="noopener noreferrer">
                      {row.source_url}
                    </a>
                  )}
                </p>
              )}
              <div className={s.itemActions}>
                <button
                  type="button"
                  className={st.linkBtn ?? ""}
                  onClick={() => handleEdit(row)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={st.linkBtn ?? ""}
                  onClick={() => void handleDelete(row)}
                  disabled={busy}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!editing && (
        <button type="button" className={st.linkBtn ?? ""} onClick={handleAdd}>
          Add reviewer sign-off
        </button>
      )}

      {editing && (
        <form
          className={s.form}
          onSubmit={(e) => { e.preventDefault(); void handleSave(); }}
        >
          <h3 className={s.formTitle}>
            {editing.id ? "Edit sign-off" : "New sign-off"}
          </h3>

          <div className={s.disciplineRow}>
            {DISCIPLINE_OPTIONS.map((opt) => (
              <label key={opt.value} className={s.disciplineOption} data-active={editing.form.discipline === opt.value}>
                <input
                  type="radio"
                  name="discipline"
                  value={opt.value}
                  checked={editing.form.discipline === opt.value}
                  onChange={() => setEditing({ ...editing, form: { ...editing.form, discipline: opt.value } })}
                />
                <span className={s.disciplineLabel}>{opt.label}</span>
                <span className={s.disciplineHint}>{opt.hint}</span>
              </label>
            ))}
          </div>

          <label className={st.field}>
            <span className={st.fieldLabel}>Reviewer name</span>
            <input
              className={st.input}
              type="text"
              required
              value={editing.form.reviewer_name}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, reviewer_name: e.target.value } })}
              placeholder="Prof. Example, FRSN"
            />
          </label>

          <label className={st.field}>
            <span className={st.fieldLabel}>Affiliation (optional)</span>
            <input
              className={st.input}
              type="text"
              value={editing.form.affiliation}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, affiliation: e.target.value } })}
              placeholder="Department of Statistics, ANU"
            />
          </label>

          <div className={s.gridTwo}>
            <label className={st.field}>
              <span className={st.fieldLabel}>Date signed</span>
              <input
                className={st.input}
                type="date"
                required
                value={editing.form.signed_at}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, signed_at: e.target.value } })}
              />
            </label>
            <label className={st.field}>
              <span className={st.fieldLabel}>App version</span>
              <input
                className={st.input}
                type="text"
                required
                value={editing.form.app_version}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, app_version: e.target.value } })}
                placeholder={DEFAULT_APP_VERSION}
              />
            </label>
          </div>

          <label className={st.field}>
            <span className={st.fieldLabel}>Identifier (optional)</span>
            <input
              className={st.input}
              type="text"
              value={editing.form.identifier}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, identifier: e.target.value } })}
              placeholder="ORCID 0000-0000-0000-0000"
            />
          </label>

          <label className={st.field}>
            <span className={st.fieldLabel}>Source URL (optional)</span>
            <input
              className={st.input}
              type="url"
              value={editing.form.source_url}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, source_url: e.target.value } })}
              placeholder="https://orcid.org/0000-0000-0000-0000"
            />
          </label>

          <label className={st.field}>
            <span className={st.fieldLabel}>Statement (excerpt published in the bundle)</span>
            <textarea
              className={`${st.input} ${s.statementInput}`}
              required
              maxLength={4000}
              rows={5}
              value={editing.form.statement}
              onChange={(e) => setEditing({ ...editing, form: { ...editing.form, statement: e.target.value } })}
              placeholder="I have reviewed the bounded-LR posterior model in lib/posterior/* and agree the methodology is sound for paranormal-investigation evidence at the level described in the README. — [reviewer]"
            />
          </label>

          {error && <p className={st.errorLine}>{error}</p>}

          <div className={s.formActions}>
            <button type="submit" className={`${st.linkBtn ?? ""} ${s.primary}`} disabled={busy}>
              {busy ? "Saving…" : editing.id ? "Save changes" : "Add sign-off"}
            </button>
            <button type="button" className={st.linkBtn ?? ""} onClick={handleCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
