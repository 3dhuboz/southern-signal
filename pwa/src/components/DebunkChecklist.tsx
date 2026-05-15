/**
 * DebunkChecklist — mandatory 8–12 item ruled-out checklist for flagged
 * evidence events (Tier 1 #7 — Debunking-First Review).
 *
 * For each of the 12 stable DEBUNK_ITEMS, the investigator records whether
 * they can rule the mundane explanation out. Every item they cannot rule out
 * applies a −8 confidence penalty to the event's posterior.
 *
 * Design conventions follow ContaminationMarker: compact, action-oriented,
 * field-ready. Same CSS variables, same eyebrow/note header pattern, same
 * button dimensions (44px+).
 */

import { useCallback, useEffect, useState } from "react";
import { DEBUNK_ITEMS, type DebunkItemSlug, type DebunkVerdict } from "../lib/db/schema";
import { getDebunkChecklist, saveDebunkVerdict } from "../lib/db/debunkRepo";
import s from "./DebunkChecklist.module.css";

export interface DebunkChecklistProps {
  investigationId: string;
  eventId: string;
  /** Shown in the header for context — omitted if not provided. */
  eventTitle?: string;
  /** Fires after the last item is saved; receives the cannot_rule_out count. */
  onComplete?: (cannotRuleOutCount: number) => void;
}

// Per-item local state during editing.
interface ItemState {
  verdict: DebunkVerdict | null;
  notes: string;
}

type ItemStateMap = Record<DebunkItemSlug, ItemState>;

function emptyItemState(): ItemStateMap {
  return Object.fromEntries(
    DEBUNK_ITEMS.map((item) => [item.slug, { verdict: null, notes: "" }]),
  ) as ItemStateMap;
}

const PENALTY_PER_ITEM = 8;

const VERDICT_LABELS: Record<DebunkVerdict, string> = {
  ruled_out: "Ruled out",
  cannot_rule_out: "Cannot rule out",
  na: "N/A",
};

