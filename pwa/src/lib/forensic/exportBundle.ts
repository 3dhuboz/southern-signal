/**
 * V1.1 Export bundle — the deliverable you hand to a skeptic reviewer,
 * a producer, or your own lawyer. A single ZIP containing:
 *
 *   manifest.json        — Merkle root + chain summary + investigation list
 *   audit_log.jsonl      — every chain entry, one per line, in seq order
 *   investigations.json  — full investigation rows
 *   evidence_events.json — every recorded event, grouped by investigation
 *   transcripts.json     — every transcript segment, grouped by media
 *   media/<inv>/...      — actual binary files (audio/image/video) by sha8
 *   README.md            — verification instructions
 *   verify.html          — drop-in browser verifier (no dep, runs offline)
 *   verify.js            — same logic for Node (node verify.js bundle.zip)
 *
 * Pass `investigationId` to scope the bundle to one case; omit for the
 * full archive across every case on this device.
 *
 * The audit chain in audit_log.jsonl is ALWAYS the global chain (not
 * scoped) — partial chains can't be re-verified end-to-end. The manifest
 * notes which seqs touched the scoped investigation.
 */

import { query } from "../db/db";
import { readFile, exists } from "../opfs";
import { getPreferences } from "../preferences";
import { buildManifest } from "./manifest";
import { computeReadiness, type ReadinessCheck, type OverallStatus } from "./preAirReadiness";
import { buildZip, jsonEntry, textEntry, type ZipEntry } from "./zip";
import type { AuditLogEntry, EvidenceEvent, Investigation, MediaAsset, ReviewerSignoffRow, SensorSample } from "../db/schema";

interface TranscriptRow {
  id: string;
  media_id: string;
  investigation_id: string;
  segment_start_s: number;
  segment_end_s: number;
  text: string;
  confidence: number | null;
  engine: string;
  metadata_json: string | null;
}

export interface ExportSummary {
  filename: string;
  byteLength: number;
  entries: number;
  mediaIncluded: number;
  mediaMissing: number;
  scope: "all" | "single";
  investigationIds: string[];
}

const APP_VERSION = "0.1.0";

