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
 * Update cadence: a single window.setInterval at 1 Hz drives the wall-clock
 * lines via local state — that's the only periodic render this component
 * causes. Elapsed seconds come from the parent so the source of truth stays
 * in CameraScreen's existing session timer.
 *
 * Glass shell + tabular-nums match the BroadcastBug / AudioMeter so the
 * three pieces of corner chrome read as one composed broadcast system.
 */
import { useEffect, useState } from "react";
import s from "./BroadcastTimestamp.module.css";

interface Props {
  /** True while a hunt session is active. Drives the elapsed timecode and
   *  changes the slate's contextual styling (a hair brighter when live). */
  running: boolean;
  /** Session-elapsed seconds. Parent owns the timer (CameraScreen already
   *  ticks this at 1 Hz). */
  elapsedSec: number;
}

/** Format a Date as HH:MM:SS in a given timezone. We use Intl.DateTimeFormat
 *  with `hour12: false` so the wall-clock matches the convention production
 *  editors expect on a slate. UTC is forced by passing `timeZone: "UTC"`. */
function fmtClock(d: Date, utc: boolean): string {
  // toLocaleTimeString without options also works on modern engines but
  // we want explicit hour12=false because some platforms default to 12 h.
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: utc ? "UTC" : undefined,
  });
}

/** Format the elapsed counter. Matches CameraScreen.fmtSecs format
 *  (mm:ss) so the timecode reads consistently next to the BroadcastBug. */
function fmtElapsed(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function BroadcastTimestamp({ running, elapsedSec }: Props) {
  // Wall-clock state. Re-rendered once per second. Initialised eagerly so
  // the first paint already has the current time (no "00:00:00" flash).
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    // Align the first tick to the next whole-second boundary so the
    // blinking colon stays in sync with the actual clock — otherwise the
    // colon flickers at an arbitrary phase offset and looks janky.
    const align = 1000 - (Date.now() % 1000);
    let interval: number | null = null;
    const start = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 1000);
    }, align);
    return () => {
      window.clearTimeout(start);
      if (interval != null) window.clearInterval(interval);
    };
  }, []);

  const local = fmtClock(now, false);
  const utc = fmtClock(now, true);
  // Insert blinking colons. We swap the visible colon for a CSS-hidden span
  // on even seconds so the cadence is exactly 1 Hz and matches the wall.
  // The DOM stays stable — only the .blink class toggles — so a screen
  // reader sees the same text across ticks.
  const blinkOn = now.getSeconds() % 2 === 0;

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
      <span className={s.elapsed}>
        <span className={s.eyebrow}>T</span>
        <span className={s.digits}>
          {running ? `+${fmtElapsed(elapsedSec)}` : "—:——"}
        </span>
      </span>
    </div>
  );
}
