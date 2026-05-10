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

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ScreenRecordButton } from "./ScreenRecordButton";
import type { LogIncrement } from "../lib/posterior/posterior";
import type { BaselineSummary } from "../lib/posterior/sessionBaseline";
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
  /** Captured site baseline for this investigation, or null if none yet. Drives the readiness banner. */
  baseline: BaselineSummary | null;
  hasInvestigation: boolean;
  investigationId: string | null;
  audioRms: number;
  sectorReading: { sector: string | null; coherence: number; trustworthy: boolean } | null;
  narratorCaption: string | null;
  narratorSpeak: boolean;
  onToggleNarratorSpeak: (next: boolean) => void;
  onBegin: () => void;
  onStop: () => void;
  onMarker: () => void;
  onAskQuestion: () => void;
  onBroadcastLive: () => void;
  /** True when the LiveStreamView is actively broadcasting via WHIP. */
  broadcasting: boolean;
  /** True when the LiveStreamView is recording a local clip. */
  recordingClip: boolean;
  /** Per-case cultural-sensitivity flag, mirroring Pro hero. */
  culturallySensitive: boolean;
  /** Toggle the per-case flag. Null when there's no active investigation. */
  onToggleSensitive: (() => void) | null;
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

const SECTOR_ANGLE: Record<string, number> = {
  "FRONT-L": 300,
  "FRONT-C": 0,
  "FRONT-R": 60,
  "REAR-R": 120,
  "REAR-C": 180,
  "REAR-L": 240,
};

