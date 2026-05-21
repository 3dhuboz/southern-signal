/**
 * BroadcastTimestamp — bottom-left timecode slate for the camera surface.
 *
 * Three lines of monospace clock data the operator (or a video editor
 * working from the recorded clip) can burn into a documentary:
 *   1. Local wall-clock HH:MM:SS — large, blinking colon at 1 Hz.
 *   2. UTC HH:MM:SS — small + muted, removes timezone ambiguity for
 *      cross-team review.
 *   3. Session elapsed T+m:ss — only meaningful when the session is
 *      running; otherwise shows the dim placeholder T—:—— so the slot
 *      stays the same height (no layout shift on Begin).
 *
 * Clock source: the wall-clock + UTC text come from `useBroadcastClock`,
 * the same hook the canvas compositor's `getBroadcastClockSnapshot()`
 * formatter pulls from. That guarantees the on-screen slate and the
 * burned-in timestamp on each recorded frame can't disagree — they share
 * one moment of `Date.now()` per tick.
 *
 * Update cadence: the hook ticks at 250ms. The component re-renders only
 * when the snapshot changes; the elapsed slot uses its own `fmtElapsed`
 * (`+m:ss` without leading zero on minutes) so the existing DOM-structure
 * snapshot tests stay valid — the hook exposes `elapsedText` as HH:MM:SS
 * for the compositor's burn-in, but the operator chrome here prefers the
 * shorter humane form. Elapsed seconds still come from the parent so the
 * source of truth stays in CameraScreen's existing session timer.
 *
 * Glass shell + tabular-nums match the BroadcastBug / AudioMeter so the
 * three pieces of corner chrome read as one composed broadcast system.
 */
import s from "./BroadcastTimestamp.module.css";
import { useBroadcastClock } from "../../hooks/useBroadcastClock";

interface Props {
  /** True while a hunt session is active. Drives the elapsed timecode and
   *  changes the slate's contextual styling (a hair brighter when live). */
  running: boolean;
  /** Session-elapsed seconds. Parent owns the timer (CameraScreen already
   *  ticks this at 1 Hz). */
  elapsedSec: number;
}

/** Format the elapsed counter. Matches CameraScreen.fmtSecs format
 *  (mm:ss) so the timecode reads consistently next to the BroadcastBug.
 *  Lives in the component (not the hook) to keep its DOM-structure
 *  snapshots stable across the shared-clock refactor — the hook exposes
 *  the hour-padded `HH:MM:SS` form for the compositor's pills. */
function fmtElapsed(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function BroadcastTimestamp({ running, elapsedSec }: Props) {
  // Derive the session start anchor from the parent-owned elapsedSec. We
  // recompute it on each render — that's fine: the hook's elapsedSec output
  // is itself derived from `now() - startedAtMs`, so as long as the parent's
  // elapsedSec advances roughly with wall time the two stay in step. The
  // operator's source of truth is still CameraScreen's session timer; the
  // hook just exposes a shared *formatter* for wall + UTC text.
  const startedAtMs = running ? Date.now() - elapsedSec * 1000 : null;
  const snapshot = useBroadcastClock({ running, startedAtMs });

  const local = snapshot.wallClockText;
  const utc = snapshot.utcText;
  // Insert blinking colons. We swap the visible colon for a CSS-hidden span
  // on even seconds so the cadence is exactly 1 Hz and matches the wall.
  // The DOM stays stable — only the .blink class toggles — so a screen
  // reader sees the same text across ticks.
  // Read seconds from the snapshot's numeric wallClock so the blink stays in
  // phase with the same Date.now() value the burn-in uses.
  const blinkOn = Math.floor(snapshot.wallClock / 1000) % 2 === 0;

  return (
    <div
      className={`${s.slate} ${running ? s.running : ""}`.trim()}
      role="timer"
      aria-label={`Timecode ${local} local`}
      aria-live="off"
    >
      <span className={`${s.local} ${blinkOn ? s.blinkOn : s.blinkOff}`.trim()}>
        {/* Split the HH:MM:SS string on its colons so we can class each
            colon separately and animate the blink without touching the
            digits. Robust across locales because we forced hour12=false. */}
        {local.split(":").map((part, i, arr) => (
          <span key={i} className={s.digits}>
            {part}
            {i < arr.length - 1 && <span className={s.colon}>:</span>}
          </span>
        ))}
      </span>
      <span className={s.utc}>
        <span className={s.eyebrow}>UTC</span>
        <span className={s.digits}>{utc}</span>
      </span>
      <span
        className={s.elapsed}
        aria-label={running
          ? `Session elapsed: ${Math.max(0, Math.floor(elapsedSec))} seconds`
          : "Session not running"}
      >
        <span className={s.eyebrow} aria-hidden="true">T</span>
        <span className={s.digits} aria-hidden="true">
          {running ? `+${fmtElapsed(elapsedSec)}` : "—:——"}
        </span>
      </span>
    </div>
  );
}
