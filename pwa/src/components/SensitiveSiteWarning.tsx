/**
 * SensitiveSiteWarning — typed-acknowledgement prompt shown when the device
 * is within 5 km of a documented Colonial Frontier Massacre site.
 *
 * The user must type "I acknowledge" (case-insensitive) before the
 * investigation creation submit button is enabled. Dismissal without
 * acknowledgement closes the form entirely.
 *
 * This is the first-cut warning-only implementation (Tier 2 #3). The
 * Tier 3 upgrade adds TO consent PDF and hard-stop logic.
 *
 * Attribution note is always visible so operators know the source of the data.
 */

import { useState } from "react";
import type { SiteMatch } from "../lib/sensors/sensitiveSiteClassifier";
import s from "./SensitiveSiteWarning.module.css";

interface Props {
  matches: SiteMatch[];
  onAcknowledge: () => void;
  onCancel: () => void;
}

const CONFIRM_PHRASE = "i acknowledge";

export function SensitiveSiteWarning({ matches, onAcknowledge, onCancel }: Props) {
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim().toLowerCase() === CONFIRM_PHRASE;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="ssw-title">
      <div className={s.card}>
        {/* Header */}
        <div className={s.header}>
          <span className={s.icon} aria-hidden="true">⚠</span>
          <h2 id="ssw-title" className={s.title}>Sensitive site nearby</h2>
        </div>

        {/* Lead */}
        <p className={s.lead}>
          This investigation location is within 5 km of{" "}
          {matches.length === 1
            ? "a documented Colonial Frontier Massacre site."
            : `${matches.length} documented Colonial Frontier Massacre sites.`}
        </p>

        {/* Site list */}
        <ul className={s.siteList} aria-label="Nearby massacre sites">
          {matches.map(({ site, distanceKm }) => (
            <li key={site.id} className={s.siteRow}>
              <span className={s.siteName}>{site.name}</span>
              <span className={s.siteMeta}>
                {site.state}
                {site.year ? ` · ${site.year}` : ""}
                {" · "}
                {distanceKm < 1
                  ? `${Math.round(distanceKm * 1000)} m`
                  : `${distanceKm.toFixed(1)} km`}
              </span>
            </li>
          ))}
        </ul>

        {/* Guidance */}
        <p className={s.guidance}>
          Please consider whether this investigation is appropriate for this location.
          If you proceed, ensure your work respects the cultural significance of the
          site and any communities connected to it.
        </p>

        {/* Attribution */}
        <p className={s.attribution}>
          Data: Ryan et al. (2017–2024) — Colonial Frontier Massacres in Australia.
          University of Newcastle / ARC Discovery Project.
        </p>

        {/* Typed acknowledgement */}
        <label className={s.ackLabel} htmlFor="ssw-ack">
          Type <strong>I acknowledge</strong> to continue
        </label>
        <input
          id="ssw-ack"
          type="text"
          className={s.ackInput}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="ssw-ack-hint"
        />
        {typed.length > 0 && !confirmed && (
          <p id="ssw-ack-hint" className={s.ackHint} aria-live="polite">
            Type exactly: I acknowledge
          </p>
        )}

        {/* Actions */}
        <div className={s.actions}>
          <button
            type="button"
            className={s.cancelBtn}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={s.confirmBtn}
            disabled={!confirmed}
            onClick={onAcknowledge}
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
