/**
 * BroadcastBug — top-left status bug for the camera surface.
 *
 * Replaces the bare STANDBY chip the camera shipped with. Models the on-air
 * bug a documentary OB van burns into a live feed: SS mark | state label |
 * elapsed timecode. Sized so the bug remains legible on a 480p downscale of
 * the broadcast frame — both the operator's screen and the recorded clip
 * pick this up.
 *
 * State priority (owned by the parent): rec > live > ready > idle. The
 * elapsed time is parent-supplied so the bug is presentation-only — that
 * keeps the source of truth in CameraScreen where the broadcast/session
 * timers already live.
 *
 * Sits at z-index 5 (above the video, below modals). All paint comes from
 * design tokens so the bug tracks the scotopic / daylight theme variants
 * without per-theme overrides here.
 */
import s from "./BroadcastBug.module.css";

export type BroadcastBugState = "idle" | "ready" | "live" | "rec";

interface Props {
  state: BroadcastBugState;
  /** Elapsed seconds — formatted as mm:ss. 0 for STANDBY. */
  elapsedSec: number;
}

/** mm:ss formatter (matches the original chip's format so the timecode
 *  reads identically post-redesign). */
function fmt(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** State → human label lookup. Kept inline so adding a state is one edit. */
const LABELS: Record<BroadcastBugState, string> = {
  idle: "STANDBY",
  ready: "READY",
  live: "LIVE",
  rec: "REC",
};

/** Signal-wave glyph that doubles as the SS broadcast mark. Hand-rolled
 *  SVG so we don't pull in an icon dependency for one symbol. */
function SignalGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      className={s.markGlyph}
      aria-hidden="true"
      focusable="false"
    >
      {/* Three concentric arcs + a centre dot — reads as "signal" or "wave"
          without committing to any specific channel iconography. */}
      <circle cx="3" cy="7" r="1.3" fill="currentColor" />
      <path
        d="M5.5 4.5 Q7.5 7 5.5 9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M8 3 Q11 7 8 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.7"
      />
    </svg>
  );
}

export function BroadcastBug({ state, elapsedSec }: Props) {
  const stateClass = state === "rec"
    ? s.rec
    : state === "live" ? s.live
    : state === "ready" ? s.ready
    : s.idle;
  return (
    <div
      className={`${s.bug} ${stateClass}`.trim()}
      data-hud-drag-target="status"
      role="status"
      aria-live="polite"
      aria-label={`Broadcast status: ${LABELS[state]}${state !== "idle" ? `, ${fmt(elapsedSec)} elapsed` : ""}`}
    >
      <span className={s.mark} aria-hidden="true">
        <SignalGlyph />
        <span className={s.markText}>SS</span>
      </span>
      <span className={s.body}>
        <span className={s.dot} aria-hidden="true" />
        <span className={s.label}>{LABELS[state]}</span>
        {state !== "idle" && <span className={s.elapsed}>{fmt(elapsedSec)}</span>}
      </span>
    </div>
  );
}
