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
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.wordmark}>SOUTHERN SIGNAL</span>
        </div>
        <button className={styles.modePill} type="button" aria-label="Investigation mode">
          <span className={styles.modeDot} aria-hidden="true" />
          <span>STANDALONE</span>
        </button>
      </div>
    </header>
  );
}
