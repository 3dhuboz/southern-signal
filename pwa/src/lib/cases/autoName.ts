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

/**
 * True when a string matches the auto-generated session-title pattern
 * (`Session — Sat 11 May, 23:10`). The AI Investigator should treat
 * auto-session titles as effectively empty — they're a timestamp, not a
 * venue, and searching the archives for a timestamp returns nothing.
 *
 * Liberal pattern: matches any leading "Session" + dash variant so
 * locales using en-dash or hyphen don't slip through.
 */
export function isAutoSessionTitle(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\s*Session\s*[—\-–]\s*/i.test(s);
}
