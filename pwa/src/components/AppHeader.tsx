import { Link } from "react-router-dom";
import { ExperienceToggle } from "./ExperienceToggle";
import { ScotopicToggle } from "./ScotopicToggle";
import { useSystemStatus, useNetworkOnline } from "../lib/system/systemStatus";
import { useLiveBroadcastState } from "../lib/system/liveBroadcast";
import { usePreferences } from "../lib/preferences";
import { usePersistenceMode } from "../lib/db/db";
import styles from "./AppHeader.module.css";

const BATTERY_DANGER_PCT = 20;
const STORAGE_DANGER_FREE_MB = 500;
/**
 * Hard constraint #7 (iOS PWA OPFS quota warning at 80%): the storage
 * pill must turn red at 80% used, not just on absolute-free-MB. iPhone
 * OPFS realistically caps at ~1–4 GiB; relying on free-MB alone means
 * a 1.5 GiB iPhone hits the limit before the chip ever turns red.
 */
const STORAGE_DANGER_USED_PCT = 80;

function formatStorageFree(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB free`;
  return `${Math.round(mb)} MB free`;
}

export function AppHeader() {
  const { batteryPct, charging, storageFreeMB, storageUsedPct } = useSystemStatus();
  const live = useLiveBroadcastState();
  const [prefs] = usePreferences();
  const sensitiveGlobal = prefs.globalCulturalSensitivityFlag;
  const persistenceMode = usePersistenceMode();
  const memoryOnly = persistenceMode === "memory";

  const online = useNetworkOnline();

  const showBattery = batteryPct !== null;
  const batteryDanger = showBattery && batteryPct !== null && batteryPct < BATTERY_DANGER_PCT && !charging;

  const showStorage = storageFreeMB !== null;
  // Two-axis danger gate: either absolute-free OR pct-used trips the pill.
  // Constraint #7 demands the 80%-used threshold; STORAGE_DANGER_FREE_MB
  // is kept as a belt-and-braces lower bound for very large quotas where
  // 80% used still leaves a lot of headroom in absolute terms.
  const storageDanger =
    showStorage &&
    storageFreeMB !== null &&
    (storageFreeMB < STORAGE_DANGER_FREE_MB ||
      (storageUsedPct !== null && storageUsedPct >= STORAGE_DANGER_USED_PCT));

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <Link to="/about" className={styles.brand} aria-label="About Southern Signal">
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.wordmark}>SOUTHERN SIGNAL</span>
        </Link>
        <div className={styles.toolbar}>
          {!online && (
            <span
              className={styles.offlineBadge}
              role="status"
              aria-label="No internet connection"
              title="Offline — WHIP broadcast and cloud AI are unavailable. Recordings and evidence still capture locally."
            >
              <span className={styles.offlineDot} aria-hidden="true" />
              OFFLINE
            </span>
          )}
          {memoryOnly && (
            <span
              className={styles.memoryBadge}
              role="status"
              aria-label="Storage is in-memory only — data will not survive a page refresh"
              title="OPFS persistent storage is not available in this browser. Sessions, recordings, and case briefs will be lost on page refresh. Try a different browser (Chrome / Edge / Safari 17+) or check that you're not in private browsing."
            >
              <span className={styles.memoryBadgeDot} aria-hidden="true" />
              NO SAVE
            </span>
          )}
          {sensitiveGlobal && (
            <Link
              to="/setup"
              className={styles.sensitiveBadge}
              role="status"
              aria-label="Cultural-sensitivity protection on, device-wide. Cloud AI and sync are blocked."
              title="Cultural-sensitivity protection ON, device-wide. Cloud AI + sync are hard-blocked. Tap to manage."
            >
              <span className={styles.sensitiveBadgeDot} aria-hidden="true" />
              SENSITIVE
            </Link>
          )}
          {(live.recording || live.broadcasting) && (
            <span
              className={`${styles.liveBadge} ${live.broadcasting ? styles.liveBadgeOnAir : styles.liveBadgeRec}`.trim()}
              role="status"
              aria-label={
                live.broadcasting && live.recording ? "Recording and broadcasting"
                : live.broadcasting ? "Broadcasting"
                : "Recording"
              }
              title={
                live.broadcasting && live.recording ? "On air · recording — overlays visible to viewers"
                : live.broadcasting ? "On air — overlays visible to viewers"
                : "Recording locally — overlays baked into the clip"
              }
            >
              <span className={styles.liveBadgeDot} aria-hidden="true" />
              {live.broadcasting && live.recording ? "REC · LIVE"
                : live.broadcasting ? "LIVE"
                : "REC"}
            </span>
          )}
          {(showBattery || showStorage) && (
            <div className={styles.statusGroup}>
              {showBattery && (
                <span
                  className={`${styles.statusPill} ${batteryDanger ? styles.statusPillDanger : ""}`.trim()}
                  title={
                    charging
                      ? `Battery ${batteryPct}% — charging`
                      : `Battery ${batteryPct}%`
                  }
                  aria-label={`Battery ${batteryPct} percent${charging ? ", charging" : ""}`}
                >
                  <span className={styles.statusGlyph} aria-hidden="true">
                    {charging ? "BAT+" : "BAT"}
                  </span>
                  {batteryPct}%
                </span>
              )}
              {showStorage && (
                <span
                  className={`${styles.statusPill} ${storageDanger ? styles.statusPillDanger : ""}`.trim()}
                  title={
                    storageUsedPct !== null
                      ? `Storage ${storageUsedPct.toFixed(0)}% used`
                      : undefined
                  }
                  aria-label={`Storage ${formatStorageFree(storageFreeMB!)}`}
                >
                  <span className={styles.statusGlyph} aria-hidden="true">DSK</span>
                  {formatStorageFree(storageFreeMB!)}
                </span>
              )}
            </div>
          )}
          <ExperienceToggle />
          <ScotopicToggle />
        </div>
      </div>
    </header>
  );
}
