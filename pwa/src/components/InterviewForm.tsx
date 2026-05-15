/**
 * InterviewForm — capture one witness interview.
 *
 * Works in two modes:
 *   • Add  — no `existing` prop, calls addInterview on save.
 *   • Edit — `existing` prop pre-fills fields, calls updateInterview on save.
 *
 * Validation: witness name (required) + statement (required, ≥ 20 chars).
 */

import { useCallback, useEffect, useState } from "react";
import { addInterview, updateInterview } from "../lib/db/interviewRepo";
import type { InterviewRow, WitnessRelationship } from "../lib/db/schema";
import s from "./InterviewForm.module.css";

const RELATIONSHIPS: { value: WitnessRelationship; label: string }[] = [
  { value: "resident", label: "Resident" },
  { value: "owner", label: "Owner" },
  { value: "staff", label: "Staff" },
  { value: "visitor", label: "Visitor" },
  { value: "co-investigator", label: "Co-investigator" },
  { value: "other", label: "Other" },
];

export interface EvidenceEventRef {
  id: string;
  title: string | null;
  timestamp: string;
}

interface InterviewFormProps {
  investigationId: string;
  existing?: InterviewRow;
  evidenceEvents?: EvidenceEventRef[];
  onSave: (interview: InterviewRow) => void;
  onCancel?: () => void;
}

function formatEventTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/** Convert a local datetime-local string to ISO UTC. */
function localToIso(local: string): string {
  if (!local) return "";
  try {
    return new Date(local).toISOString();
  } catch {
    return local;
  }
}

