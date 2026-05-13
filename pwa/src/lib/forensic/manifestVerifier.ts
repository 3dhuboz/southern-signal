/**
 * Manifest verifier — reviewer-side integrity check.
 *
 * Takes a previously-exported v1, v2, or v3 manifest and verifies it
 * against the current device's data. The check surfaces:
 *
 *   • Whether the global audit chain Merkle root matches the trusted
 *     manifest (full-chain integrity).
 *   • Per-investigation: chain root, dossier list, dossier hashes.
 *   • Standalone dossier hashes (v2 only).
 *
 * Tampering modes the verifier catches:
 *   - Editing a dossier's result_json (hash mismatch)
 *   - Adding a dossier post-export (extra row in current, not in trusted)
 *   - Deleting a dossier post-export (extra row in trusted, not in current)
 *   - Splicing the audit chain (Merkle root mismatch)
 *
 * What it can't catch:
 *   - Both sides tampered identically (i.e., the dossier was rewritten
 *     and the audit chain re-hashed). At that point you need an off-
 *     device anchor (RFC 3161 / COSE — Tier 3 work).
 */

import { buildManifest, type Manifest, type ManifestDossierView, type ManifestInvestigationView } from "./manifest";

export interface VerificationDossierFinding {
  id: string;
  venueName: string;
  status: "match" | "hash_mismatch" | "missing_in_current" | "extra_in_current";
  trustedSha?: string;
  currentSha?: string;
}

export interface VerificationInvestigationFinding {
  id: string;
  title: string;
  /** Audit chain merkle root comparison for this investigation. */
  chainStatus: "match" | "mismatch" | "trusted_only" | "current_only";
  trustedRoot: string | null;
  currentRoot: string | null;
  dossiers: VerificationDossierFinding[];
}

export interface VerificationReport {
  ok: boolean;
  /** Schema version of the trusted manifest. v1 has no dossiers. */
  trustedSchema: string;
  trustedGeneratedAt: string;
  currentGeneratedAt: string;
  globalChain: {
    trustedRoot: string | null;
    currentRoot: string | null;
    status: "match" | "mismatch";
  };
  investigations: VerificationInvestigationFinding[];
  standaloneDossiers: VerificationDossierFinding[];
  /** Human-readable summary line for the UI. */
  summary: string;
}

function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

function compareDossierLists(
  trusted: ManifestDossierView[] | undefined,
  current: ManifestDossierView[],
): VerificationDossierFinding[] {
  const out: VerificationDossierFinding[] = [];
  const tIdx = indexById(trusted ?? []);
  const cIdx = indexById(current);
  // Trusted-first iteration: every trusted row should have a current match.
  for (const t of trusted ?? []) {
    const c = cIdx.get(t.id);
    if (!c) {
      out.push({ id: t.id, venueName: t.venue_name, status: "missing_in_current", trustedSha: t.result_sha256 });
      continue;
    }
    if (c.result_sha256 === t.result_sha256) {
      out.push({ id: t.id, venueName: t.venue_name, status: "match", trustedSha: t.result_sha256, currentSha: c.result_sha256 });
    } else {
      out.push({ id: t.id, venueName: t.venue_name, status: "hash_mismatch", trustedSha: t.result_sha256, currentSha: c.result_sha256 });
    }
  }
  // Now check for current rows the trusted manifest didn't know about.
  for (const c of current) {
    if (!tIdx.has(c.id)) {
      out.push({ id: c.id, venueName: c.venue_name, status: "extra_in_current", currentSha: c.result_sha256 });
    }
  }
  return out;
}

/**
 * Run the verification. Builds a fresh manifest from current data so
 * the caller doesn't have to. Returns a structured report; ok=true iff
 * everything matched.
 *
 * `current` can be supplied to compare two prepared manifests without
 * touching the DB — used by the test suite. Production callers omit
 * it and the function builds from current state.
 */
