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
    to: "/camera",
    label: "Camera",
    icon: (
      /* Viewfinder ring + record dot — unmistakably "camera-first" */
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        {/* Four L-corner brackets */}
        <path d="M4.5 8 L4.5 4.5 L8 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M19.5 8 L19.5 4.5 L16 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.5 16 L4.5 19.5 L8 19.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M19.5 16 L19.5 19.5 L16 19.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
    ),
  },
  // Investigate / MissionControl is now `/lab` — Pro-only, surfaced via a Setup
  // toggle. The default bottom nav stays focused on the broadcast-rig flow.
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
];

const researchItem: NavItem = {
  to: "/research",
  label: "Research",
  icon: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="14" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 6 L9 6 L11 4 L17 4 L17 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="18" cy="18" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <line x1="20" y1="20" x2="22" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
};

const communityItem: NavItem = {
  to: "/community",
  label: "Map",
  icon: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6 L9 4 L15 6 L20 4 L20 18 L15 20 L9 18 L4 20 Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 4 L9 18 M15 6 L15 20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="11" r="1.8" fill="currentColor" />
    </svg>
  ),
};

// Lab — Pro-only access to the full MissionControl review surface. Slotted
// after Setup so the streaming-first tabs (Camera/EVP/Review/Setup) stay in
// their familiar order; Lab is the back-office gateway before the wider-field
// entries (Research, Map).
const labItem: NavItem = {
  to: "/lab",
  label: "Lab",
  icon: (
    /* Erlenmeyer flask — narrow neck, sloped shoulders, fluid line. Clearly
       "lab equipment", visually distinct from Investigate's bar-chart icon. */
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3 H15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 3 L10 9 L4.5 19 A1.5 1.5 0 0 0 5.8 21 H18.2 A1.5 1.5 0 0 0 19.5 19 L14 9 L14 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M7 15 H17" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
    // session is a useRef — the ref object is stable, .current mutates without
    // needing to retrigger. The specific `session.current?.*` reads in deps
    // ARE intentional (we want re-fetch when session identity changes), but
    // the rule still flags the bare `session` reference as "missing".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchEnabled, session.current?.id, session.current?.title, session.current?.location_name]);

  const visibleItems = useMemo(() => {
    let out: NavItem[] = items;
    if (researchEnabled) {
      // Insert Research between Review and Setup — it's the next-step-after-look.
      const reviewIdx = items.findIndex((i) => i.to === "/review");
      if (reviewIdx < 0) {
        out = [...items, { ...researchItem, badgeCount: dossierBadge }];
      } else {
        out = [
          ...items.slice(0, reviewIdx + 1),
          { ...researchItem, badgeCount: dossierBadge },
          ...items.slice(reviewIdx + 1),
        ];
      }
    }
    if (prefs.proMode) {
      // Lab sits AFTER Setup but BEFORE Research/Community — it's the
      // back-office gateway to MissionControl, slotted ahead of the wider
      // -field entries. Setup is the last item in the base `items` array,
      // so append now (community is added below; research was inserted
      // before Setup, so it's already to the left).
      out = [...out, labItem];
    }
    if (prefs.community.enabled) {
      // Community sits at the right edge of the nav — the "look at the wider
      // field" entry. Floorplan was previously its anchor; appended at the
      // end now that Floorplan is gone.
      out = [...out, communityItem];
    }
    return out;
  }, [researchEnabled, dossierBadge, prefs.proMode, prefs.community.enabled]);

  return (
    <nav className={styles.nav} aria-label="Primary">
      {visibleItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/camera"}
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
