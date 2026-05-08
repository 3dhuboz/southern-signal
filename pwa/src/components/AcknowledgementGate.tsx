/**
 * Acknowledgement of Country gate — first-launch ethical floor.
 *
 * Roadmap Tier 1 #2 + cultural-protocols panel #1: every Australian-
 * deployed paranormal investigation begins by acknowledging the
 * traditional custodians of the Country it stands on. The acknowledgement
 * is captured into preferences and logged to the audit chain; it appears
 * on every exported case report.
 *
 * V1 limitation: AIATSIS Map of Indigenous Australia data is not yet
 * bundled (licensing review pending — flagged in v1_architecture.md).
 * Until it is, the user types or pastes the relevant Nation/language
 * group themselves with a clear "confirm with the relevant Land Council"
 * footnote. Honest fallback, not theatre.
 */

import { useEffect, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { setPreferences, usePreferences } from "../lib/preferences";
import s from "./AcknowledgementGate.module.css";

const DEFAULT_TEMPLATE = (nation: string) => (
  `We acknowledge the ${nation || "Traditional Owners"} as the Traditional Custodians of the Country we are about to investigate. ` +
  `We pay our respects to Elders past and present, and acknowledge that sovereignty was never ceded.`
);

export function AcknowledgementGate() {
  const [prefs] = usePreferences();
  const [open, setOpen] = useState(false);
  const [nation, setNation] = useState("");
  const [statement, setStatement] = useState("");

  useEffect(() => {
    if (!prefs.acknowledgementOfCountry.accepted) setOpen(true);
  }, [prefs.acknowledgementOfCountry.accepted]);

  useEffect(() => {
    setStatement(DEFAULT_TEMPLATE(nation));
  }, [nation]);

  const accept = async () => {
    const trimmed = statement.trim();
    if (!trimmed) return;
    const ts = new Date().toISOString();
    setPreferences({
      acknowledgementOfCountry: {
        accepted: true,
        acceptedAt: ts,
        statement: trimmed,
      },
    });
    await appendAuditEntry({
      actor: "user",
      kind: "acknowledgement.country",
      payload: { statement: trimmed, nation: nation.trim() || null, ts },
    });
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="aoc-title">
      <div className={s.panel}>
        <h2 id="aoc-title" className={s.title}>Acknowledgement of Country</h2>
        <p className={s.lede}>
          Before you record on Country, acknowledge whose Country you are on. This line appears on every case report and is logged to the audit chain.
        </p>

        <label className={s.field}>
          <span className={s.fieldLabel}>Traditional custodians (e.g. Wurundjeri, Gadigal, Yuin)</span>
          <input
            className={s.input}
            type="text"
            value={nation}
            onChange={(e) => setNation(e.target.value)}
            placeholder="Nation or language group"
            autoComplete="off"
          />
          <span className={s.fieldHint}>
            Confirm with the relevant Land Council if you're unsure. Country lookup data is not yet bundled — this is the honest fallback.
          </span>
        </label>

        <label className={s.field}>
          <span className={s.fieldLabel}>Acknowledgement (you can edit)</span>
          <textarea
            className={s.textarea}
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            rows={5}
          />
        </label>

        <div className={s.actions}>
          <button type="button" className={s.primary} onClick={accept} disabled={!statement.trim()}>
            Acknowledge and continue
          </button>
        </div>

        <p className={s.footnote}>
          This is not a Welcome to Country — only Traditional Owners can deliver one. This is your acknowledgement.
        </p>
      </div>
    </div>
  );
}