function ActivityDial({ posterior, sector }: { posterior: number; sector: string | null }) {
  // Donut arc: stroke-dashoffset proportional to posterior.
  const r = 95;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, posterior));
  const angle = sector != null ? SECTOR_ANGLE[sector] ?? null : null;

  // sector dot position relative to centre (110, 110) on a 220px viewBox.
  let dotX = 0;
  let dotY = 0;
  if (angle != null) {
    const rad = (angle - 90) * (Math.PI / 180);
    dotX = 110 + r * Math.cos(rad);
    dotY = 110 + r * Math.sin(rad);
  }

  return (
    <svg viewBox="0 0 220 220" className={s.dialSvg} aria-hidden="true">
      <defs>
        <linearGradient id="ssDialFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--accent-soft)" />
          <stop offset="100%" stopColor="var(--accent-strong)" />
        </linearGradient>
        <radialGradient id="ssDialGlow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.45" />
          <stop offset="60%" stopColor="var(--accent-strong)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--accent-strong)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={110} cy={110} r={r} fill="url(#ssDialGlow)" />
      <circle cx={110} cy={110} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={2} fill="none" />
      <circle
        cx={110}
        cy={110}
        r={r}
        stroke="url(#ssDialFill)"
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - filled)}
        transform="rotate(-90 110 110)"
        fill="none"
        style={{ transition: "stroke-dashoffset 480ms ease-out" }}
      />
      {/* Tick marks every 60° for the 6 sectors */}
      {[0, 60, 120, 180, 240, 300].map((a) => {
        const rad = (a - 90) * (Math.PI / 180);
        const x1 = 110 + (r - 8) * Math.cos(rad);
        const y1 = 110 + (r - 8) * Math.sin(rad);
        const x2 = 110 + (r - 2) * Math.cos(rad);
        const y2 = 110 + (r - 2) * Math.sin(rad);
        return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />;
      })}
      {angle != null && (
        <>
          <circle cx={dotX} cy={dotY} r={9} fill="var(--accent-strong)" opacity="0.18" />
          <circle cx={dotX} cy={dotY} r={5} fill="var(--accent-strong)" />
        </>
      )}
    </svg>
  );
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
    recentIncrements, trustworthy, baseline, hasInvestigation, investigationId,
    audioRms, sectorReading, narratorCaption, narratorSpeak, onToggleNarratorSpeak,
    onBegin, onStop, onMarker, onAskQuestion, onBroadcastLive, broadcasting, recordingClip,
    culturallySensitive, onToggleSensitive,
    emitEvidence,
  } = props;
  const [markSheetOpen, setMarkSheetOpen] = useState(false);
  const [latched, setLatched] = useState<string | null>(null);
  const [spectrum, setSpectrum] = useState<number[]>(() => Array(24).fill(0.04));

  const activity = describeActivity(posterior);

  // Cheap spectrum-like animation: shift bars left, push a new sample seeded
  // on the rolling RMS. Looks alive without needing a real FFT in this layer.
  useEffect(() => {
    if (!running) {
      setSpectrum((prev) => prev.map((v) => v * 0.85 + 0.04 * 0.15));
      return;
    }
    const rmsClamped = Math.max(0.04, Math.min(1, audioRms * 6));
    setSpectrum((prev) => {
      const next = prev.slice(1);
      // Wide spread: a fundamental + harmonics with random jitter so it looks like a live spectrum.
      const noise = (Math.random() - 0.5) * 0.12;
      next.push(Math.max(0.04, Math.min(1, rmsClamped + noise)));
      return next;
    });
  }, [audioRms, running]);

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
      {/* ACTIVITY CARD — animated aurora hero */}
      <div className={`${s.card} ${s[`band_${activity.id}`]}`}>
        <div className={s.cardTopRow}>
          <span className={`${s.statusPill} ${running ? s.statusPillActive : ""}`.trim()}>
            <span className={s.statusDot} />
            {running ? "Recording" : "Standing by"}
          </span>
          <ScreenRecordButton investigationId={investigationId} />
          {onToggleSensitive && (
            <button
              type="button"
              className={`${s.sensitivePill} ${culturallySensitive ? s.sensitivePillActive : ""}`.trim()}
              onClick={onToggleSensitive}
              title={culturallySensitive
                ? "This case is flagged culturally sensitive. Cloud AI and sync are blocked. Tap to clear."
                : "Tap if this site is culturally significant or restricted — blocks cloud AI and sync for this case only."}
              aria-pressed={culturallySensitive}
            >
              <span className={s.sensitivePillDot} aria-hidden="true" />
              {culturallySensitive ? "Sensitive · cloud blocked" : "Site OK"}
            </button>
          )}
          {caseId && <span className={s.caseId}>{caseId.slice(0, 8).toUpperCase()}</span>}
        </div>

        {caseTitle && <div className={s.caseTitleLabel}>{caseTitle}</div>}

        <div className={`${s.dial} ${activity.id === "calm" ? s.dialQuiet : ""}`.trim()}>
          <span className={s.dialRingPulse} aria-hidden="true" />
          <span className={s.dialRingPulse2} aria-hidden="true" />
          <ActivityDial posterior={posterior} sector={sectorReading?.sector ?? null} />
          <div className={s.dialLabel}>
            <span className={s.activityHead}>ACTIVITY</span>
            <span className={s.activityLabel}>{activity.label}</span>
          </div>
        </div>

        <div className={s.activityHint}>{activity.hint}</div>

        <div className={s.spectrum} aria-hidden="true">
          {spectrum.map((v, i) => (
            <span key={i} style={{ height: `${Math.max(8, v * 100)}%` }} />
          ))}
        </div>

        <div className={s.timerRow}>
          <span className={s.timer}>{formatHMS(elapsedSeconds)}</span>
          <span className={s.timerLabel}>SESSION TIME</span>
        </div>

        {running && (
          <span className={s.listeningRow}>
            <span className={s.listenDot} />
            <span className={s.listenDot} />
            <span className={s.listenDot} />
            Listening to room
          </span>
        )}

        <p className={s.statusMsg}>{statusMsg}</p>

        {!trustworthy && running && (
          <p className={s.calibrationNudge}>
            Tip: Pro mode runs a 3-of-3 calibration before trusting direction readings.
          </p>
        )}

      </div>

      {/* AI CO-INVESTIGATOR — live narration + speech toggle */}
      <div className={`${s.narrator} ${narratorCaption ? s.narratorActive : ""}`.trim()}>
        <div className={s.narratorHead}>
          <span className={s.narratorEyebrow}>AI CO-INVESTIGATOR</span>
          <button
            type="button"
            className={`${s.narratorSpeak} ${narratorSpeak ? s.narratorSpeakOn : ""}`.trim()}
            onClick={() => onToggleNarratorSpeak(!narratorSpeak)}
            aria-pressed={narratorSpeak}
          >
            <span className={s.narratorSpeakDot} aria-hidden="true" />
            {narratorSpeak ? "Speaking" : "Mute"}
          </button>
        </div>
        <p className={s.narratorBody}>
          {narratorCaption ?? (running ? "Watching the room. I'll narrate what I see." : "Ready when you are. Begin a session and I'll start watching.")}
        </p>
      </div>

      {/* READINESS BANNER — Simple-mode honesty: only the things the
          operator can actually act on without leaving Simple mode. The
          previous version warned about Calibration, but Simple mode has
          no calibration UI — it's a Pro-only enhancement. Showing it as
          a ⚠ row in Simple was misleading: amateurs read it as "I did
          something wrong" when there's nothing to do. Now it's a neutral
          row so the operator sees what's available without being scolded
          about features they can't reach. */}
      {!running && (() => {
        const baselineAgeMs = baseline ? Date.now() - new Date(baseline.capturedAt).getTime() : null;
        const STALE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 hours
        const baselineStale = baselineAgeMs != null && baselineAgeMs > STALE_AFTER_MS;
        const baselineFresh = baseline != null && !baselineStale;
        // Only the things the Simple-mode operator can act on contribute
        // to the headline status. Calibration is Pro-only and deliberately
        // doesn't downgrade Simple-mode readiness.
        const allOk = baselineFresh;

        const baselineAgeLabel = baselineAgeMs == null ? null
          : baselineAgeMs < 60_000 ? "just now"
          : baselineAgeMs < 3_600_000 ? `${Math.round(baselineAgeMs / 60_000)} min ago`
          : baselineAgeMs < 86_400_000 ? `${Math.round(baselineAgeMs / 3_600_000)} h ago`
          : `${Math.round(baselineAgeMs / 86_400_000)} d ago`;

        return (
          <div className={`${s.readiness} ${allOk ? s.readinessOk : s.readinessWarn}`.trim()}>
            <div className={s.readinessHeadRow}>
              <span className={s.readinessIcon} aria-hidden="true">{allOk ? "✓" : "⚠"}</span>
              <strong>{allOk ? "Ready to record" : "One step optional before recording"}</strong>
            </div>
            <ul className={s.readinessList}>
              <li className={s.readinessRow}>
                <span className={`${s.readinessTick} ${trustworthy ? s.tickOk : s.tickInfo}`.trim()} aria-hidden="true">
                  {trustworthy ? "✓" : "·"}
                </span>
                <span className={s.readinessRowBody}>
                  <strong>Calibration</strong>
                  <span>{trustworthy
                    ? "locked, sector readings trusted within ±60°."
                    : "Pro-only enhancement. Anomalies still fire without it; they're just tagged with no direction. Switch to Pro in the header to expose it."}
                  </span>
                </span>
              </li>
              <li className={s.readinessRow}>
                <span className={`${s.readinessTick} ${baselineFresh ? s.tickOk : s.tickWarn}`.trim()} aria-hidden="true">
                  {baselineFresh ? "✓" : "⚠"}
                </span>
                <span className={s.readinessRowBody}>
                  <strong>Site baseline</strong>
                  <span>{baseline == null
                    ? "not captured. The card above runs a 90s noise-floor capture so anomalies have a reference point."
                    : baselineStale
                      ? `captured ${baselineAgeLabel}. Older than 12h — different conditions likely. Re-capture for trustworthy weighting.`
                      : `captured ${baselineAgeLabel}. RMS p95 ${baseline.audioRmsP95.toFixed(3)}, EMF p95 ${baseline.emfP95.toFixed(1)} μT.`}
                  </span>
                </span>
              </li>
            </ul>
          </div>
        );
      })()}

      {/* PRIMARY CALL TO ACTION */}
      <div className={s.controls}>
        {!running ? (
          <button type="button" className={`btn btn-primary ${s.heroSize}`} onClick={onBegin} disabled={busy}>
            {busy ? "Starting…" : hasInvestigation ? "Begin session" : "Begin a new session"}
          </button>
        ) : (
          <button type="button" className={`btn btn-danger ${s.heroSize}`} onClick={onStop} disabled={busy}>
            End session
          </button>
        )}
      </div>

      {/* BROADCAST CTA — headline feature: camera + sensor overlays composited live */}
      <button
        type="button"
        className={`${s.broadcast} ${broadcasting ? s.broadcastOnAir : recordingClip ? s.broadcastRec : ""}`.trim()}
        onClick={onBroadcastLive}
        aria-label={
          broadcasting
            ? recordingClip ? "On air and recording — open broadcast controls" : "On air — open broadcast controls"
            : recordingClip ? "Recording clip — open broadcast controls" : "Broadcast live with sensor overlays"
        }
      >
        <span className={s.broadcastDot} aria-hidden="true" />
        <span>
          {broadcasting && recordingClip ? "On air · recording — tap for controls"
            : broadcasting ? "On air — tap for controls"
            : recordingClip ? "Recording clip — tap for controls"
            : "Broadcast live with sensor overlays"}
        </span>
        <span className={s.broadcastHint}>
          {broadcasting && recordingClip ? "REC · LIVE"
            : broadcasting ? "LIVE"
            : recordingClip ? "REC"
            : "TV-grade timestamps"}
        </span>
      </button>

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
        <Link to="/research" className={s.quick}>
          <span className={s.quickIcon} aria-hidden="true">🗂️</span>
          <span className={s.quickLabel}>Research venue</span>
          <span className={s.quickHint}>AI archive deep-dive · cited</span>
        </Link>
      </div>

      {/* EVENT FEED */}
      <div className={s.feed} aria-label="What's been happening">
        <header className={s.feedHead}>
          <span className={s.feedEyebrow}>WHAT'S BEEN HAPPENING</span>
          <span className={s.feedNote}>Newest at the top</span>
        </header>
        {feedItems.length === 0 ? (
          <p className={s.feedEmpty}>
            {running && elapsedSeconds > 90
              ? <><strong>Heard or saw something interesting?</strong> Tap <em>Mark this moment</em> above — markers are yours; the dial only catches what the sensors flag. Anything you tag becomes part of the audit chain.</>
              : running
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
