/**
 * ContaminationMarker — quick-tap labelled buttons surfaced during a live
 * session. The investigator (or the on-camera presenter) taps a tag the
 * moment they hear themselves talk, a footstep, an HVAC kick, etc.
 *
 * Effect on the posterior: emitContamination applies a NEGATIVE log LR
 * (-3.0) within a 30-second window. This is the headline skeptic move —
 * explicit evidence FOR mundanity, not a passive "we'll figure it out
 * later." Reviewer also sees the tagged window flagged in Review.
 *
 * On-camera UX: large 44px+ buttons, haptic on tap, single-tap action,
 * latched 1.2s confirmation pulse so the presenter and the audience see
 * what was tagged.
 */

import { useCallback, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent } from "../lib/db/repo";
import { emitContamination } from "../lib/posterior/likelihoods";
import s from "./ContaminationMarker.module.css";

const TAG_DEFINITIONS: { id: string; label: string; window: number }[] = [
  { id: "voice_me", label: "Voice — me", window: 30 },
  { id: "voice_other", label: "Voice — other", window: 30 },
  { id: "footstep", label: "Footstep", window: 15 },
  { id: "bump", label: "Bump", window: 15 },
  { id: "vehicle", label: "Vehicle", window: 30 },
  { id: "hvac", label: "HVAC", window: 60 },
  { id: "cough", label: "Cough", window: 15 },
  { id: "rustle", label: "Rustle", window: 15 },
  { id: "other", label: "Other", window: 30 },
];

interface ContaminationMarkerProps {
  investigationId: string | null;
  running: boolean;
  /** Inject the negative log LR via the existing emitEvidence pipeline. */
  emitEvidence: (input: {
    channel: string;
    logLr: number;
    reason: string;
    metadata?: Record<string, unknown>;
    nowMs: number;
  }) => Promise<unknown>;
}

export function ContaminationMarker({ investigationId, running, emitEvidence }: ContaminationMarkerProps) {
  const [latchedTag, setLatchedTag] = useState<string | null>(null);

  const handleTap = useCallback(
    async (tag: { id: string; label: string; window: number }) => {
      if (!investigationId || !running) return;
      // Haptic — non-fatal if not supported.
      try { navigator.vibrate?.(35); } catch { /* ignore */ }
      const now = Date.now();
      const evidence = emitContamination({ tag: tag.id, appliesToWindowSeconds: tag.window });
      await emitEvidence({
        channel: evidence.channel,
        logLr: evidence.logLr,
        reason: evidence.reason,
        metadata: evidence.metadata,
        nowMs: now,
      });
      // Persist as observation so the Review waveform can render a gray bar.
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "contamination",
        title: tag.label,
        metadata: { tag: tag.id, window_s: tag.window, ts_ms: now },
      });
      // Hash-chain a dedicated audit entry too — this is the kind of thing
      // an external reviewer specifically wants to count.
      await appendAuditEntry({
        actor: "user",
        kind: "contamination.tag",
        payload: { investigation_id: investigationId, tag: tag.id, window_s: tag.window, ts_ms: now },
      });
      setLatchedTag(tag.id);
      window.setTimeout(() => setLatchedTag((cur) => (cur === tag.id ? null : cur)), 1200);
    },
    [investigationId, running, emitEvidence],
  );

  const disabled = !investigationId || !running;

  return (
    <div className={s.wrap} aria-label="Contamination markers">
      <div className={s.head}>
        <span className={s.eyebrow}>CONTAMINATION</span>
        <span className={s.note}>Tap when you hear it. Penalises the posterior for {"≥"}15s.</span>
      </div>
      <div className={s.grid}>
        {TAG_DEFINITIONS.map((tag) => {
          const latched = latchedTag === tag.id;
          return (
            <button
              key={tag.id}
              type="button"
              className={`${s.tag} ${latched ? s.latched : ""}`.trim()}
              onClick={() => handleTap(tag)}
              disabled={disabled}
            >
              <span className={s.tagLabel}>{tag.label}</span>
              {latched && <span className={s.tagFlash} aria-hidden="true">−3.0</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
