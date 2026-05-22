/**
 * CameraWatchdogToast — non-blocking mid-session degradation warning.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * Fires when the watchdog tick detects a worsening device state (battery
 * dropped, storage low, permission revoked). role="status" (implicit aria-
 * live="polite") so the AT picks it up without interrupting whatever it
 * was narrating — degraded device state is "should know", not "stop now".
 *
 * Three click affordances:
 *   - the body button (full width of the toast minus side actions) dismisses
 *   - Install CTA renders when storage is the failing check + the browser
 *     exposed a beforeinstallprompt. Standalone PWAs get OPFS persistence
 *     guarantees — the durable fix for "running out of room".
 *   - Snooze button silences toasts for WATCHDOG_SNOOZE_MS. A worsening
 *     degradation still fires (parent handles that gate).
 *
 * Wave 3 a11y: the body button got an aria-label so the AT announces
 * "Dismiss device warning" instead of dumping the whole degradation line
 * as a button name. focus-visible rings via the global :focus-visible from
 * styles/global.css cover all three buttons.
 *
 * Tokens: --chip-rim / --warn-pill-bg / --warn-pill-text / --dock-text /
 * --focus-ring (Wave 1A).
 */
import type { PreflightReport } from "../../lib/system/preflight";
import {
  formatWatchdogChecks,
  ordinal,
  watchdogStorageWarn,
} from "../../views/cameraScreen/watchdogFormat";
import { formatTimeToEmpty } from "../../lib/system/batteryProjection";
import s from "./CameraWatchdogToast.module.css";

export interface CameraWatchdogToastProps {
  report: PreflightReport;
  /** "2nd warning" superscript — shown when count > 1. */
  count: number;
  /** Estimated minutes until empty — surfaced under the battery check. */
  batteryProjectionMinutes: number | null;
  /** Estimated minutes until storage_free hits 0. */
  storageProjectionMinutes: number | null;
  /** True when the browser exposed a beforeinstallprompt — drives Install CTA. */
  installAvailable: boolean;
  /** Tap-to-dismiss handler. */
  onDismiss: () => void;
  /** Snooze 10m handler. */
  onSnooze: () => void;
  /** Fires the browser install prompt — only called when installAvailable. */
  onInstall: () => void | Promise<void>;
}

export function CameraWatchdogToast({
  report,
  count,
  batteryProjectionMinutes,
  storageProjectionMinutes,
  installAvailable,
  onDismiss,
  onSnooze,
  onInstall,
}: CameraWatchdogToastProps) {
  const blockSeverity = report.overall === "block";
  const showInstallCta = watchdogStorageWarn(report) && installAvailable;
  const batteryFailing = report.checks.some((c) => c.id === "battery" && c.level !== "ok");
  const storageFailing = report.checks.some((c) => c.id === "storage" && c.level !== "ok");

  return (
    // role="status" (implicit aria-live="polite") instead of "alert" so a
    // screen-reader user isn't interrupted mid-sentence by a toast that
    // auto-dismisses after WATCHDOG_TOAST_MS. The preflight blocker uses
    // role="alertdialog" for hard stops; degraded device state is "should
    // know", not "stop everything".
    <div
      className={`${s.watchdogToast} ${blockSeverity ? s.watchdogToastBlock : s.watchdogToastWarn}`.trim()}
      role="status"
    >
      <button
        type="button"
        className={s.watchdogToastBody}
        onClick={onDismiss}
        title="Tap to dismiss"
        aria-label="Dismiss device warning"
      >
        <span className={s.watchdogToastLabel}>
          {blockSeverity ? "Device state critical" : "Device state degraded"}
          {count > 1 && (
            <span className={s.watchdogToastCount}>{ordinal(count)} warning</span>
          )}
        </span>
        <span className={s.watchdogToastDetail}>
          {formatWatchdogChecks(report.checks) || "Tap to dismiss"}
          {batteryProjectionMinutes != null && batteryFailing && (
            <span className={s.watchdogToastEta}> · ~{formatTimeToEmpty(batteryProjectionMinutes)} until empty</span>
          )}
          {storageProjectionMinutes != null && storageFailing && (
            <span className={s.watchdogToastEta}> · ~{formatTimeToEmpty(storageProjectionMinutes)} until full</span>
          )}
        </span>
      </button>
      {showInstallCta && (
        <button
          type="button"
          className={s.watchdogToastCta}
          onClick={() => { void onInstall(); }}
        >
          Install
        </button>
      )}
      <button
        type="button"
        className={s.watchdogToastSnooze}
        onClick={onSnooze}
        title="Suppress watchdog toasts for the next 10 minutes. A worsening degradation will still fire."
      >
        Snooze 10m
      </button>
    </div>
  );
}
