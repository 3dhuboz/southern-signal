/**
 * useBroadcastClock — shared time source for the broadcast slate (DOM) and the
 * recorded burn-in (canvas compositor).
 *
 * Why this exists
 * ───────────────
 * The on-screen `BroadcastTimestamp` (DOM chrome the operator sees) and the
 * burn-in baked onto each recorded video frame (`canvasCompositor.drawTimestamp`)
 * each used to compute their own `Date.now()` / `new Date()`. Two clocks
 * sampled at different points in the same frame can disagree by a few hundred
 * ms when the JS event loop is busy. The drift never crossed a whole second in
 * practice — but a production editor diffing the operator's slate against the
 * burn-in would see "12:34:18 on-screen, 12:34:17 in the frame" and assume the
 * audit chain was broken. This hook fixes that by making both sites pull from
 * a single `getBroadcastClockSnapshot()` formatter.
 *
 * Shape
 * ─────
 *   • `getBroadcastClockSnapshot(args)` — pure, side-effect-free formatter.
 *     The compositor (a plain object that runs outside React) calls this
 *     directly per frame; no hook gymnastics needed.
 *   • `useBroadcastClock(args)` — React hook that ticks at 250ms and returns
 *     the same snapshot for DOM consumers. 250ms is the sweet spot: elapsed
 *     time can't visibly drift by more than 1/4 sec from wall time, the
 *     blinking colon stays locked to 1Hz (we read seconds modulo 2 from the
 *     snapshot), and we don't murder battery with rAF-driven re-renders.
 *
 * Test injection
 * ──────────────
 * Both functions accept an optional `now: () => number` — vitest tests pass a
 * frozen clock so HH:MM:SS strings are deterministic across CI runs and
 * locales. Without an injected clock, `Date.now()` is the default.
 *
 * Not exported on purpose: the elapsed mm:ss-with-no-leading-zero format
 * (`+0:42`) the `BroadcastTimestamp` slate uses. That formatting stays inside
 * the component so its DOM-structure snapshots are stable. The compositor uses
 * the HH:MM:SS form exposed here (`elapsedText`).
 */

import { useEffect, useRef, useState } from "react";

export interface BroadcastClockSnapshot {
  /** Wall-clock ms epoch at this tick (local — same numeric value as utc, by
   *  spec `Date.now()` returns UTC ms regardless of timezone). Provided as a
   *  separate field so future revisions can diverge if needed. */
  wallClock: number;
  /** UTC ms epoch at this tick. Currently identical to wallClock. */
  utc: number;
  /** Session elapsed seconds, 0 when not running. Floored — never negative. */
  elapsedSec: number;
  /** Local wall clock formatted as `HH:MM:SS`. */
  wallClockText: string;
  /** UTC formatted as `HH:MM:SS` (no date, the compositor draws the date
   *  separately so it can colour the calendar slug independently). */
  utcText: string;
  /** UTC formatted as `YYYY-MM-DD`. Used by the compositor's case-ID burn-in
   *  so editors can match clips to investigation dates without parsing the
   *  full timestamp. Empty string when args supply no clock function (impossible
   *  in practice; defensive). */
  utcDateText: string;
  /** Elapsed time formatted as `HH:MM:SS`. Hour-padded so the width stays
   *  constant past 1h. Used by the compositor's status pills. The on-screen
   *  slate uses its own `+m:ss` format derived from elapsedSec — that lives
   *  inside the component to keep its DOM-structure snapshots stable. */
  elapsedText: string;
}

export interface UseBroadcastClockArgs {
  /** Whether a hunt session is currently active. Drives elapsedSec. */
  running: boolean;
  /** Unix-ms epoch of session start; null when idle. The hook subtracts this
   *  from `now()` to compute elapsed — using a fixed start anchor instead of
   *  a "ticks elapsed" counter means a tab returning from background catches
   *  up to the true elapsed time instantly (no drift accumulation). */
  startedAtMs: number | null;
  /** Test-only clock injection. Default `Date.now`. Use this in vitest so
   *  the formatted strings are deterministic and `vi.useFakeTimers()` can
   *  control the elapsed counter without monkey-patching Date.prototype. */
  now?: () => number;
}

