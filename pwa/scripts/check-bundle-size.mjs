#!/usr/bin/env node
/**
 * Bundle-size budget gate.
 *
 * Why this exists:
 *   The 12-specialist panel audit on 2026-05-19 got the main entry chunk
 *   from 335 KB → 211 KB (gzip 130 KB → 65.8 KB) by:
 *     1. Lazy-loading the Anthropic SDK behind a dynamic import so it
 *        only enters the graph on the BYOK dev path; production users
 *        hit the Cloudflare Pages Function proxy instead.
 *     2. Hoisting React + sqlite-wasm into their own manual chunks via
 *        vite.config.ts so a route edit can't bust the vendor cache.
 *   Without a budget, the next "let's just add zod / dayjs / lodash"
 *   PR can silently undo that win — the index chunk drifts back up,
 *   first-load TTI on a mid-tier phone regresses, and nobody notices
 *   until the next manual perf pass.
 *
 * Budget rationale:
 *   Current build (2026-05-19) ships index-*.js at ~67.4 KB gzipped.
 *   75 KB ≈ ~7.6 KB headroom, which is enough to absorb a small
 *   utility import or a route-graph reshuffle but not enough to hide
 *   pulling a heavyweight dep back into the main entry. If you find
 *   yourself wanting to bump the budget, first check whether the new
 *   code belongs in a route-lazy chunk (most things do).
 *
 *   SDK chunk assertion: the Anthropic SDK MUST stay in its own
 *   sdk-*.js chunk. If sdk-*.js disappears, the lazy-load contract is
 *   broken (someone almost certainly changed `import("@anthropic-ai/sdk")`
 *   to a static import, dragging ~125 KB raw / ~33 KB gz back into the
 *   index entry) — fail loudly.
 *
 * Usage:
 *   pnpm build            # produces pwa/dist
 *   pnpm check:bundle     # exits 0 on pass, 1 on bust
 *
 * Wired into CI in .github/workflows/deploy.yml between Type-check + build
 * and Run tests; blocks the deploy on bust (no continue-on-error).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distAssets = resolve(__dirname, "..", "dist", "assets");

// Budgets (bytes after gzip).
// 2026-05-22 Phase A.2 — VU meter + Spirit Box LCD + Ovilus LCD landed on the
// main entry (skeuomorphic gear-meter overhaul; see canvasCompositor.ts). The
// three meters are load-bearing on the camera surface — they can't be route-
// lazy because the compositor runs on every frame from start of recording.
// Combined cost (token reader extensions + drawVuMeter + drawSpiritBoxLcd +
// drawOvilusLcd + 7-segment / 5×7 pixel-font tables) is ~3 KB gzip, which
// pushed the index chunk from ~76 KB → ~77 KB. Budget bumped from 75 → 80 KB
// to absorb A.2 while still giving ~3 KB headroom for incidental growth.
//
// 2026-05-23 Phase B — Faux-IR filter + EMF galvanometer + PIR motion sense
// land on the main entry for the same reason as the A.2 meters: the
// compositor draws every frame, so the draw functions can't be route-lazy.
// Combined cost is ~2.3 KB gzip:
//   * Faux-IR filter   (~0.3 KB) — ctx.filter call + magenta wash + badge
//   * EMF galvanometer (~0.7 KB) — analog needle + arc-sweep tick marks
//   * PIR motion sense (~0.8 KB) — Fresnel dome + trigger LED with halo
//   * token-reader extensions + tokens themselves (~0.5 KB)
// That's enough to push the index chunk from 78.6 KB → 80.2 KB gzip,
// 242 bytes over the 80 KB budget. Optimised what was free to optimise
// (collapsed the silkscreen to one line, replaced an `lerpHex` helper
// with a translucent overlay, halved the Fresnel-arc count), then bumped
// the budget 80 → 85 KB so the next incidental utility doesn't bust it.
// ~4.6 KB headroom matches the same buffer A.2's bump targeted.
const INDEX_BUDGET_BYTES = 85 * 1024; // 87,040 bytes

function fail(msg) {
  process.stderr.write(`[31m[check-bundle-size] FAIL[0m ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`[32m[check-bundle-size] OK[0m   ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`[check-bundle-size]      ${msg}\n`);
}

let entries;
try {
  entries = readdirSync(distAssets);
} catch (err) {
  fail(
    `Could not read ${distAssets}: ${(err && err.message) || String(err)}.\n` +
      "Run `pnpm build` first — this script asserts against the production bundle.",
  );
}

const indexChunks = entries.filter((f) => /^index-[A-Za-z0-9_-]+\.js$/.test(f));
const sdkChunks = entries.filter((f) => /^sdk-[A-Za-z0-9_-]+\.js$/.test(f));

if (indexChunks.length === 0) {
  fail(`No index-*.js found in ${distAssets}. Did the build fail?`);
}
if (indexChunks.length > 1) {
  fail(
    `Multiple index-*.js chunks found (${indexChunks.join(", ")}). ` +
      "Vite's content-hash output should produce exactly one — check rolldownOptions.",
  );
}

if (sdkChunks.length === 0) {
  fail(
    "Anthropic SDK appears to have been re-bundled into the main entry — " +
      "expected dist/assets/sdk-*.js to exist as a lazy chunk.\n" +
      "Check that the BYOK path still uses `await import(\"@anthropic-ai/sdk\")`, " +
      "and that no module statically imports the SDK above the dynamic-import boundary.",
  );
}

const indexFile = indexChunks[0];
const indexPath = resolve(distAssets, indexFile);
const indexRaw = readFileSync(indexPath);
const indexGz = gzipSync(indexRaw);

const indexRawSize = statSync(indexPath).size;
const indexGzSize = indexGz.length;
const indexRawKB = (indexRawSize / 1024).toFixed(1);
const indexGzKB = (indexGzSize / 1024).toFixed(1);
const budgetKB = (INDEX_BUDGET_BYTES / 1024).toFixed(0);
const headroomBytes = INDEX_BUDGET_BYTES - indexGzSize;
const headroomKB = (headroomBytes / 1024).toFixed(1);

info(`index chunk:  ${indexFile}`);
info(`  raw:    ${indexRawSize} bytes (${indexRawKB} KB)`);
info(`  gzip:   ${indexGzSize} bytes (${indexGzKB} KB)`);
info(`  budget: ${INDEX_BUDGET_BYTES} bytes (${budgetKB} KB)`);

if (indexGzSize > INDEX_BUDGET_BYTES) {
  const overBytes = indexGzSize - INDEX_BUDGET_BYTES;
  fail(
    `index chunk is ${indexGzSize} bytes gzipped (${indexGzKB} KB), ` +
      `over the ${budgetKB} KB budget by ${overBytes} bytes.\n` +
      "Either move the new code into a route-lazy chunk (preferred — " +
      "see src/routes and the React.lazy boundaries) or, if the growth is " +
      "intentional, bump INDEX_BUDGET_BYTES in this script with a comment " +
      "explaining why.",
  );
}

ok(`index ${indexGzKB} KB / ${budgetKB} KB gzip (${headroomKB} KB headroom)`);

// SDK chunk size is informational — we only assert it exists.
const sdkFile = sdkChunks[0];
const sdkPath = resolve(distAssets, sdkFile);
const sdkRaw = readFileSync(sdkPath);
const sdkGz = gzipSync(sdkRaw);
info(
  `sdk chunk:    ${sdkFile} (raw ${(sdkRaw.length / 1024).toFixed(1)} KB, ` +
    `gzip ${(sdkGz.length / 1024).toFixed(1)} KB) — kept out of main entry`,
);

process.exit(0);
