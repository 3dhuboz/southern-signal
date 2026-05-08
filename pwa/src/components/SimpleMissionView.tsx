/**
 * SimpleMissionView — amateur-friendly rendering of the Mission Control
 * data. The math, the hash chain, and the contamination markers all
 * still run; this component is purely a presentation layer.
 *
 * Hierarchy:
 *
 *   1. Activity card  — plain-English status + simple gauge + timer
 *   2. Big start/stop — single primary call to action
 *   3. Quick actions  — Drop a marker · Mark interference · Ask a question
 *   4. What's happening — chronological plain-English event feed
 *
 * Pro mode (gated behind ExperienceToggle in the header) renders the
 * fuller instrument cluster instead.
 */

import { useCallback, useState } from "react";
import { ScreenRecordButton } from "./ScreenRecordButton";
import type { LogIncrement } from "../lib/posterior/posterior";
import {
  describeActivity,
  describeChannel,
  describeSector,
  plainEnglishReason,
} from "../lib/posterior/plainEnglish";
import { emitContamination } from "../lib/posterior/likelihoods";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent } from "../lib/db/repo";
import s from "./SimpleMissionView.module.css";

interface ContaminationOpt {
  id: string;
  label: string;
  hint: string;
  window: number;
}

const CONTAMINATION_OPTS: ContaminationOpt[] = [
  { id: "voice_me",    label: "Someone in our group spoke",    hint: "We talked, hummed, or laughed",       window: 30 },
  { id: "voice_other", label: "Outside voices nearby",          hint: "Neighbour, passer-by, TV next door",  window: 30 },
  { id: "footstep",    label: "We moved or stepped",            hint: "Floorboard, stair, gravel",           window: 15 },
  { id: "bump",        label: "Bump or knock from us",          hint: "Camera knock, gear shift",            window: 15 },
  { id: "vehicle",     label: "Vehicle outside",                hint: "Car, truck, motorbike",               window: 30 },
  { id: "hvac",        label: "Building system kicked on",      hint: "Aircon, fridge, fan, heater",         window: 60 },
  { id: "cough",       label: "Cough or sneeze",                hint: "From any of us",                      window: 15 },
  { id: "rustle",      label: "Clothing or paper rustle",       hint: "Pocket, notebook, tarp",              window: 15 },
  { id: "other",       label: "Something else explainable",     hint: "Tag now, describe later",             window: 30 },
];

interface SimpleMissionViewProps {
  running: boolean;
  busy: boolean;
  posterior: number;
  elapsedSeconds: number;
  caseId: string | null;
  caseTitle: string | null;
  statusMsg: string;
  recentIncrements: LogIncrement[];
  trustworthy: boolean;
  hasInvestigation: boolean;
  investigationId: string | null;
  onBegin: () => void;
  onStop: () => void;
  onMarker: () => void;
  onAskQuestion: () => void;
  emitEvidence: (input: {
    channel: string;
    logLr: number;
    reason: string;
    metadata?: Record<string, unknown>;
    nowMs: number;
  }) => Promise<unknown>;
}

