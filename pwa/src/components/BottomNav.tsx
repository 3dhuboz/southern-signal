import { NavLink } from "react-router-dom";
import styles from "./BottomNav.module.css";

type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
};

const items: NavItem[] = [
  {
    to: "/",
    label: "Mission",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="9" width="2" height="6" rx="1" fill="currentColor" />
        <rect x="9" y="5" width="2" height="14" rx="1" fill="currentColor" />
        <rect x="14" y="7" width="2" height="10" rx="1" fill="currentColor" />
        <rect x="19" y="3" width="2" height="18" rx="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    to: "/review",
    label: "Review",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/setup",
    label: "Setup",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        <line x1="12" y1="2" x2="12" y2="4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <line x1="12" y1="20" x2="12" y2="22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <line x1="2" y1="12" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <line x1="20" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/floorplan",
    label: "Floorplan",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3 12h6M9 12v9M9 12h6M15 12V3M15 12h6" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="17" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
];

export function BottomNav() {
  return (
    <nav className={styles.nav} aria-label="Primary">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => (isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab)}
        >
          <span className={styles.icon} aria-hidden="true">{item.icon}</span>
          <span className={styles.label}>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
