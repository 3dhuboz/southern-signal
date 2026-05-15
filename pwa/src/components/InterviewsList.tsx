/**
 * InterviewsList — displays and manages witness interviews for one investigation.
 *
 * Features:
 *   • Loads interviews on mount + after any add/edit/delete.
 *   • Each card: witness name, relationship badge, occurred_at, statement
 *     (clamped to 3 lines with Show more toggle), notable-claims bullet list,
 *     linked-event chips.
 *   • Edit opens the InterviewForm inline below the card.
 *   • Delete requires confirm().
 *   • "+ Add witness interview" button opens the form above the list.
 */

import { useCallback, useEffect, useState } from "react";
import { deleteInterview, listInterviews } from "../lib/db/interviewRepo";
import type { InterviewRow } from "../lib/db/schema";
import { InterviewForm, type EvidenceEventRef } from "./InterviewForm";
import s from "./InterviewsList.module.css";

interface InterviewsListProps {
  investigationId: string;
  evidenceEvents?: EvidenceEventRef[];
}

function formatOccurredAt(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const day = d.getDate();
    const month = d.toLocaleString(undefined, { month: "long" });
    const year = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${month} ${year} · ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

/** Split a notable_claims string into lines for bullet rendering. */
function parseClaimsLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\n/)
    .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseLinkedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function RelationshipBadge({ value }: { value: string | null }) {
  if (!value) return null;
  const label =
    value === "co-investigator"
      ? "Co-inv."
      : value.charAt(0).toUpperCase() + value.slice(1);
  return <span className={s.badge}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Individual card
// ---------------------------------------------------------------------------

interface CardProps {
  interview: InterviewRow;
  evidenceEvents: EvidenceEventRef[];
  onEdit: () => void;
  onDeleted: () => void;
}

function InterviewCard({ interview: iv, evidenceEvents, onEdit, onDeleted }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Delete interview with "${iv.witness_name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteInterview(iv.id);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }, [iv.id, iv.witness_name, onDeleted]);

  const linkedIds = parseLinkedIds(iv.linked_event_ids);
  const linkedEvents = evidenceEvents.filter((ev) => linkedIds.includes(ev.id));
  const claimsLines = parseClaimsLines(iv.notable_claims);
  const tsLabel = formatOccurredAt(iv.occurred_at);

  return (
    <article className={s.card}>
      {/* Header */}
      <div className={s.cardHead}>
        <span className={s.cardName}>{iv.witness_name}</span>
        <RelationshipBadge value={iv.relationship} />
        {tsLabel && <span className={s.cardTs}>{tsLabel}</span>}
      </div>

      {/* Statement */}
      <p className={`${s.statement} ${expanded ? s.expanded : ""}`.trim()}>
        {iv.statement}
      </p>
      {iv.statement.length > 160 && (
        <button
          type="button"
          className={s.showMore}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {/* Notable claims */}
      {claimsLines.length > 0 && (
        <div className={s.claimsBlock}>
          <span className={s.claimsLabel}>Notable claims</span>
          <ul className={s.claimsList}>
            {claimsLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Linked event chips */}
      {linkedEvents.length > 0 && (
        <div className={s.chipsBlock}>
          <span className={s.chipsLabel}>Linked evidence</span>
          <div className={s.chips}>
            {linkedEvents.map((ev) => (
              <span key={ev.id} className={s.chip}>
                {ev.title ?? "(untitled)"}{" "}
                <span style={{ opacity: 0.55 }}>
                  ·{" "}
                  {new Date(ev.timestamp).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className={s.cardActions}>
        <button type="button" className={s.btnEdit} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={s.btnDelete}
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Main list
// ---------------------------------------------------------------------------

export function InterviewsList({
  investigationId,
  evidenceEvents = [],
}: InterviewsListProps) {
  const [interviews, setInterviews] = useState<InterviewRow[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const rows = await listInterviews(investigationId);
    setInterviews(rows);
  }, [investigationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSaved = useCallback(
    (_row: InterviewRow) => {
      setShowAddForm(false);
      setEditingId(null);
      void reload();
    },
    [reload],
  );

  const handleDeleted = useCallback(() => {
    void reload();
  }, [reload]);

  return (
    <div className={s.wrap}>
      {/* Header */}
      <div className={s.listHead}>
        <span className={s.eyebrow}>
          Witness Interviews ({interviews.length})
        </span>
        {!showAddForm && (
          <button
            type="button"
            className={s.btnAdd}
            onClick={() => {
              setEditingId(null);
              setShowAddForm(true);
            }}
          >
            + Add witness interview
          </button>
        )}
      </div>

      {/* Inline add form */}
      {showAddForm && (
        <div className={s.formWrap}>
          <InterviewForm
            investigationId={investigationId}
            evidenceEvents={evidenceEvents}
            onSave={handleSaved}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Cards */}
      {interviews.length === 0 && !showAddForm ? (
        <p className={s.empty}>
          No witness interviews recorded yet. Use the button above to add one.
        </p>
      ) : (
        <div className={s.cards}>
          {interviews.map((iv) => (
            <div key={iv.id}>
              {editingId === iv.id ? (
                <div className={s.formWrap}>
                  <InterviewForm
                    investigationId={investigationId}
                    existing={iv}
                    evidenceEvents={evidenceEvents}
                    onSave={handleSaved}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <InterviewCard
                  interview={iv}
                  evidenceEvents={evidenceEvents}
                  onEdit={() => {
                    setShowAddForm(false);
                    setEditingId(iv.id);
                  }}
                  onDeleted={handleDeleted}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
