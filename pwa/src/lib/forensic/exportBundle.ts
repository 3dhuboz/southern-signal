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
import { buildZip, jsonEntry, textEntry, type ZipEntry } from "./zip";
import type { AuditLogEntry, EvidenceEvent, Investigation, MediaAsset, SensorSample } from "../db/schema";

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