/** Convert an ISO UTC string to the value expected by datetime-local inputs. */
function isoToLocal(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // "YYYY-MM-DDTHH:mm" in local timezone
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

export function InterviewForm({
  investigationId,
  existing,
  evidenceEvents = [],
  onSave,
  onCancel,
}: InterviewFormProps) {
  const isEdit = !!existing;

  const [witnessName, setWitnessName] = useState(existing?.witness_name ?? "");
  const [relationship, setRelationship] = useState<WitnessRelationship | "">(
    existing?.relationship ?? "",
  );
  const [statement, setStatement] = useState(existing?.statement ?? "");
  const [notableClaims, setNotableClaims] = useState(
    existing?.notable_claims ?? "",
  );
  const [occurredAt, setOccurredAt] = useState(
    existing?.occurred_at ? isoToLocal(existing.occurred_at) : "",
  );
  const [linkedIds, setLinkedIds] = useState<Set<string>>(() => {
    if (!existing?.linked_event_ids) return new Set();
    try {
      const parsed = JSON.parse(existing.linked_event_ids);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [statementError, setStatementError] = useState("");

  // Re-populate when existing changes (e.g. parent re-uses the form)
  useEffect(() => {
    if (!existing) return;
    setWitnessName(existing.witness_name);
    setRelationship(existing.relationship ?? "");
    setStatement(existing.statement);
    setNotableClaims(existing.notable_claims ?? "");
    setOccurredAt(existing.occurred_at ? isoToLocal(existing.occurred_at) : "");
    try {
      const parsed = existing.linked_event_ids
        ? JSON.parse(existing.linked_event_ids)
        : [];
      setLinkedIds(new Set(Array.isArray(parsed) ? parsed : []));
    } catch {
      setLinkedIds(new Set());
    }
  }, [existing]);

  const validate = useCallback((): boolean => {
    let ok = true;
    if (!witnessName.trim()) {
      setNameError("Witness name is required.");
      ok = false;
    } else {
      setNameError("");
    }
    if (statement.trim().length < 20) {
      setStatementError("Statement must be at least 20 characters.");
      ok = false;
    } else {
      setStatementError("");
    }
    return ok;
  }, [witnessName, statement]);

  const canSave =
    witnessName.trim().length > 0 && statement.trim().length >= 20 && !busy;

  const toggleEvent = useCallback((id: string) => {
    setLinkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      const linkedArr = [...linkedIds];
      let result: InterviewRow;
      if (isEdit && existing) {
        await updateInterview(existing.id, {
          witness_name: witnessName.trim(),
          relationship: relationship || undefined,
          statement: statement.trim(),
          notable_claims: notableClaims.trim() || null,
          linked_event_ids:
            linkedArr.length > 0 ? JSON.stringify(linkedArr) : null,
          occurred_at: occurredAt ? localToIso(occurredAt) : null,
        });
        // Return the updated row by merging the patch into existing.
        result = {
          ...existing,
          witness_name: witnessName.trim(),
          relationship: (relationship as WitnessRelationship) || null,
          statement: statement.trim(),
          notable_claims: notableClaims.trim() || null,
          linked_event_ids:
            linkedArr.length > 0 ? JSON.stringify(linkedArr) : null,
          occurred_at: occurredAt ? localToIso(occurredAt) : null,
          updated_at: new Date().toISOString(),
        };
      } else {
        result = await addInterview({
          investigationId,
          witnessName: witnessName.trim(),
          relationship: relationship || undefined,
          statement: statement.trim(),
          notableClaims: notableClaims.trim() || undefined,
          linkedEventIds: linkedArr.length > 0 ? linkedArr : undefined,
          occurredAt: occurredAt ? localToIso(occurredAt) : undefined,
        });
      }
      onSave(result);
    } finally {
      setBusy(false);
    }
  }, [
    validate,
    isEdit,
    existing,
    investigationId,
    witnessName,
    relationship,
    statement,
    notableClaims,
    occurredAt,
    linkedIds,
    onSave,
  ]);

  return (
    <div className={s.wrap} role="form" aria-label={isEdit ? "Edit witness interview" : "Add witness interview"}>
      <header className={s.head}>
        <span className={s.eyebrow}>
          {isEdit ? "Edit Interview" : "New Interview"}
        </span>
      </header>

      <div className={s.fields}>
        {/* Witness name */}
        <div className={s.fieldGroup}>
          <label className={s.label} htmlFor="ifw-name">
            Witness name<span className={s.required}>*</span>
          </label>
          <input
            id="ifw-name"
            className={`${s.input} ${nameError ? s.inputError : ""}`.trim()}
            type="text"
            value={witnessName}
            onChange={(e) => setWitnessName(e.target.value)}
            placeholder="Full name or pseudonym"
            autoComplete="off"
          />
          {nameError && <span className={s.errorMsg}>{nameError}</span>}
        </div>

        {/* Relationship */}
        <div className={s.fieldGroup}>
          <label className={s.label} htmlFor="ifw-rel">
            Relationship to location
          </label>
          <select
            id="ifw-rel"
            className={s.select}
            value={relationship}
            onChange={(e) => setRelationship(e.target.value as WitnessRelationship | "")}
          >
            <option value="">— Select —</option>
            {RELATIONSHIPS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Statement */}
        <div className={s.fieldGroup}>
          <label className={s.label} htmlFor="ifw-statement">
            Statement<span className={s.required}>*</span>
          </label>
          <span className={s.hint}>What did the witness report?</span>
          <textarea
            id="ifw-statement"
            className={`${s.textarea} ${s.tall} ${statementError ? s.inputError : ""}`.trim()}
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            placeholder="In the witness's own words…"
          />
          {statementError && (
            <span className={s.errorMsg}>{statementError}</span>
          )}
        </div>

        {/* Notable claims */}
        <div className={s.fieldGroup}>
          <label className={s.label} htmlFor="ifw-claims">
            Notable claims
          </label>
          <span className={s.hint}>
            Key bullet points from the interview (investigator notes)
          </span>
          <textarea
            id="ifw-claims"
            className={s.textarea}
            value={notableClaims}
            onChange={(e) => setNotableClaims(e.target.value)}
            placeholder="• Heard footsteps upstairs at ~22:15&#10;• Felt cold spot near doorway"
          />
        </div>

        {/* Occurred at */}
        <div className={s.fieldGroup}>
          <label className={s.label} htmlFor="ifw-at">
            Interview date &amp; time
          </label>
          <span className={s.hint}>When did this interview take place?</span>
          <input
            id="ifw-at"
            className={s.input}
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </div>

        {/* Linked evidence events */}
        {evidenceEvents.length > 0 && (
          <div className={s.fieldGroup}>
            <span className={s.label}>Linked evidence events</span>
            <span className={s.hint}>
              Which evidence events does this account relate to?
            </span>
            <div className={s.eventsGrid} role="group" aria-label="Evidence events">
              {evidenceEvents.map((ev) => (
                <label key={ev.id} className={s.eventCheck}>
                  <input
                    type="checkbox"
                    checked={linkedIds.has(ev.id)}
                    onChange={() => toggleEvent(ev.id)}
                  />
                  <span className={s.eventCheckLabel}>
                    <span>{ev.title ?? "(untitled event)"}</span>
                    <span className={s.eventTs}>{formatEventTs(ev.timestamp)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={s.footer}>
        {onCancel && (
          <button
            type="button"
            className={s.btnCancel}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className={s.btnSave}
          onClick={handleSave}
          disabled={!canSave}
        >
          {busy ? "Saving…" : isEdit ? "Save changes" : "Save interview"}
        </button>
      </div>
    </div>
  );
}
