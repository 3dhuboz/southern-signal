/**
 * BroadcastLowerThird — mid-bottom title slate, shown during an active
 * investigation.
 *
 * Two-line slate that slides in from below the camera frame when an
 * investigation is in progress, slides out when it ends. Lifted straight
 * from the documentary lower-third pattern an editor would burn into a
 * cold open: bold title on top, muted location + date on bottom.
 *
 * Animation: a CSS transition on `transform` + `opacity` driven by the
 * `running` prop — no JS animation, no React Spring. Mount is unconditional
 * so the exit animation has a frame to run on; visibility is controlled
 * by the .visible / .hidden modifiers. `aria-hidden` toggles in sync so
 * screen readers don't announce a stale slate after Stop.
 *
 * Glass shell matches the rest of the broadcast chrome. Width is content-
 * driven up to 80 vw so a long investigation title doesn't crowd the
 * sensor HUD or the shutter; long titles ellipsize.
 *
 * Reduced motion: the slide becomes an instant opacity toggle, in line
 * with prefers-reduced-motion across the rest of the broadcast chrome.
 */
import { useEffect, useState } from "react";
import s from "./BroadcastLowerThird.module.css";

interface Props {
  /** True when an investigation is active. False ends the slate (slide-out). */
  running: boolean;
  /** Investigation title — Investigation.title from the session store. */
  title: string | null | undefined;
  /** Location label. Investigation.location_name from the session store. */
  location?: string | null;
  /** ISO datetime of investigation start. We display as locale date (the
   *  burn-in is meant to be human-readable, not an audit timestamp). */
  startedAt?: string | null;
}

/** Format an ISO datetime as a short locale date — "Wed 7 May 2026" style.
 *  Used in the lower-third's muted subtitle. Falls back to today's date
 *  if the parsed value is invalid so the slate never shows an empty hyphen. */
function fmtDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const safe = Number.isFinite(d.getTime()) ? d : new Date();
  return safe.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function BroadcastLowerThird({ running, title, location, startedAt }: Props) {
  // Keep the title sticky after the running flag drops so the slide-out
  // animation has content to render against. Update only when running →
  // true OR when the title actually changes mid-session.
  const [sticky, setSticky] = useState<{ title: string; location: string | null; date: string } | null>(null);

  useEffect(() => {
    if (running && title) {
      setSticky({
        title,
        location: location ?? null,
        date: fmtDate(startedAt),
      });
    }
    // When `running` flips false we intentionally KEEP the previous sticky
    // so the slide-out has content. The mounted DOM with visible="false"
    // handles the exit. The next "running && title" run replaces it.
  }, [running, title, location, startedAt]);

  // If we've never had a running title (first paint, idle session), don't
  // render at all — keeps the camera frame chromeless until the operator
  // actually starts something.
  if (sticky == null) return null;

  return (
    <div
      className={`${s.slate} ${running ? s.visible : s.hidden}`.trim()}
      aria-hidden={!running}
      role="region"
      aria-label="Investigation slate"
    >
      {/* <h2> so screen readers can navigate to the investigation slate
          by heading. Visual styling is identical to the prior <div> —
          the .title rule resets default UA margins. */}
      <h2 className={s.title}>{sticky.title}</h2>
      <div className={s.subtitle}>
        {sticky.location && (
          <>
            <span className={s.location}>{sticky.location}</span>
            <span className={s.sep} aria-hidden="true">·</span>
          </>
        )}
        <span className={s.date}>{sticky.date}</span>
      </div>
    </div>
  );
}
