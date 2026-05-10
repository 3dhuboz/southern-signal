/**
 * InterruptedSessionBanner — surfaces investigations that were `started_at`
 * but never `ended_at`, almost certainly because the operator refreshed
 * the tab mid-session.
 *
 * Now that persistence actually works (sqlite-wasm via Worker promiser →
 * OPFS), the dangling row is real — before the persistence fix the whole
 * DB was :memory: so the orphan vanished on refresh. Now it sticks
 * around, and without intervention the next session_start / session_stop
 * pair gets bookended onto a row that's already half-open. The base-rate
 * dashboard ends up counting one interrupted-and-resumed session as two,
 * the AHT verdict can't trust either window, and the audit chain has a
 * "started recording but never stopped" hole that any reviewer notices.
 *
 * Behaviour:
 *   - On mount, queries for the most-recent investigation with started_at
 *     IS NOT NULL AND ended_at IS NULL.
 *   - Renders an amber banner only when one is found.
 *   - "End & classify" calls stopInvestigation (sets ended_at = now) and
 *     navigates the operator to /review where the case row is at the top
 *     of the CaseManager and the disposition picker is one tap away.
 *   - "Later" dismisses for this page-load only — the row is still
 *     interrupted in the DB; the banner reappears next mount.
 *
 * The banner does not differentiate between "real interruption" and
 * "live session in another tab" — for V1 we treat both as "needs the
 * operator's attention," and the operator can dismiss with Later if it's
 * the live tab they're looking at.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { query } from "../lib/db/db";
import { stopInvestigation } from "../lib/db/repo";
import s from "./InterruptedSessionBanner.module.css";

interface InterruptedRow {
  id: string;
  title: string;
  started_at: string;
}

function relativeTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

export function InterruptedSessionBanner() {
  const [interrupted, setInterrupted] = useState<InterruptedRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await query<InterruptedRow>(
          `SELECT id, title, started_at FROM investigations
           WHERE started_at IS NOT NULL AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
        );
        if (!cancelled) setInterrupted(rows[0] ?? null);
      } catch {
        // Init may fail in private-mode browsers; persistence banner already
        // surfaces that. We swallow here so this banner doesn't throw at
        // mount on a degraded DB.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleEnd = useCallback(async () => {
    if (!interrupted) return;
    setBusy(true);
    setError(null);
    try {
      await stopInvestigation(interrupted.id);
      // Clear the local state and navigate so the operator lands on Review
      // with the just-ended case at the top of CaseManager. Disposition
      // buttons live in the case detail panel there.
      setInterrupted(null);
      navigate("/review");
    } catch (err) {
      setError((err as Error).message ?? "End failed.");
    } finally {
      setBusy(false);
    }
  }, [interrupted, navigate]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!interrupted || dismissed) return null;

  return (
    <div className={s.banner} role="status" aria-live="polite">
      <div className={s.body}>
        <strong className={s.title}>Unfinished session detected</strong>
        <p className={s.detail}>
          "<span className={s.caseTitle}>{interrupted.title}</span>" was started{" "}
          <span className={s.ago}>{relativeTimeAgo(interrupted.started_at)}</span>{" "}
          but never ended cleanly — likely a refresh or a tab close. End and classify
          it now so the audit chain has a clean session_stop and the base-rate dashboard
          counts it correctly.
        </p>
        {error && <p className={s.error}>{error}</p>}
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={`btn btn-warning-filled ${s.size}`}
          onClick={handleEnd}
          disabled={busy}
        >
          {busy ? "Ending…" : "End & classify"}
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${s.size}`}
          onClick={handleDismiss}
          disabled={busy}
        >
          Later
        </button>
      </div>
    </div>
  );
}
