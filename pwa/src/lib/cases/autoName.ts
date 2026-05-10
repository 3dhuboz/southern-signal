/**
 * autoName — produce a sensible default title for a new investigation.
 *
 * The goal: zero-friction case creation. Operator taps Begin, gets a
 * reasonable, edit-in-place title pre-filled, and can keep moving.
 *
 * Format: `Session — Sat 11 May, 23:10`
 *  - Locale-aware date label (weekday + day + month, short)
 *  - 24-hour clock for the time (no AM/PM noise on a field rig)
 *
 * Uses Intl.DateTimeFormat so the locale follows the device. The em-dash
 * keeps the prefix readable; the comma separates date from time.
 */

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function autoName(now: Date = new Date()): string {
  return `Session — ${DATE_FMT.format(now)}, ${TIME_FMT.format(now)}`;
}
