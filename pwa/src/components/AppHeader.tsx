import { ExperienceToggle } from "./ExperienceToggle";
import { ScotopicToggle } from "./ScotopicToggle";
import styles from "./AppHeader.module.css";

export function AppHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <div className={styles.brand}>
          <img
            className={styles.partnerLogo}
            src="/yep-boys-logo.svg"
            alt="YEP The Boys"
            width={28}
            height={28}
          />
          <span className={styles.partnerDivider} aria-hidden="true" />
          <span className={styles.wordmark}>SOUTHERN SIGNAL</span>
        </div>
        <div className={styles.toolbar}>
          <ExperienceToggle />
          <ScotopicToggle />
        </div>
      </div>
    </header>
  );
}
