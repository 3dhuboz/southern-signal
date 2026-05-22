/**
 * CameraScreen module-scope constants.
 *
 * Hoisted out of CameraScreen.tsx so the 1600-line view file doesn't have to
 * re-declare these on every render. The constants split into three buckets:
 *
 *   - MARKER picker chip definitions (QUICK_TAGS, PICKER_CATEGORIES) — used by
 *     CameraMarkerPicker; kept here so CameraScreen still owns the canonical
 *     list when reviewers ask "what tags are first-class?".
 *   - Timing constants (the *_MS family) — read by the marker pipeline +
 *     watchdog tick. Module-scoped so the values can't accidentally diverge
 *     between the dropMarker handler and its setTimeout callback.
 *   - SNOOZE_STORAGE_KEY — the localStorage key the watchdog uses to persist
 *     the snooze deadline across navigations. Versioned ("-v1") so a future
 *     schema change can skip stale values without colliding with new ones.
 *
 * MARKER_BREAKDOWN ordering lives in CameraHud (see components/broadcast/
 * CameraHud.tsx). Keeping it there means the popover list and any future
 * sort-by-priority Review filter both reference the same source.
 */

/** localStorage key for the watchdog snooze deadline (ms epoch). Versioned
 *  so a future schema change can skip the legacy value cleanly. */
export const SNOOZE_STORAGE_KEY = "ss-watchdog-snooze-until-v1";

export type MarkerCat = "sound" | "movement" | "felt";

// Pre-canned quick-tag chips for the marker picker. Each lands a marker with
// category + note in one tap. Module-scoped so the array isn't reallocated
// per render — the picker is part of a long-lived HUD.
export const QUICK_TAGS: ReadonlyArray<{ label: string; category: MarkerCat }> = [
  { label: "Cold spot",    category: "felt" },
  { label: "Footstep",     category: "sound" },
  { label: "Voice",        category: "sound" },
  { label: "Object moved", category: "movement" },
  { label: "Touched",      category: "felt" },
];

// Long-form category picker chips — same set as MARKER_CATEGORIES upstream
// but module-scoped here so the picker JSX can map without re-declaring.
export const PICKER_CATEGORIES: ReadonlyArray<{ id: MarkerCat; label: string }> = [
  { id: "sound",    label: "Sound" },
  { id: "movement", label: "Movement" },
  { id: "felt",     label: "Felt" },
];

// Marker categories — three operator-affordable types for reviewers to
// filter by later in Review. Picker auto-commits as `null` (untagged) after
// MARKER_PICKER_MS so a fire-and-forget double-tap still lands a marker —
// categorisation is opt-in.
export type MarkerCategory = "sound" | "movement" | "felt" | null;

// Throttle: rapid-fire double-taps (operator excited, hands shaky, accidental
// double-double-tap) within MARKER_THROTTLE_MS of the last marker get swallowed.
export const MARKER_THROTTLE_MS = 600;

// Auto-commit window for the marker picker. A category tap before this races
// the timer; markerCommittedRef guards against double-commits.
export const MARKER_PICKER_MS = 2200;

// Watchdog cadence — re-runs preflight every WATCHDOG_INTERVAL_MS while
// running. Toast auto-dismisses after WATCHDOG_TOAST_MS. Snooze is a
// WATCHDOG_SNOOZE_MS quiet window the operator can opt into.
export const WATCHDOG_INTERVAL_MS = 60_000;
export const WATCHDOG_TOAST_MS = 7000;
export const WATCHDOG_SNOOZE_MS = 10 * 60_000;

// Battery / storage sampling buffer — the watchdog keeps a rolling window of
// device-state samples that feed projectTimeToEmpty / projectTimeToZero so the
// toast can show a "swap in N min" hint.
export const BATTERY_SAMPLE_BUFFER = 20;
export const STORAGE_SAMPLE_BUFFER = 20;