function formatHMS(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(t / 3600).toString().padStart(2, "0");
  const mm = Math.floor((t % 3600) / 60).toString().padStart(2, "0");
  const ss = (t % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function relativeTime(now: number, ts: number): string {
  const dt = Math.max(0, Math.floor((now - ts) / 1000));
  if (dt < 5) return "just now";
  if (dt < 60) return `${dt}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  return `${Math.floor(dt / 3600)}h ago`;
}

export function SimpleMissionView(props: SimpleMissionViewProps) {
  const {
    running, busy, posterior, elapsedSeconds, caseId, caseTitle, statusMsg,
    recentIncrements, trustworthy, hasInvestigation, investigationId,
    onBegin, onStop, onMarker, onAskQuestion, emitEvidence,
  } = props;
  const [markSheetOpen, setMarkSheetOpen] = useState(false);
  const [latched, setLatched] = useState<string | null>(null);

  const activity = describeActivity(posterior);

  const handleContamination = useCallback(async (opt: ContaminationOpt) => {
    if (!investigationId || !running) return;
    try { navigator.vibrate?.(35); } catch { /* ignore */ }
    const now = Date.now();
    const evidence = emitContamination({ tag: opt.id, appliesToWindowSeconds: opt.window });
    await emitEvidence({
      channel: evidence.channel,
      logLr: evidence.logLr,
      reason: `${opt.label.toLowerCase()} (window ${opt.window}s)`,
      metadata: evidence.metadata,
      nowMs: now,
    });
    await recordEvent({
      investigation_id: investigationId,
      source: "user",
      event_type: "contamination",
      title: opt.label,
      metadata: { tag: opt.id, window_s: opt.window, ts_ms: now },
    });
    await appendAuditEntry({
      actor: "user",
      kind: "contamination.tag",
      payload: { investigation_id: investigationId, tag: opt.id, window_s: opt.window, ts_ms: now },
    });
    setLatched(opt.id);
    window.setTimeout(() => setLatched((cur) => (cur === opt.id ? null : cur)), 1100);
    window.setTimeout(() => setMarkSheetOpen(false), 350);
  }, [investigationId, running, emitEvidence]);

  const now = Date.now();
  const feedItems = [...recentIncrements].reverse().slice(0, 8);

  return (
    <section className={s.wrap}>
      {/* ACTIVITY CARD */}
      <div className={`${s.card} ${s[`band_${activity.id}`]}`}>
        <div className={s.cardTopRow}>
          <span className={`${s.statusPill} ${running ? s.statusPillActive : ""}`.trim()}>
            <span className={s.statusDot} />
            {running ? "Recording" : "Standing by"}
          </span>
          <ScreenRecordButton investigationId={investigationId} />
          {caseId && <span className={s.caseId}>{caseId.slice(0, 8).toUpperCase()}</span>}
        </div>

        <div className={s.activityHead}>{caseTitle ?? "Tap Begin to start"}</div>
        <div className={s.activityLabel}>{activity.label}</div>
        <div className={s.gauge} aria-hidden="true">
          <div className={s.gaugeTrack}>
            <span className={s.gaugeFill} style={{ width: `${Math.round(posterior * 100)}%` }} />
          </div>
        </div>
        <div className={s.activityHint}>{activity.hint}</div>

        <div className={s.timer}>{formatHMS(elapsedSeconds)}</div>
        <div className={s.timerLabel}>SESSION TIME</div>

        <p className={s.statusMsg}>{statusMsg}</p>

        {!trustworthy && running && (
          <p className={s.calibrationNudge}>
            Tip: switch to Pro mode to run the 3-of-3 calibration check before trusting direction readings.
          </p>
        )}

        <img
          className={s.partnerWatermark}
          src="/yep-boys-logo.svg"
          alt=""
          aria-hidden="true"
          width={36}
          height={36}
        />
      </div>

      {/* PRIMARY CALL TO ACTION */}
      <div className={s.controls}>
        {!running ? (
          <button type="button" className={s.primary} onClick={onBegin} disabled={busy}>
            {busy ? "Starting…" : hasInvestigation ? "Begin session" : "Begin a new session"}
          </button>
        ) : (
          <button type="button" className={s.danger} onClick={onStop} disabled={busy}>
            End session
          </button>
        )}
      </div>

      {/* QUICK ACTIONS */}
      <div className={s.quickActions}>
        <button type="button" className={s.quick} onClick={onMarker} disabled={!running || busy}>
          <span className={s.quickIcon} aria-hidden="true">📍</span>
          <span className={s.quickLabel}>Mark this moment</span>
          <span className={s.quickHint}>Saves a timestamp</span>
        </button>
        <button type="button" className={s.quick} onClick={() => setMarkSheetOpen(true)} disabled={!running || busy}>
          <span className={s.quickIcon} aria-hidden="true">🚧</span>
          <span className={s.quickLabel}>Mark interference</span>
          <span className={s.quickHint}>Tag a normal cause</span>
        </button>
        <button type="button" className={s.quick} onClick={onAskQuestion} disabled={busy || !investigationId}>
          <span className={s.quickIcon} aria-hidden="true">💬</span>
          <span className={s.quickLabel}>Ask a question</span>
          <span className={s.quickHint}>Respectful prompt by AI</span>
        </button>
      </div>

      {/* EVENT FEED */}
      <div className={s.feed} aria-label="What's been happening">
        <header className={s.feedHead}>
          <span className={s.feedEyebrow}>WHAT'S BEEN HAPPENING</span>
          <span className={s.feedNote}>Newest at the top</span>
        </header>
        {feedItems.length === 0 ? (
          <p className={s.feedEmpty}>
            {running
              ? "Listening. The newest readings will appear here in plain English."
              : "Nothing yet. Begin a session to start recording."}
          </p>
        ) : (
          <ol className={s.feedList}>
            {feedItems.map((inc, i) => {
              const ch = describeChannel(inc.channel);
              const sectorPart = describeSector(((inc.metadata as Record<string, unknown>)?.sector as string) ?? null);
              const reason = plainEnglishReason(inc.reason);
              return (
                <li key={`${inc.ts}-${i}`} className={s.feedRow}>
                  <span className={s.feedEmoji}>{ch.emoji}</span>
                  <div className={s.feedBody}>
                    <span className={s.feedKind}>
                      {ch.label}
                      {sectorPart ? ` · ${sectorPart}` : ""}
                    </span>
                    <span className={s.feedReason}>{reason}</span>
                  </div>
                  <span className={s.feedTs}>{relativeTime(now, inc.ts)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <p className={s.disclaimer}>
        AI proposes; you decide. Activity readings come from the phone's mic and sensors — they're not proof of anything supernatural. Switch to Pro for the underlying numbers and audit chain.
      </p>

      {/* MARK INTERFERENCE SHEET */}
      {markSheetOpen && (
        <div className={s.sheetBackdrop} role="dialog" aria-modal="true" aria-label="Mark interference" onClick={() => setMarkSheetOpen(false)}>
          <div className={s.sheet} onClick={(e) => e.stopPropagation()}>
            <header className={s.sheetHead}>
              <span className={s.sheetTitle}>Mark interference</span>
              <button type="button" className={s.sheetClose} onClick={() => setMarkSheetOpen(false)} aria-label="Close">×</button>
            </header>
            <p className={s.sheetLede}>
              Heard a normal cause? Tap it. We'll subtract from the activity reading so the recording stays honest.
            </p>
            <ul className={s.sheetList}>
              {CONTAMINATION_OPTS.map((opt) => {
                const isLatched = latched === opt.id;
                return (
                  <li key={opt.id}>
                    <button
                      type="button"
                      className={`${s.sheetItem} ${isLatched ? s.sheetItemLatched : ""}`.trim()}
                      onClick={() => handleContamination(opt)}
                    >
                      <span className={s.sheetItemLabel}>{opt.label}</span>
                      <span className={s.sheetItemHint}>{opt.hint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
