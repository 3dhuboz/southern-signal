import { ExperienceToggle } from "./ExperienceToggle";
import { ScotopicToggle } from "./ScotopicToggle";
import { useSystemStatus } from "../lib/system/systemStatus";
import styles from "./AppHeader.module.css";

const BATTERY_DANGER_PCT = 20;
const STORAGE_DANGER_FREE_MB = 500;

function formatStorageFree(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB free`;
  return `${Math.round(mb)} MB free`;
}

export function AppHeader() {
  const { batteryPct, charging, storageFreeMB, storageUsedPct } = useSystemStatus();

  const showBattery = batteryPct !== null;
  const batteryDanger = showBattery && batteryPct !== null && batteryPct < BATTERY_DANGER_PCT && !charging;

  const showStorage = storageFreeMB !== null;
  const storageDanger = showStorage && storageFreeMB !== null && storageFreeMB < STORAGE_DANGER_FREE_MB;

  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.wordmark}>SOUTHERN SIGNAL</span>
        </div>
        <div className={styles.toolbar}>
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
