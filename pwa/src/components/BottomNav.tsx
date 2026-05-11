import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { query } from "../lib/db/db";
import { usePreferences } from "../lib/preferences";
import { useSession } from "../lib/session";
import styles from "./BottomNav.module.css";

type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
  /** Optional small count badge — shown when > 0 on the icon. */
  badgeCount?: number;
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
    to: "/evp",
    label: "EVP",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 12 H5 L7 6 L11 18 L15 4 L17 14 L19 12 H21" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
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

const researchItem: NavItem = {
  to: "/research",
  label: "Research",
  icon: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="14" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 6 L9 6 L11 4 L17 4 L17 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="18" cy="18" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="20" y1="20" x2="22" y2="22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
};

export function BottomNav() {
  const [prefs] = usePreferences();
  const session = useSession();
  const researchEnabled = prefs.research.enabled;
  const [dossierBadge, setDossierBadge] = useState(0);

  // Count dossiers that would show up on /research for the operator's
  // current context: this case's dossiers + standalone recon for this
  // venue. Same rule the Research view + Evidence Brief use. The
  // count only drives the badge — clicking still goes to /research.
  useEffect(() => {
    if (!researchEnabled) { setDossierBadge(0); return; }
    let cancelled = false;
    const inv = session.current;
    void (async () => {
      try {
        let rows: { total: number }[];
        if (inv) {
          rows = await query<{ total: number }>(
            `SELECT COUNT(*) AS total FROM research_dossiers
             WHERE investigation_id = ?
                OR (investigation_id IS NULL
                    AND (LOWER(venue_name) = LOWER(?) OR LOWER(venue_name) = LOWER(?)))`,
            [inv.id, inv.title ?? "", inv.location_name ?? ""],
          );
        } else {
          rows = await query<{ total: number }>(
            "SELECT COUNT(*) AS total FROM research_dossiers WHERE investigation_id IS NULL",
          );
        }
        if (!cancelled) setDossierBadge(rows[0]?.total ?? 0);
      } catch {
        // Pre-v4 schemas don't have the table — silently no badge.
        if (!cancelled) setDossierBadge(0);
      }
    })();
    return () => { cancelled = true; };
  }, [researchEnabled, session.current?.id, session.current?.title, session.current?.location_name]);

  const visibleItems = useMemo(() => {
    if (!researchEnabled) return items;
    // Insert Research between Review and Setup — it's the next-step-after-look.
    const reviewIdx = items.findIndex((i) => i.to === "/review");
    if (reviewIdx < 0) return [...items, { ...researchItem, badgeCount: dossierBadge }];
    return [
      ...items.slice(0, reviewIdx + 1),
      { ...researchItem, badgeCount: dossierBadge },
      ...items.slice(reviewIdx + 1),
    ];
  }, [researchEnabled, dossierBadge]);

  return (
    <nav className={styles.nav} aria-label="Primary">
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => (isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab)}
        >
          <span className={styles.icon} aria-hidden="true">
            {item.icon}
            {item.badgeCount != null && item.badgeCount > 0 && (
              <span className={styles.badge} aria-label={`${item.badgeCount} dossiers`}>
                {item.badgeCount > 9 ? "9+" : item.badgeCount}
              </span>
            )}
          </span>
          <span className={styles.label}>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