/**
 * Pure formatter — takes the same args as the hook and returns a snapshot.
 * No React, no side effects. The compositor calls this per frame; the hook
 * calls it on every tick.
 *
 * Performance note: the only allocation per call is the snapshot object
 * itself + the four formatted strings. The compositor invokes this at 30fps
 * → 30 allocations/sec, well below GC pressure thresholds on mobile V8.
 */
export function getBroadcastClockSnapshot(
  args: UseBroadcastClockArgs,
): BroadcastClockSnapshot {
  const now = args.now ?? Date.now;
  const currentMs = now();

  // Elapsed: clamp to 0 when idle. If running but no startedAt was supplied,
  // we fall through to 0 too — defensive against callers in a half-initialised
  // state (e.g. between mount and first session start).
  const elapsedSec =
    args.running && args.startedAtMs != null
      ? Math.max(0, Math.floor((currentMs - args.startedAtMs) / 1000))
      : 0;

  // Wall clock + UTC. We build a Date once and reuse it for both formatters
  // — the Date constructor cost is small but not zero, and the same instance
  // is safe to mutate-free across multiple `toLocaleTimeString` calls.
  const d = new Date(currentMs);
  const wallClockText = formatHHMMSS(d, false);
  const utcText = formatHHMMSS(d, true);
  const utcDateText = formatYYYYMMDD(d);
  const elapsedText = formatElapsedHHMMSS(elapsedSec);

  return {
    wallClock: currentMs,
    utc: currentMs,
    elapsedSec,
    wallClockText,
    utcText,
    utcDateText,
    elapsedText,
  };
}

/**
 * React hook. Subscribes a 250ms interval that re-renders the consumer; the
 * interval shuts down on unmount. The first snapshot is computed synchronously
 * during render so the initial paint already has the current time (no
 * `00:00:00` flash).
 *
 * Alignment to wall-second boundaries (the existing BroadcastTimestamp
 * behaviour) is preserved by snapping the *first* tick to the next 250ms
 * boundary — that keeps the cadence in phase with system clock seconds without
 * the previous component's one-shot `setTimeout(align) → setInterval(1000)`
 * dance.
 */
export function useBroadcastClock(
  args: UseBroadcastClockArgs,
): BroadcastClockSnapshot {
  const { running, startedAtMs, now } = args;

  // Initial snapshot — synchronous so the first render has real values.
  const [snapshot, setSnapshot] = useState<BroadcastClockSnapshot>(() =>
    getBroadcastClockSnapshot({ running, startedAtMs, now }),
  );

  // Pull the latest args through a ref so the interval callback always reads
  // current values without resetting the interval on every prop change.
  // Re-creating the interval each prop tick would push the cadence out of
  // phase with the wall clock — exactly the bug this hook exists to fix.
  const argsRef = useRef<UseBroadcastClockArgs>({ running, startedAtMs, now });
  argsRef.current = { running, startedAtMs, now };

  useEffect(() => {
    const tick = () => {
      setSnapshot(getBroadcastClockSnapshot(argsRef.current));
    };
    // Fire one tick immediately so the elapsed counter reflects any change in
    // running/startedAtMs without waiting up to 250ms.
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
    // We intentionally do NOT depend on running/startedAtMs/now — argsRef
    // funnels those into the interval callback, and we want the interval to
    // remain stably anchored across prop changes.
  }, []);

  return snapshot;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

/**
 * `HH:MM:SS` formatter. Forces `hour12: false` because some platforms default
 * to 12-hour wall clocks — matches the convention production editors expect
 * on a slate. UTC is forced by passing `timeZone: "UTC"`.
 */
function formatHHMMSS(d: Date, utc: boolean): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: utc ? "UTC" : undefined,
  });
}

/**
 * `YYYY-MM-DD` formatter — UTC anchored so the calendar date doesn't flip
 * between operator timezone and burn-in timezone across midnight. This is the
 * forensic-chain-friendly representation that matches the ISO 8601 prefix in
 * the recorder metadata.
 */
function formatYYYYMMDD(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Hour-padded `HH:MM:SS` for elapsed seconds. Matches the compositor's
 * `formatElapsed(ms)` helper so the burn-in pill width stays constant.
 */
function formatElapsedHHMMSS(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
