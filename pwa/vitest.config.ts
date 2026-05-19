import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// ---------------------------------------------------------------------------
// Dedicated Vitest config.
//
// vite.config.ts intentionally has no `test:` block — its build plugins
// (sqliteWasmUnhashedCopy, swVersionInject) only need to fire under `vite
// build`, and shipping them into the test runner inflates the import graph
// for no benefit. Vitest auto-loads this file ahead of vite.config so the
// two stay decoupled.
//
// Two-environment strategy:
//   • `node`     (default) — all *.test.ts run as plain Node modules. Fast,
//     no DOM. The forensic, db, audio, posterior, etc. tests all live here.
//   • `happy-dom` (per-file) — *.test.tsx files opt in via the
//     environmentMatchGlobs entry below. happy-dom is dramatically cheaper
//     than jsdom and covers everything the view smoke tests actually touch
//     (queries, events, refs). If a missing API ever bites, mock it in the
//     specific test rather than upgrading the whole suite to jsdom.
//
// `setupFiles` only runs for the happy-dom files — gated by the glob —
// because @testing-library/jest-dom's matchers reach into the DOM, which
// doesn't exist in the node env.
// ---------------------------------------------------------------------------

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    environmentMatchGlobs: [
      ["src/**/*.test.tsx", "happy-dom"],
    ],
    setupFiles: ["./vitest.setup.ts"],
    globals: false,
  },
});