const README_TEXT = (summary: { investigations: number; events: number; media: number; auditEntries: number; merkleRoot: string | null; verification: string }) => `# Southern Signal — Case Bundle

Schema: \`southern-signal.export.v1.1\`
Generated: ${new Date().toISOString()}
App version: ${APP_VERSION}

## Contents

- \`manifest.json\` — Merkle root over the audit chain, per-investigation summary.
- \`audit_log.jsonl\` — append-only hash-chained event log, one entry per line.
  Each entry binds: \`seq | ts_utc | actor | kind | canonical_payload | prev_hash\` → \`entry_hash\` (SHA-256).
- \`investigations.json\` — investigation metadata.
- \`evidence_events.json\` — observations, markers, contamination flags, session_start/stop.
- \`transcripts.json\` — Whisper / cloud transcripts of EVP / spirit-box clips.
- \`media/<investigation_id>/<media_id>.<ext>\` — original audio/image/video binaries.
  The file path matches the \`file_path\` column in \`media_assets\` (less the case prefix).
- \`sensors/<investigation_id>/baseline.json\` — first 5 minutes of sensor samples
  per investigation, ordered by timestamp ASC. Snapshot of "what was normal at
  the site" for reviewers. Omitted for investigations with no sensor data.
- \`acknowledgement.txt\` — the user's Acknowledgement of Country statement, or a
  placeholder note if no acknowledgement has been recorded.
- \`reviewers.json\` — external reviewer sign-offs recorded on the device.
  Each row's \`statement\` is also anchored by SHA-256 in \`manifest.json\`
  and in the \`reviewer.signoff.create\` / \`.update\` audit-chain entries —
  a forger would have to break the chain to alter them. Empty array if no
  sign-offs have been recorded.
- \`readiness.json\` — snapshot of pre-air readiness at bundle build
  time: overall status (\`ready\` / \`caveats\` / \`blocked\`) + per-check
  pass/fail. The same data appears in human-readable form on the cover
  sheet. Computed from the live state, not stored — running the build
  again later may produce a different result if sign-offs were added.
- \`README.md\` — this file.
- \`verify.html\` — open in a browser to re-verify the chain locally, no network.
- \`verify.js\` — \`node verify.js audit_log.jsonl\` for the same check.

## Summary

- Investigations: ${summary.investigations}
- Evidence events: ${summary.events}
- Media assets: ${summary.media}
- Audit chain entries: ${summary.auditEntries}
- Merkle root: \`${summary.merkleRoot ?? "(empty chain)"}\`
- Chain verification at export time: ${summary.verification}

## Verifying the chain

The audit log is hash-chained. To prove no entry has been edited, inserted,
or deleted:

1. Take the genesis hash \`${"0".repeat(64)}\` as \`prev_hash\` for seq 1.
2. For each entry in seq order, compute SHA-256 of:
   \`${"\\${seq}|\\${ts_utc}|\\${actor}|\\${kind}|\\${payload_json}|\\${prev_hash}"}\`
3. The result must equal the entry's \`entry_hash\`.
4. The next entry's \`prev_hash\` must equal this entry's \`entry_hash\`.

\`payload_json\` is canonical-stable JSON with sorted keys.

The \`verify.html\` and \`verify.js\` files do this for you — drop the
\`audit_log.jsonl\` from this bundle into either and they'll report
\`OK · ${summary.auditEntries} entries verified\` or pinpoint the broken seq.

## Media integrity

Each media asset has a \`checksum_sha256\` in \`investigations.json\` /
\`evidence_events.json\` payload. Re-hash the file in \`media/...\` and compare.
On Linux/macOS:

    shasum -a 256 media/<investigation>/<file>

On Windows:

    certutil -hashfile media\\<investigation>\\<file> SHA256

## What this bundle does NOT do

- It does not prove the original event was paranormal. It proves the
  recording, audit, and transcript pipeline weren't tampered with after
  capture.
- It does not include the full sensor stream — only the first 5 minutes per
  investigation as a baseline snapshot. Full sensor data is too high-volume
  for case review and lives on the device.
- It does not redact culturally sensitive material. Investigators must
  apply that gate before sharing the bundle externally.
`;

interface CoverReviewer {
  reviewerName: string;
  discipline: string;
  affiliation: string | null;
  signedAt: string;
  appVersion: string;
  statement: string;
  identifier: string | null;
  sourceUrl: string | null;
}

