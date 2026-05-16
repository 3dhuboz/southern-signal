/**
 * ICIP-Aware Restriction Levels and Local Contexts TK Label mapping.
 *
 * Indigenous Cultural and Intellectual Property (ICIP) attaches to media
 * recorded at a site that carries cultural, ceremonial, or sacred significance
 * — including audio, images, and written observations. Traditional Owners and
 * Knowledge Holders retain these rights regardless of who holds the recording
 * device.
 *
 * This module maps the five restriction levels defined in `schema.ts` to the
 * appropriate Local Contexts Traditional Knowledge (TK) Labels. TK Labels are
 * a rights-and-relationships system co-developed with Indigenous communities
 * worldwide; see:
 *   https://localcontexts.org/labels/traditional-knowledge-labels/
 *
 * V1 posture: on export, restricted content is redacted (binary omitted) and
 * replaced with a notice + TK label citation. Full AES-GCM at-rest encryption
 * is planned for V2; the DB column and type system are already designed for it.
 */

import type { RestrictionLevel } from "../db/schema";

// ── TK Label catalogue ────────────────────────────────────────────────────────

/** A single Local Contexts TK Label. */
export interface TkLabel {
  /** Canonical label identifier from localcontexts.org. */
  id: string;
  /** Display name. */
  name: string;
  /** One-sentence description for export notices. */
  description: string;
  /** Canonical URL to the full label text. */
  url: string;
}

/** All TK labels Southern Signal currently applies, keyed for type safety. */
export const TK_LABELS = {
  notice: {
    id: "TK-Notice",
    name: "TK Notice",
    description:
      "This item is associated with Traditional Knowledge that may be subject to specific cultural protocols.",
    url: "https://localcontexts.org/label/tk-notice/",
  },
  men_general: {
    id: "TK-Men-General",
    name: "TK Men General",
    description:
      "This item contains information or recordings that, under custodianship protocols, should be accessible to men only.",
    url: "https://localcontexts.org/label/tk-men-general/",
  },
  women_general: {
    id: "TK-Women-General",
    name: "TK Women General",
    description:
      "This item contains information or recordings that, under custodianship protocols, should be accessible to women only.",
    url: "https://localcontexts.org/label/tk-women-general/",
  },
  secret_sacred: {
    id: "TK-Secret-Sacred",
    name: "TK Secret/Sacred",
    description:
      "This item contains secret or sacred knowledge with strict access restrictions set by Traditional Owners.",
    url: "https://localcontexts.org/label/tk-secret-sacred/",
  },
  non_commercial: {
    id: "TK-Non-Commercial",
    name: "TK Non-Commercial",
    description:
      "This item may only be used for non-commercial purposes without explicit consent from Traditional Owners.",
    url: "https://localcontexts.org/label/tk-non-commercial/",
  },
} as const satisfies Record<string, TkLabel>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a restriction level to its TK label. Returns null for 'open'. */
export function tkLabelForRestriction(level: RestrictionLevel): TkLabel | null {
  switch (level) {
    case "open":              return null;
    case "men_only":          return TK_LABELS.men_general;
    case "women_only":        return TK_LABELS.women_general;
    case "restricted_sacred": return TK_LABELS.secret_sacred;
    case "pending":           return TK_LABELS.notice;
  }
}

/** Returns true for any non-open restriction level. */
export function isRestricted(level: RestrictionLevel): boolean {
  return level !== "open";
}

// ── Display text ──────────────────────────────────────────────────────────────

/** Full human-readable label for each restriction level. */
export const RESTRICTION_LABELS: Record<RestrictionLevel, string> = {
  open:              "Open",
  men_only:          "Men's business only",
  women_only:        "Women's business only",
  restricted_sacred: "Restricted / Sacred",
  pending:           "Pending TO review",
};

/** Short display label (for tight UI space such as list rows). */
export const RESTRICTION_SHORT: Record<RestrictionLevel, string> = {
  open:              "Open",
  men_only:          "Men only",
  women_only:        "Women only",
  restricted_sacred: "Restricted",
  pending:           "Pending",
};

/** Ordered list of all restriction levels for picker dropdowns. */
export const ALL_RESTRICTION_LEVELS: RestrictionLevel[] = [
  "open",
  "pending",
  "men_only",
  "women_only",
  "restricted_sacred",
];
