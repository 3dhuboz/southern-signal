/**
 * ProtocolSummaryChip — inline protocol status badge (Tier 2 #4).
 *
 * Three states:
 *  - No protocol written   → amber "NO PROTOCOL" chip
 *  - Draft, not yet locked → amber "DRAFT — not locked" chip
 *  - Locked                → green "PRE-REGISTERED" chip with first-8-char hash
 */

import type { InvestigationProtocol } from "../lib/db/schema";
import chipStyles from "./ProtocolSummaryChip.module.css";

export interface ProtocolSummaryChipProps {
  protocolJson: string | null;
  protocolHash: string | null;
}

export function ProtocolSummaryChip({ protocolJson, protocolHash }: ProtocolSummaryChipProps) {
  // Locked — green chip
  if (protocolHash) {
    return (
      <span
        className={chipStyles.chip + " " + chipStyles.chipLocked}
        title={`Protocol locked — SHA-256: ${protocolHash}`}
      >
        <span className={chipStyles.dot} aria-hidden="true" />
        PRE-REGISTERED · {protocolHash.slice(0, 8)}
      </span>
    );
  }

  // Draft written but not locked — amber chip
  if (protocolJson) {
    let label = "DRAFT — not locked";
    try {
      const p = JSON.parse(protocolJson) as InvestigationProtocol;
      if (p.hypothesis?.trim()) label = "DRAFT — not locked";
    } catch { /* ignore */ }
    return (
      <span
        className={chipStyles.chip + " " + chipStyles.chipDraft}
        title="Protocol written but not yet locked — lock it before starting the session"
      >
        ⚠ {label}
      </span>
    );
  }

  // Nothing written — amber warning chip
  return (
    <span
      className={chipStyles.chip + " " + chipStyles.chipNone}
      title="No pre-registered hypothesis. Write one before starting the session."
    >
      ⚠ NO PROTOCOL
    </span>
  );
}