interface CoverData {
  generatedAt: string;
  scope: "all" | "single";
  investigationCount: number;
  caseTitle: string | null;
  caseLocation: string | null;
  caseId: string | null;
  caseStatus: string | null;
  caseDisposition: string | null;
  leafCount: number;
  merkleRoot: string | null;
  verificationOk: boolean;
  verificationDetail: string;
  counts: { investigations: number; events: number; media: number; transcripts: number };
  aocAccepted: boolean;
  aocStatement: string | null;
  reviewers: CoverReviewer[];
  readiness: {
    overall: OverallStatus;
    summary: string;
    checks: ReadinessCheck[];
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function truncateMiddle(s: string | null, head = 10, tail = 10): string {
  if (!s) return "(empty chain)";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const COVER_HTML_TEMPLATE = (d: CoverData): string => {
  const verifyMark = d.verificationOk ? "✓" : "✗";
  const verifyClass = d.verificationOk ? "ok" : "bad";
  const verifyText = d.verificationOk ? "Verified" : `Broken (${escapeHtml(d.verificationDetail)})`;
  const scopeBlock = d.scope === "single"
    ? `<dl class="case">
      <dt>Case</dt><dd>${escapeHtml(d.caseTitle ?? "(untitled)")}</dd>
      <dt>Location</dt><dd>${escapeHtml(d.caseLocation ?? "(none recorded)")}</dd>
      <dt>ID</dt><dd><code>${escapeHtml(d.caseId ?? "")}</code></dd>
      <dt>Status</dt><dd>${escapeHtml(d.caseStatus ?? "")}</dd>
      <dt>Disposition</dt><dd>${escapeHtml(d.caseDisposition ?? "(none)")}</dd>
    </dl>`
    : `<p class="agg">${d.investigationCount} investigation${d.investigationCount === 1 ? "" : "s"} on this device.</p>`;
  const aocBlock = d.aocAccepted && d.aocStatement
    ? `<blockquote>${escapeHtml(d.aocStatement)}</blockquote>`
    : `<p class="muted">No acknowledgement recorded.</p>`;
  const readinessMark = d.readiness.overall === "ready" ? "✓" : d.readiness.overall === "caveats" ? "⚠" : "✗";
  const readinessClass = d.readiness.overall === "ready" ? "ready" : d.readiness.overall === "caveats" ? "caveats" : "blocked";
  const readinessBlock = `
    <div class="readiness ${readinessClass}">
      <div class="rbanner"><span class="rmark">${readinessMark}</span><span class="rsummary">${escapeHtml(d.readiness.summary)}</span></div>
      <ul class="rchecks">${d.readiness.checks.map((c) => `
        <li class="${c.status === "pass" ? "pass" : c.severity === "warn" ? "warn" : "fail"}">
          <span class="cmark">${c.status === "pass" ? "✓" : "✗"}</span>
          <span class="clabel">${escapeHtml(c.label)}</span>
          ${c.detail ? `<div class="cdetail">${escapeHtml(c.detail)}</div>` : ""}
        </li>`).join("")}</ul>
    </div>`;
  const reviewersBlock = d.reviewers.length === 0
    ? `<p class="muted">No external reviewer sign-offs recorded.</p>`
    : `<ul class="reviewers">${d.reviewers.map((r) => `
      <li>
        <div class="rhead"><span class="rname">${escapeHtml(r.reviewerName)}</span><span class="rdisc">${escapeHtml(r.discipline.toUpperCase())}</span></div>
        ${r.affiliation ? `<div class="raff">${escapeHtml(r.affiliation)}</div>` : ""}
        <div class="rmeta">Signed ${escapeHtml(r.signedAt)} · v${escapeHtml(r.appVersion)}</div>
        <blockquote>${escapeHtml(r.statement)}</blockquote>
        ${(r.identifier || r.sourceUrl) ? `<div class="rrefs">${[r.identifier ? `<code>${escapeHtml(r.identifier)}</code>` : "", r.sourceUrl ? `<code>${escapeHtml(r.sourceUrl)}</code>` : ""].filter(Boolean).join(" · ")}</div>` : ""}
      </li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Southern Signal · Case Bundle Cover</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 12pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; max-width: 720px; margin: 32px auto; padding: 0 24px; }
  header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 24px; }
  h1 { font-size: 28pt; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .sub { font-size: 13pt; color: #555; margin-top: 4px; }
  .meta { font-size: 10pt; color: #666; margin-top: 8px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  section { margin: 22px 0; page-break-inside: avoid; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.08em; color: #333; margin: 0 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  dl.case { display: grid; grid-template-columns: 120px 1fr; gap: 6px 16px; margin: 0; }
  dl.case dt { font-weight: 600; color: #555; }
  dl.case dd { margin: 0; }
  .agg { font-size: 14pt; margin: 8px 0; }
  table.counts { width: 100%; border-collapse: collapse; }
  table.counts td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  table.counts td:last-child { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .chain { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 10pt; }
  .chain .row { display: flex; justify-content: space-between; padding: 4px 0; }
  .chain .row .k { color: #555; }
  .ok { color: #0a7e3f; font-weight: 700; }
  .bad { color: #b00020; font-weight: 700; }
  blockquote { margin: 0; padding: 12px 16px; border-left: 4px solid #888; background: #f7f7f7; font-style: italic; }
  .muted { color: #777; font-style: italic; margin: 0; }
  ul.reviewers { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 14px; }
  ul.reviewers li { padding: 12px 14px; border: 1px solid #ddd; border-left: 3px solid #0a7e3f; border-radius: 4px; background: #fdfdfd; }
  ul.reviewers .rhead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  ul.reviewers .rname { font-weight: 700; font-size: 12pt; }
  ul.reviewers .rdisc { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; letter-spacing: 1.2px; color: #555; padding: 1px 6px; border: 1px solid #ccc; border-radius: 999px; }
  ul.reviewers .raff { font-size: 10pt; color: #555; margin-top: 2px; }
  ul.reviewers .rmeta { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; color: #666; margin-top: 4px; }
  ul.reviewers blockquote { margin-top: 8px; }
  ul.reviewers .rrefs { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; color: #666; margin-top: 6px; word-break: break-all; }
  .readiness { display: flex; flex-direction: column; gap: 10px; }
  .readiness .rbanner { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 4px; border: 1px solid #ccc; }
  .readiness .rmark { font-size: 18pt; font-weight: 800; line-height: 1; }
  .readiness .rsummary { font-size: 12pt; font-weight: 700; }
  .readiness.ready    .rbanner { border-color: #0a7e3f; background: #ecf9f1; color: #0a7e3f; }
  .readiness.caveats  .rbanner { border-color: #b87600; background: #fff5e0; color: #7a5000; }
  .readiness.blocked  .rbanner { border-color: #b00020; background: #fceaec; color: #b00020; }
  .readiness ul.rchecks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .readiness ul.rchecks li { padding: 8px 12px; border: 1px solid #e0e0e0; border-left: 3px solid #ccc; border-radius: 3px; background: #fafafa; }
  .readiness ul.rchecks li.pass { border-left-color: #0a7e3f; }
  .readiness ul.rchecks li.fail { border-left-color: #b00020; }
  .readiness ul.rchecks li.warn { border-left-color: #b87600; }
  .readiness ul.rchecks .cmark { display: inline-block; min-width: 18px; font-weight: 800; }
  .readiness ul.rchecks li.pass .cmark { color: #0a7e3f; }
  .readiness ul.rchecks li.fail .cmark { color: #b00020; }
  .readiness ul.rchecks li.warn .cmark { color: #b87600; }
  .readiness ul.rchecks .clabel { font-weight: 700; }
  .readiness ul.rchecks .cdetail { margin-top: 4px; margin-left: 18px; font-size: 9.5pt; color: #555; line-height: 1.4; }
  footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 9pt; color: #666; }
  footer code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  @media print { body { margin: 0; max-width: none; padding: 0; } }
</style></head><body>
<header>
  <h1>Southern Signal</h1>
  <div class="sub">Case Bundle</div>
  <div class="meta">Generated ${escapeHtml(d.generatedAt)} · v${escapeHtml(APP_VERSION)}</div>
</header>
<section><h2>Scope</h2>${scopeBlock}</section>
<section><h2>Audit chain</h2>
  <div class="chain">
    <div class="row"><span class="k">Leaves</span><span>${d.leafCount}</span></div>
    <div class="row"><span class="k">Merkle root</span><span>${escapeHtml(truncateMiddle(d.merkleRoot))}</span></div>
    <div class="row"><span class="k">Verification</span><span class="${verifyClass}">${verifyMark} ${verifyText}</span></div>
  </div>
</section>
<section><h2>Counts</h2>
  <table class="counts">
    <tr><td>Investigations</td><td>${d.counts.investigations}</td></tr>
    <tr><td>Evidence events</td><td>${d.counts.events}</td></tr>
    <tr><td>Media assets</td><td>${d.counts.media}</td></tr>
    <tr><td>Transcripts</td><td>${d.counts.transcripts}</td></tr>
  </table>
</section>
<section><h2>Pre-air readiness</h2>${readinessBlock}</section>
<section><h2>External reviewer sign-off</h2>${reviewersBlock}</section>
<section><h2>Acknowledgement of Country</h2>${aocBlock}</section>
<footer>
  To re-verify the chain: open <code>verify.html</code> in this folder, or run <code>node verify.js audit_log.jsonl</code>.
</footer>
</body></html>
`;
};

const VERIFY_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Southern Signal · Audit chain verifier</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .drop { border: 2px dashed #999; border-radius: 12px; padding: 32px; text-align: center; color: #666; cursor: pointer; }
  .drop.over { border-color: #0a8; color: #0a8; }
  pre { background: #f5f5f5; border-radius: 6px; padding: 12px; overflow-x: auto; }
  .ok { color: #080; font-weight: 700; }
  .bad { color: #c00; font-weight: 700; }
  .muted { color: #666; }
</style>
<h1>Southern Signal — Audit chain verifier</h1>
<p class="muted">Drop <code>audit_log.jsonl</code> from a case bundle to verify the SHA-256 hash chain.<br>Runs entirely in your browser — nothing is uploaded.</p>
<div id="drop" class="drop">Drop <code>audit_log.jsonl</code> here, or click to pick a file.</div>
<input type="file" id="picker" accept=".jsonl,.json,text/*" style="display:none">
<pre id="out">Awaiting file…</pre>
<script>
const drop = document.getElementById('drop');
const out = document.getElementById('out');
const picker = document.getElementById('picker');

drop.addEventListener('click', () => picker.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) verify(f);
});
picker.addEventListener('change', () => { if (picker.files[0]) verify(picker.files[0]); });

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verify(file) {
  out.textContent = 'Reading ' + file.name + '...';
  const text = await file.text();
  const lines = text.split(/\\r?\\n/).filter(Boolean);
  const GENESIS = '0'.repeat(64);
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (e) {
      out.innerHTML = '<span class="bad">FAIL</span> · seq ' + expectedSeq + ' is not valid JSON';
      return;
    }
    if (row.seq !== expectedSeq) {
      out.innerHTML = '<span class="bad">FAIL</span> · expected seq ' + expectedSeq + ', got ' + row.seq;
      return;
    }
    if (row.prev_hash !== prev) {
      out.innerHTML = '<span class="bad">FAIL</span> · seq ' + row.seq + ' prev_hash mismatch';
      return;
    }
    const msg = row.seq + '|' + row.ts_utc + '|' + row.actor + '|' + row.kind + '|' + row.payload_json + '|' + row.prev_hash;
    const recomputed = await sha256Hex(msg);
    if (recomputed !== row.entry_hash) {
      out.innerHTML = '<span class="bad">FAIL</span> · seq ' + row.seq + ' entry_hash mismatch';
      return;
    }
    prev = row.entry_hash;
    expectedSeq += 1;
  }
  out.innerHTML = '<span class="ok">OK</span> · ' + lines.length + ' entries verified · last entry_hash = <code>' + prev + '</code>';
}
</script>
`;

const VERIFY_JS = `#!/usr/bin/env node
// Southern Signal — audit chain verifier (Node 18+).
// Usage: node verify.js audit_log.jsonl
const fs = require('fs');
const crypto = require('crypto');
const path = process.argv[2];
if (!path) { console.error('Usage: node verify.js audit_log.jsonl'); process.exit(2); }

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const text = fs.readFileSync(path, 'utf8');
const lines = text.split(/\\r?\\n/).filter(Boolean);
const GENESIS = '0'.repeat(64);
let prev = GENESIS;
let expectedSeq = 1;
for (const line of lines) {
  const row = JSON.parse(line);
  if (row.seq !== expectedSeq) { console.error('FAIL seq', expectedSeq, '->', row.seq); process.exit(1); }
  if (row.prev_hash !== prev) { console.error('FAIL prev_hash mismatch at seq', row.seq); process.exit(1); }
  const msg = row.seq + '|' + row.ts_utc + '|' + row.actor + '|' + row.kind + '|' + row.payload_json + '|' + row.prev_hash;
  const recomputed = crypto.createHash('sha256').update(msg).digest('hex');
  if (recomputed !== row.entry_hash) { console.error('FAIL entry_hash mismatch at seq', row.seq); process.exit(1); }
  prev = row.entry_hash;
  expectedSeq += 1;
}
console.log('OK ·', lines.length, 'entries verified · last entry_hash =', prev);
`;

export interface BundleDossierRow {
  id: string;
  investigation_id: string | null;
  venue_name: string;
  location_hint: string | null;
  region: string;
  created_at: string;
  model: string;
  result_json: string;
}

export interface BundleFindingNoteRow {
  id: string;
  dossier_id: string;
  finding_key: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchBundleData {
  dossiers: BundleDossierRow[];
  notes: BundleFindingNoteRow[];
}

/**
 * Pull dossiers attached to the bundle's investigations OR standalone
 * (investigation_id NULL) dossiers whose venue_name matches a case
 * title OR location_name — same rule the brief uses. Plus the notes
 * joined to those dossiers. Returns empty arrays for pre-v4 / pre-v5
 * schemas so the bundle still builds on older installs.
 *
 * Exported for unit testing — see exportBundle.test.ts.
 */
export async function loadResearchForBundle(
  investigationIds: string[],
  investigations: Pick<Investigation, "id" | "title" | "location_name">[],
): Promise<ResearchBundleData> {
  let dossiers: BundleDossierRow[] = [];
  try {
    if (investigationIds.length === 0) {
      dossiers = await query<BundleDossierRow>(
        "SELECT * FROM research_dossiers WHERE investigation_id IS NULL",
      );
    } else {
      const titles = investigations.map((i) => (i.title ?? "").toLowerCase());
      const locations = investigations.map((i) => (i.location_name ?? "").toLowerCase());
      const invPh = investigationIds.map(() => "?").join(",");
      const titlePh = titles.map(() => "?").join(",") || "''";
      const locPh = locations.map(() => "?").join(",") || "''";
      dossiers = await query<BundleDossierRow>(
        `SELECT * FROM research_dossiers WHERE investigation_id IN (${invPh})
           OR (investigation_id IS NULL
               AND (LOWER(venue_name) IN (${titlePh}) OR LOWER(venue_name) IN (${locPh})))`,
        [...investigationIds, ...titles, ...locations],
      );
    }
  } catch { /* pre-v4 — no research_dossiers table */ }

  let notes: BundleFindingNoteRow[] = [];
  if (dossiers.length > 0) {
    try {
      const dossierIds = dossiers.map((d) => d.id);
      const ph = dossierIds.map(() => "?").join(",");
      notes = await query<BundleFindingNoteRow>(
        `SELECT * FROM research_finding_notes WHERE dossier_id IN (${ph})`,
        dossierIds,
      );
    } catch { /* pre-v5 — no research_finding_notes table */ }
  }

  return { dossiers, notes };
}

/**
 * Turn loaded dossier + note rows into the ZIP entries to append.
 * Grouped per-investigation for grep-ability; standalone dossiers
 * land under research/standalone/. Pretty-prints the result JSON;
 * malformed payloads keep their raw string so a reviewer can still
 * inspect what the model produced.
 *
 * Exported for unit testing.
 */
export function buildResearchEntries({ dossiers, notes }: ResearchBundleData): ZipEntry[] {
  if (dossiers.length === 0) return [];
  const out: ZipEntry[] = [];
  for (const d of dossiers) {
    let resultObj: unknown = d.result_json;
    try { resultObj = JSON.parse(d.result_json); } catch { /* keep raw */ }
    const folder = d.investigation_id ?? "standalone";
    out.push(jsonEntry(`research/${folder}/${d.id}.json`, {
      id: d.id,
      investigation_id: d.investigation_id,
      venue_name: d.venue_name,
      location_hint: d.location_hint,
      region: d.region,
      created_at: d.created_at,
      model: d.model,
      result: resultObj,
    }));
  }
  if (notes.length > 0) {
    out.push(jsonEntry("research/finding_notes.json", notes));
  }
  return out;
}

export async function buildExportBundle(investigationId?: string): Promise<{ blob: Blob; summary: ExportSummary }> {
  const scope = investigationId ? "single" : "all";
  const manifest = await buildManifest();
  const allAudit = await query<AuditLogEntry>("SELECT * FROM audit_log ORDER BY seq ASC");

  const investigations = investigationId
    ? await query<Investigation>("SELECT * FROM investigations WHERE id = ?", [investigationId])
    : await query<Investigation>("SELECT * FROM investigations ORDER BY created_at ASC");

  const investigationIds = investigations.map((inv) => inv.id);

  const placeholders = investigationIds.map(() => "?").join(",");
  const events = investigationIds.length === 0
    ? []
    : await query<EvidenceEvent>(`SELECT * FROM evidence_events WHERE investigation_id IN (${placeholders}) ORDER BY timestamp ASC`, investigationIds);
  const media = investigationIds.length === 0
    ? []
    : await query<MediaAsset>(`SELECT * FROM media_assets WHERE investigation_id IN (${placeholders}) ORDER BY timestamp_start ASC`, investigationIds);
  const transcripts = investigationIds.length === 0
    ? []
    : await query<TranscriptRow>(`SELECT * FROM transcripts WHERE investigation_id IN (${placeholders})`, investigationIds);

  const entries: ZipEntry[] = [];

  // 1. Manifest (filtered to this scope's investigations).
  const scopedManifest = scope === "single"
    ? { ...manifest, investigations: manifest.investigations.filter((i) => investigationIds.includes(i.id)) }
    : manifest;
  entries.push(jsonEntry("manifest.json", scopedManifest));

  // 2. Audit log as JSONL — global chain (partial chains aren't verifiable).
  const auditJsonl = allAudit.map((e) => JSON.stringify(e)).join("\n") + (allAudit.length ? "\n" : "");
  entries.push(textEntry("audit_log.jsonl", auditJsonl));

  // 3. Investigations / events / transcripts.
  entries.push(jsonEntry("investigations.json", investigations));
  entries.push(jsonEntry("evidence_events.json", events));
  entries.push(jsonEntry("transcripts.json", transcripts));

  // Research dossiers + reviewer notes (v4 + v5). The manifest already
  // anchors each dossier with a SHA-256; we include raw rows here so
  // reviewers with both the bundle and the manifest can re-hash and
  // confirm. Pre-v4/v5 schemas skip silently.
  const research = await loadResearchForBundle(investigationIds, investigations);
  for (const entry of buildResearchEntries(research)) entries.push(entry);

  // External reviewer sign-offs (v6). Methodology-level — always
  // included regardless of scope, even in single-case bundles, so any
  // downstream reviewer can see who signed off and on which version.
  // Pre-v6 schema skips silently and emits an empty array.
  let reviewerRows: ReviewerSignoffRow[] = [];
  try {
    reviewerRows = await query<ReviewerSignoffRow>(
      "SELECT * FROM reviewer_signoffs ORDER BY signed_at DESC, created_at DESC",
    );
  } catch { /* pre-v6 — no table yet */ }
  entries.push(jsonEntry("reviewers.json", reviewerRows));

  // Pre-air readiness — snapshot of the methodology gates at bundle
  // build time. Re-runs may produce a different result if sign-offs
  // were added or the chain was broken between builds; that's a
  // feature, not a bug — the cover sheet always reflects the moment
  // the bundle was created.
  const aocAccepted = getPreferences().acknowledgementOfCountry.accepted;
  const readiness = computeReadiness({
    aocAccepted,
    appVersion: APP_VERSION,
    signoffs: reviewerRows,
    chain: manifest.global_audit_chain.verification,
  });
  entries.push(jsonEntry("readiness.json", {
    generated_at: new Date().toISOString(),
    app_version: APP_VERSION,
    overall: readiness.overall,
    summary: readiness.summary,
    checks: readiness.checks,
    counts: readiness.counts,
  }));

  // 4. Media binaries.
  let mediaIncluded = 0;
  let mediaMissing = 0;
  for (const m of media) {
    try {
      const ok = await exists(m.file_path);
      if (!ok) { mediaMissing += 1; continue; }
      const file = await readFile(m.file_path);
      const buf = new Uint8Array(await file.arrayBuffer());
      // Use the asset's file_path (already inside "media/<inv>/...") — strip the
      // leading slash if there is one, so it lands as "media/..." in the ZIP.
      const archivePath = m.file_path.replace(/^\/+/, "");
      entries.push({ path: archivePath, data: buf, mtime: new Date(m.timestamp_start) });
      mediaIncluded += 1;
    } catch {
      mediaMissing += 1;
    }
  }

  // 5. README + verifiers.
  const verification = manifest.global_audit_chain.verification.ok ? "OK" : `BROKEN at seq ${manifest.global_audit_chain.verification.brokenAtSeq}`;
  entries.push(textEntry("README.md", README_TEXT({
    investigations: investigations.length,
    events: events.length,
    media: media.length,
    auditEntries: allAudit.length,
    merkleRoot: manifest.global_audit_chain.merkle_root,
    verification,
  })));
  entries.push(textEntry("verify.html", VERIFY_HTML));
  entries.push(textEntry("verify.js", VERIFY_JS));

  // 6. Acknowledgement of Country — always included so reviewers can see
  // whether the user recorded an acknowledgement. Placeholder if not.
  const aoc = getPreferences().acknowledgementOfCountry;

  // Cover page — single-page printable summary for binders/case files.
  const singleCase = scope === "single" ? investigations[0] ?? null : null;
  const coverHtml = COVER_HTML_TEMPLATE({
    generatedAt: new Date().toISOString(),
    scope,
    investigationCount: investigations.length,
    caseTitle: singleCase?.title ?? null,
    caseLocation: singleCase?.location_name ?? null,
    caseId: singleCase?.id ?? null,
    caseStatus: singleCase?.status ?? null,
    caseDisposition: singleCase?.disposition ?? null,
    leafCount: manifest.global_audit_chain.leaf_count,
    merkleRoot: manifest.global_audit_chain.merkle_root,
    verificationOk: manifest.global_audit_chain.verification.ok,
    verificationDetail: manifest.global_audit_chain.verification.ok
      ? ""
      : `seq ${manifest.global_audit_chain.verification.brokenAtSeq}: ${manifest.global_audit_chain.verification.reason}`,
    counts: {
      investigations: investigations.length,
      events: events.length,
      media: media.length,
      transcripts: transcripts.length,
    },
    aocAccepted: aoc.accepted,
    aocStatement: aoc.statement,
    reviewers: reviewerRows.map((r) => ({
      reviewerName: r.reviewer_name,
      discipline: r.discipline,
      affiliation: r.affiliation,
      signedAt: r.signed_at,
      appVersion: r.app_version,
      statement: r.statement,
      identifier: r.identifier,
      sourceUrl: r.source_url,
    })),
    readiness: {
      overall: readiness.overall,
      summary: readiness.summary,
      checks: readiness.checks,
    },
  });
  entries.push(textEntry("cover.html", coverHtml));

  const aocText = aoc.accepted && aoc.statement
    ? `Acknowledgement of Country\n` +
      `==========================\n\n` +
      `Accepted: yes\n` +
      `Accepted at: ${aoc.acceptedAt ?? "(unknown)"}\n\n` +
      `Statement\n---------\n\n${aoc.statement}\n`
    : `Acknowledgement of Country\n` +
      `==========================\n\n` +
      `The user of this device has not recorded an Acknowledgement of Country.\n` +
      `No statement is available for this case bundle.\n`;
  entries.push(textEntry("acknowledgement.txt", aocText));

  // 7. Per-investigation sensor baseline — first 5 minutes of samples.
  // Skipped when an investigation has no samples.
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  for (const inv of investigations) {
    const samples = await query<SensorSample>(
      "SELECT * FROM sensor_samples WHERE investigation_id = ? ORDER BY timestamp ASC",
      [inv.id],
    );
    if (samples.length === 0) continue;

    const startedAt = samples[0].timestamp;
    const startMs = Date.parse(startedAt);
    // If the first timestamp isn't parseable, fall back to including everything
    // (defensive — sensor writers should produce ISO-8601, but don't drop the
    // baseline file if one row is malformed).
    const baselineSamples = Number.isFinite(startMs)
      ? samples.filter((s) => {
          const t = Date.parse(s.timestamp);
          return !Number.isFinite(t) || (t - startMs) <= FIVE_MINUTES_MS;
        })
      : samples;
    const endedAt = baselineSamples[baselineSamples.length - 1].timestamp;

    entries.push(jsonEntry(`sensors/${inv.id}/baseline.json`, {
      investigation_id: inv.id,
      started_at: startedAt,
      ended_at: endedAt,
      sample_count: baselineSamples.length,
      samples: baselineSamples,
    }));
  }

  const blob = buildZip(entries);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = scope === "single"
    ? `southern-signal-case-${(investigationId ?? "").slice(0, 8)}-${stamp}.zip`
    : `southern-signal-bundle-${stamp}.zip`;

  return {
    blob,
    summary: {
      filename,
      byteLength: blob.size,
      entries: entries.length,
      mediaIncluded,
      mediaMissing,
      scope,
      investigationIds,
    },
  };
}

/** Trigger a browser download of the exported blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
