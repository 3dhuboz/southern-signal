/**
 * EventDebunkPanel — collapsible wrapper that embeds a DebunkChecklist
 * inside case-review views (Tier 1 #7).
 *
 * When `required` is true (e.g. the event disposition is "flagged"), the panel
 * renders a prominent "DEBUNKING REQUIRED" badge that automatically expands
 * the checklist. When optional, it falls back to a collapsed <details> element.
 *
 * Styling follows ContaminationMarker conventions — same CSS variables,
 * same eyebrow pattern.
 */

import { useEffect, useRef, useState } from "react";
import { DebunkChecklist } from "./DebunkChecklist";
import { countCannotRuleOut } from "../lib/db/debunkRepo";
import s from "./EventDebunkPanel.module.css";

export interface EventDebunkPanelProps {
  investigationId: string;
  event: {
    id: string;
    title?: string | null;
    event_type: string;
  };
  /**
   * When true, shows "DEBUNKING REQUIRED" badge and auto-expands.
   * Pass `true` for events flagged as suspicious.
   */
  required?: boolean;
}

export function EventDebunkPanel({ investigationId, event, required = false }: EventDebunkPanelProps) {
  const [expanded, setExpanded] = useState(required);
  const [cannotCount, setCannotCount] = useState<number | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Load the current cannot_rule_out count on mount so the badge shows the
  // saved state even before the checklist is opened.
  useEffect(() => {
    void (async () => {
      const n = await countCannotRuleOut(event.id);
      setCannotCount(n);
    })();
  }, [event.id]);

  const handleComplete = (count: number) => {
    setCannotCount(count);
  };

  const title = event.title ?? event.event_type;

  // ── Required mode: prominent badge + always-rendered checklist ──────────
  if (required) {
    return (
      <div className={`${s.panel} ${s.panelRequired}`.trim()}>
        <button
          type="button"
          className={s.requiredBadge}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={s.requiredIcon} aria-hidden="true">⚠</span>
          <span className={s.requiredLabel}>DEBUNKING REQUIRED</span>
          {cannotCount !== null && cannotCount > 0 && (
            <span className={s.penaltyChip}>
              −{cannotCount * 8} pts
            </span>
          )}
          {cannotCount !== null && cannotCount === 0 && (
            <span className={s.clearedChip}>cleared</span>
          )}
          <span className={s.chevron} aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
        {expanded && (
          <div className={s.checklistWrap}>
            <DebunkChecklist
              investigationId={investigationId}
              eventId={event.id}
              eventTitle={title}
              onComplete={handleComplete}
            />
          </div>
        )}
      </div>
    );
  }

  // ── Optional mode: collapsed <details> ──────────────────────────────────
  return (
    <div className={s.panel}>
      <details ref={detailsRef} className={s.details}>
        <summary className={s.summary}>
          <span className={s.summaryLabel}>Debunking checklist</span>
          {cannotCount !== null && cannotCount > 0 && (
            <span className={s.penaltyChip}>
              −{cannotCount * 8} pts
            </span>
          )}
          {cannotCount !== null && cannotCount === 0 && (
            <span className={s.clearedChip}>cleared</span>
          )}
        </summary>
        <div className={s.checklistWrap}>
          <DebunkChecklist
            investigationId={investigationId}
            eventId={event.id}
            eventTitle={title}
            onComplete={handleComplete}
          />
        </div>
      </details>
    </div>
  );
}
