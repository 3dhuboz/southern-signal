/**
 * ManifestVerifier — Setup-page panel that takes a previously-exported
 * manifest JSON (paste or drop) and runs it through verifyManifest()
 * against the current device's data.
 *
 * Shows a structured report: global chain match, per-investigation chain
 * match, and per-dossier hash match. A reviewer with two manifests from
 * different points in time, or a manifest + a current device, can use
 * this to confirm nothing has been edited since the trusted export.
 */

import { useCallback, useState } from "react";
import { verifyManifest, type VerificationReport } from "../lib/forensic/manifestVerifier";
import type { Manifest } from "../lib/forensic/manifest";
import s from "./ManifestVerifier.module.css";

interface Status {
  state: "idle" | "verifying" | "done" | "error";
  report?: VerificationReport;
  errorMessage?: string;
}

export function ManifestVerifier() {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [trustedText, setTrustedText] = useState<string>("");

  const runVerify = useCallback(async (raw: string) => {
    setStatus({ state: "verifying" });
    let parsed: Manifest;
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || typeof obj.schema !== "string") {
        throw new Error("Not a Southern Signal manifest (missing schema field).");
      }
      if (obj.schema !== "southern-signal.manifest.v1" && obj.schema !== "southern-signal.manifest.v2") {
        throw new Error(`Unsupported manifest schema "${obj.schema}". Expected v1 or v2.`);
      }
      parsed = obj as Manifest;
    } catch (err) {
      setStatus({ state: "error", errorMessage: (err as Error).message });
      return;
    }
    try {
      const report = await verifyManifest(parsed);
      setStatus({ state: "done", report });
    } catch (err) {
      setStatus({ state: "error", errorMessage: `Verifier crashed: ${(err as Error).message}` });
    }
  }, []);

  const handleVerifyPasted = useCallback(() => {
    if (!trustedText.trim()) return;
    void runVerify(trustedText);
  }, [trustedText, runVerify]);

  const handleFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      setTrustedText(text);
      void runVerify(text);
    } catch (err) {
      setStatus({ state: "error", errorMessage: `Couldn't read file: ${(err as Error).message}` });
    }
  }, [runVerify]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleFile(f);
  }, [handleFile]);

  return (
    <div className={s.wrap}>
      <p className={s.lede}>
        Drop a previously-exported <code>manifest.json</code>, or paste it below. The verifier
        rebuilds a fresh manifest from this device's data and compares: global audit chain root,
        per-investigation chain roots, and SHA-256 of each dossier's <code>result_json</code>. Any
        edit, addition, or deletion since the trusted export will surface as a mismatch.
      </p>

      <div
        className={s.dropzone}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <span className={s.dropzoneCue}>Drop manifest.json here</span>
        <label className={s.dropzoneFile}>
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              // Reset so the same file can be re-selected.
              e.target.value = "";
            }}
          />
          <span>or browse…</span>
        </label>
      </div>

      <textarea
        className={s.paste}
        rows={4}
        value={trustedText}
        onChange={(e) => setTrustedText(e.target.value)}
        placeholder='Or paste JSON: { "schema": "southern-signal.manifest.v2", ... }'
        spellCheck={false}
      />

      <div className={s.actions}>
        <button
          type="button"
          className={s.runBtn}
          onClick={handleVerifyPasted}
          disabled={!trustedText.trim() || status.state === "verifying"}
        >
          {status.state === "verifying" ? "Verifying…" : "Verify"}
        </button>
        {status.state !== "idle" && (
          <button
            type="button"
            className={s.clearBtn}
            onClick={() => { setStatus({ state: "idle" }); setTrustedText(""); }}
          >
            Clear
          </button>
        )}
      </div>

      {status.state === "error" && (
        <p className={s.error}>{status.errorMessage}</p>
      )}

      {status.state === "done" && status.report && (
        <Report report={status.report} />
      )}
    </div>
  );
}

function Report({ report }: { report: VerificationReport }) {
  return (
    <section className={`${s.report} ${report.ok ? s.reportOk : s.reportFail}`.trim()}>
      <header className={s.reportHead}>
        <span className={s.reportBadge}>{report.ok ? "VERIFIED" : "MISMATCH"}</span>
        <span className={s.reportSummary}>{report.summary}</span>
      </header>
      <dl className={s.reportMeta}>
        <div><dt>Trusted schema</dt><dd><code>{report.trustedSchema}</code></dd></div>
        <div><dt>Trusted exported</dt><dd>{new Date(report.trustedGeneratedAt).toLocaleString()}</dd></div>
        <div><dt>Verified now</dt><dd>{new Date(report.currentGeneratedAt).toLocaleString()}</dd></div>
      </dl>

      {/* Global chain */}
      <div className={s.section}>
        <h4 className={s.sectionLabel}>Global audit chain</h4>
        <div className={s.chainRow}>
          <span className={`${s.statusDot} ${report.globalChain.status === "match" ? s.statusOk : s.statusBad}`} />
          <code className={s.hashCode}>{report.globalChain.trustedRoot ?? "(none)"}</code>
          <span className={s.arrow}>→</span>
          <code className={s.hashCode}>{report.globalChain.currentRoot ?? "(none)"}</code>
        </div>
      </div>

      {/* Per-investigation */}
      {report.investigations.length > 0 && (
        <div className={s.section}>
          <h4 className={s.sectionLabel}>Investigations</h4>
          <ul className={s.list}>
            {report.investigations.map((inv) => (
              <li key={inv.id} className={s.invRow}>
                <header className={s.invHead}>
                  <span className={`${s.statusDot} ${inv.chainStatus === "match" ? s.statusOk : s.statusBad}`} />
                  <span className={s.invTitle}>{inv.title}</span>
                  <span className={s.invStatus}>{labelForInvStatus(inv.chainStatus)}</span>
                </header>
                {inv.dossiers.length > 0 && (
                  <ul className={s.dossierList}>
                    {inv.dossiers.map((d) => (
                      <li key={d.id} className={s.dossierRow}>
                        <span className={`${s.statusDot} ${d.status === "match" ? s.statusOk : s.statusBad}`} />
                        <span className={s.dossierVenue}>{d.venueName}</span>
                        <span className={s.dossierStatus}>{labelForDossierStatus(d.status)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Standalone dossiers */}
      {report.standaloneDossiers.length > 0 && (
        <div className={s.section}>
          <h4 className={s.sectionLabel}>Standalone (recon) dossiers</h4>
          <ul className={s.dossierList}>
            {report.standaloneDossiers.map((d) => (
              <li key={d.id} className={s.dossierRow}>
                <span className={`${s.statusDot} ${d.status === "match" ? s.statusOk : s.statusBad}`} />
                <span className={s.dossierVenue}>{d.venueName}</span>
                <span className={s.dossierStatus}>{labelForDossierStatus(d.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function labelForInvStatus(status: string): string {
  switch (status) {
    case "match": return "chain root match";
    case "mismatch": return "chain root MISMATCH";
    case "trusted_only": return "missing on current device";
    case "current_only": return "added since export";
    default: return status;
  }
}

function labelForDossierStatus(status: string): string {
  switch (status) {
    case "match": return "hash match";
    case "hash_mismatch": return "result_json edited";
    case "missing_in_current": return "deleted since export";
    case "extra_in_current": return "added since export";
    default: return status;
  }
}