export function DebunkChecklist({ investigationId, eventId, eventTitle, onComplete }: DebunkChecklistProps) {
  const [itemState, setItemState] = useState<ItemStateMap>(emptyItemState);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Shared notes field — one block of free text for the whole checklist,
  // not per-item (this keeps the field-ready UI compact).
  const [sharedNotes, setSharedNotes] = useState("");

  // Load existing rows from the DB on mount (or when eventId changes).
  useEffect(() => {
    setLoaded(false);
    void (async () => {
      const rows = await getDebunkChecklist(eventId);
      if (rows.length === 0) {
        setItemState(emptyItemState());
        setReadOnly(false);
        setLoaded(true);
        return;
      }
      const map = emptyItemState();
      for (const row of rows) {
        if (row.item in map) {
          map[row.item] = { verdict: row.verdict, notes: row.notes ?? "" };
        }
      }
      setItemState(map);
      // If every item has a verdict we start in read-only mode.
      const allAnswered = DEBUNK_ITEMS.every((item) => map[item.slug].verdict !== null);
      setReadOnly(allAnswered);
      // Use the first non-empty note as the shared note field initial value.
      const firstNote = rows.find((r) => r.notes)?.notes ?? "";
      setSharedNotes(firstNote);
      setLoaded(true);
    })();
  }, [eventId]);

  const setVerdict = useCallback((slug: DebunkItemSlug, verdict: DebunkVerdict) => {
    setItemState((prev) => ({
      ...prev,
      [slug]: { ...prev[slug], verdict },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      let cannotRuleOutCount = 0;
      for (const item of DEBUNK_ITEMS) {
        const state = itemState[item.slug];
        const verdict: DebunkVerdict = state.verdict ?? "na";
        if (verdict === "cannot_rule_out") cannotRuleOutCount++;
        await saveDebunkVerdict({
          investigationId,
          eventId,
          item: item.slug,
          verdict,
          notes: sharedNotes || undefined,
        });
      }
      setReadOnly(true);
      onComplete?.(cannotRuleOutCount);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [investigationId, eventId, itemState, sharedNotes, onComplete]);

  const cannotRuleOutCount = DEBUNK_ITEMS.filter(
    (item) => itemState[item.slug].verdict === "cannot_rule_out",
  ).length;

  const totalPenalty = cannotRuleOutCount * PENALTY_PER_ITEM;
  const answeredCount = DEBUNK_ITEMS.filter(
    (item) => itemState[item.slug].verdict !== null,
  ).length;
  const allAnswered = answeredCount === DEBUNK_ITEMS.length;

  if (!loaded) {
    return (
      <div className={s.wrap} aria-busy="true">
        <span className={s.loadingNote}>Loading checklist…</span>
      </div>
    );
  }

  return (
    <div className={s.wrap} aria-label="Debunking checklist">
      <div className={s.head}>
        <span className={s.eyebrow}>DEBUNKING CHECKLIST</span>
        {eventTitle && <span className={s.eventTitle}>{eventTitle}</span>}
        <span className={s.note}>
          For each potential mundane explanation, record whether you can rule it out.
          Each item you cannot rule out applies a {PENALTY_PER_ITEM} confidence penalty to the posterior.
        </span>
      </div>

      <ul className={s.itemList} aria-label="Checklist items">
        {DEBUNK_ITEMS.map((item) => {
          const state = itemState[item.slug];
          return (
            <li key={item.slug} className={s.itemRow}>
              <span className={s.itemLabel}>{item.label}</span>
              <div className={s.itemBtns} role="group" aria-label={`Verdict for ${item.label}`}>
                {(["ruled_out", "cannot_rule_out", "na"] as DebunkVerdict[]).map((verdict) => {
                  const selected = state.verdict === verdict;
                  let btnClass = s.verdictBtn;
                  if (selected) {
                    if (verdict === "ruled_out") btnClass = `${s.verdictBtn} ${s.verdictRuledOut}`;
                    else if (verdict === "cannot_rule_out") btnClass = `${s.verdictBtn} ${s.verdictCannot}`;
                    else btnClass = `${s.verdictBtn} ${s.verdictNa}`;
                  }
                  return (
                    <button
                      key={verdict}
                      type="button"
                      className={btnClass}
                      disabled={readOnly}
                      aria-pressed={selected}
                      onClick={() => setVerdict(item.slug, verdict)}
                    >
                      {VERDICT_LABELS[verdict]}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={s.notesBlock}>
        <label className={s.notesLabel} htmlFor={`debunk-notes-${eventId}`}>
          Notes <span className={s.notesHint}>(optional — document anything unclear)</span>
        </label>
        <textarea
          id={`debunk-notes-${eventId}`}
          className={s.notesArea}
          rows={3}
          value={sharedNotes}
          disabled={readOnly}
          onChange={(e) => setSharedNotes(e.target.value)}
          placeholder="Any additional context, equipment readings, conditions…"
        />
      </div>

      <div className={s.penaltySummary} aria-live="polite">
        {cannotRuleOutCount > 0 ? (
          <span className={s.penaltyActive}>
            {cannotRuleOutCount} item{cannotRuleOutCount === 1 ? "" : "s"} not ruled out
            {" — "}posterior penalty: −{cannotRuleOutCount} × {PENALTY_PER_ITEM} = −{totalPenalty} confidence points
          </span>
        ) : answeredCount > 0 ? (
          <span className={s.penaltyClear}>
            All answered — no confidence penalty applied
          </span>
        ) : (
          <span className={s.penaltyNeutral}>
            {answeredCount}/{DEBUNK_ITEMS.length} items answered
          </span>
        )}
      </div>

      {saveError && (
        <p className={s.errorNote} role="alert">{saveError}</p>
      )}

      {readOnly ? (
        <div className={s.readOnlyBar}>
          <span className={s.readOnlyNote}>Checklist saved</span>
          <button type="button" className={s.editBtn} onClick={() => setReadOnly(false)}>
            Edit
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={s.saveBtn}
          disabled={saving || !allAnswered}
          onClick={handleSave}
          title={allAnswered ? undefined : `Answer all ${DEBUNK_ITEMS.length} items before saving`}
        >
          {saving ? "Saving…" : `Save checklist (${answeredCount}/${DEBUNK_ITEMS.length})`}
        </button>
      )}
    </div>
  );
}
