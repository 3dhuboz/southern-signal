/**
 * CameraSnoozeChip — visible indicator that the watchdog is silenced.
 *
 * Extracted from CameraHud.tsx as part of the 2026-05-22 camera overhaul.
 * Renders only when the parent's `snoozeUntil` deadline is in the future;
 * the parent owns the snooze-state machine and persists the deadline to
 * localStorage so the chip survives navigation.
 *
 * Tap to resume — the chip fires `onClearSnooze`, which clears the deadline
 * upstream and unmounts the chip. A worsening device-state degradation will
 * still fire toasts during a snooze (see CameraScreen's watchdog tick); the
 * chip is the operator's "I know it's silent" affordance.
 *
 * Tokens: --warn-pill-bg / --warn-pill-text + --chip-rim (Wave 1A).
 */
import s from "./CameraSnoozeChip.module.css";

export interface CameraSnoozeChipProps {
  /** ms-epoch deadline. Parent already gated on running + non-null. */
  snoozeUntil: number;
  /** Fires the un-snooze immediately. */
  onClearSnooze: () => void;
}

export function CameraSnoozeChip({ snoozeUntil, onClearSnooze }: CameraSnoozeChipProps) {
  const minutesLeft = Math.max(0, Math.ceil((snoozeUntil - Date.now()) / 60_000));
  return (
    <button
      type="button"
      className={s.snoozeChip}
      onClick={onClearSnooze}
      title="Watchdog toasts are silenced. Tap to resume immediately."
      aria-label="Watchdog snoozed — tap to resume"
    >
      <span className={s.snoozeChipIcon} aria-hidden="true">🔕</span>
      <span className={s.snoozeChipLabel}>
        Snoozed {minutesLeft}m
      </span>
    </button>
  );
}