export async function verifyManifest(trusted: Manifest, current?: Manifest): Promise<VerificationReport> {
  if (!current) current = await buildManifest();

  // Global audit chain root.
  const globalChainMatch = trusted.global_audit_chain.merkle_root === current.global_audit_chain.merkle_root;

  // Per-investigation comparison. Iterate trusted-first then add
  // current-only rows so the report covers both directions.
  const trustedByInv = new Map(trusted.investigations.map((i) => [i.id, i] as const));
  const currentByInv = new Map(current.investigations.map((i) => [i.id, i] as const));
  const allInvIds = new Set<string>();
  for (const i of trusted.investigations) allInvIds.add(i.id);
  for (const i of current.investigations) allInvIds.add(i.id);

  const investigations: VerificationInvestigationFinding[] = [];
  for (const id of allInvIds) {
    const t = trustedByInv.get(id);
    const c = currentByInv.get(id);
    if (t && !c) {
      investigations.push({
        id, title: t.title, chainStatus: "trusted_only",
        trustedRoot: t.audit_chain.merkle_root, currentRoot: null,
        dossiers: compareDossierLists(asDossierList(t), []),
      });
      continue;
    }
    if (!t && c) {
      investigations.push({
        id, title: c.title, chainStatus: "current_only",
        trustedRoot: null, currentRoot: c.audit_chain.merkle_root,
        dossiers: compareDossierLists([], asDossierList(c)),
      });
      continue;
    }
    if (t && c) {
      const status: VerificationInvestigationFinding["chainStatus"] =
        t.audit_chain.merkle_root === c.audit_chain.merkle_root ? "match" : "mismatch";
      investigations.push({
        id, title: c.title, chainStatus: status,
        trustedRoot: t.audit_chain.merkle_root, currentRoot: c.audit_chain.merkle_root,
        dossiers: compareDossierLists(asDossierList(t), asDossierList(c)),
      });
    }
  }

  // Standalone dossiers — v2 only. Treat missing arrays as empty.
  const standaloneDossiers = compareDossierLists(
    trusted.standalone_research_dossiers ?? [],
    current.standalone_research_dossiers ?? [],
  );

  // Roll-up ok: every dossier matches AND every chain root matches.
  const anyDossierFail = (rows: VerificationDossierFinding[]) =>
    rows.some((r) => r.status !== "match");
  const anyInvFail = investigations.some((i) =>
    i.chainStatus !== "match" || anyDossierFail(i.dossiers));
  const ok = globalChainMatch && !anyInvFail && !anyDossierFail(standaloneDossiers);

  // Summary line — quick read for the UI.
  let summary: string;
  if (ok) {
    const dossierTotal = investigations.reduce((n, i) => n + i.dossiers.length, 0) + standaloneDossiers.length;
    summary = `Verified · audit chain root match · ${dossierTotal} dossier${dossierTotal === 1 ? "" : "s"} checked.`;
  } else {
    const issues: string[] = [];
    if (!globalChainMatch) issues.push("global audit chain root mismatch");
    const mismatchedDossiers = [...investigations.flatMap((i) => i.dossiers), ...standaloneDossiers]
      .filter((d) => d.status === "hash_mismatch").length;
    if (mismatchedDossiers > 0) issues.push(`${mismatchedDossiers} dossier hash mismatch${mismatchedDossiers === 1 ? "" : "es"}`);
    const missing = [...investigations.flatMap((i) => i.dossiers), ...standaloneDossiers]
      .filter((d) => d.status === "missing_in_current").length;
    if (missing > 0) issues.push(`${missing} dossier${missing === 1 ? "" : "s"} missing in current`);
    const extra = [...investigations.flatMap((i) => i.dossiers), ...standaloneDossiers]
      .filter((d) => d.status === "extra_in_current").length;
    if (extra > 0) issues.push(`${extra} dossier${extra === 1 ? "" : "s"} added since export`);
    const chainMismatches = investigations.filter((i) => i.chainStatus === "mismatch").length;
    if (chainMismatches > 0) issues.push(`${chainMismatches} investigation chain mismatch${chainMismatches === 1 ? "" : "es"}`);
    summary = `Verification failed — ${issues.join("; ")}.`;
  }

  return {
    ok,
    trustedSchema: trusted.schema,
    trustedGeneratedAt: trusted.generated_at,
    currentGeneratedAt: current.generated_at,
    globalChain: {
      trustedRoot: trusted.global_audit_chain.merkle_root,
      currentRoot: current.global_audit_chain.merkle_root,
      status: globalChainMatch ? "match" : "mismatch",
    },
    investigations,
    standaloneDossiers,
    summary,
  };
}

/**
 * Read dossiers from an investigation view, tolerating older v1
 * manifests which don't have the field. Returns empty array for v1.
 */
function asDossierList(inv: ManifestInvestigationView): ManifestDossierView[] {
  const maybe = (inv as { research_dossiers?: ManifestDossierView[] }).research_dossiers;
  return Array.isArray(maybe) ? maybe : [];
}
