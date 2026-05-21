# Southern Signal Customer-Readiness Audit

Date: 2026-05-22
Branch: `claude/customer-readiness-pass`
Baseline at start: build OK, tests OK (857 passing), lint OK, typecheck OK
(after vitest pin to 3.2.4 — see fix in commit 23d898d).

## Methodology

Sequential audit by the single Team-Lead agent (no parallel-Agent tool was
available in this session). Eight discipline lenses applied to the same
codebase, then consolidated into the punch list below.

## Findings

### P0 — Customer-blocking

**P0-1 — "Entertainment-only" label is missing entirely.**
Hard constraint #3 requires an Entertainment-only label at the render layer
of every Case Card / session screen. `grep -rni entertainment src/` returns
zero matches. This is the most prominent legal/ethical posture for a
paranormal tool selling to general consumers; shipping without it exposes
Southern Signal to "we promised real ghost detection" complaints.

Required: a small, fixed-position render-layer banner that ships from a
module-load-time constant and renders on the camera/session screens. Not
behind a setting.

**P0-2 — 8 hard-coded disclaimers aren't centralised at module load.**
Hard constraint #2 says disclaimers must "ship at module load (cannot be
removed at runtime)". Today the canonical sentences are pinned by the
`disclaimer-copy.smoke.test.tsx` source-text grep across 8 separate
component files. That works as a regression guard but the disclaimers
themselves are scattered string literals — there is no single
`DISCLAIMERS` module-load array that the renderer reads.

Risk: a future component-level refactor that moves text into props or a
conditional render can silently delete a disclaimer at runtime while the
source-grep test still passes (because the string is still present).

Required: a centralised `src/lib/legal/disclaimers.ts` `const STANDING_DISCLAIMERS`
frozen array exported at module load + a render-time assertion (or test)
that the renderer iterates from that array, not from hand-typed strings.

**P0-3 — OPFS 80% quota warning threshold isn't wired.**
Hard constraint #7 says "OPFS quota warning at 80%". Today `AppHeader.tsx`
uses `STORAGE_DANGER_FREE_MB = 500` — fires only when free space < 500 MB
absolute, not at 80% used. On a iPhone with ~1.5 GiB OPFS quota a user can
fill to 99% before the pill turns red.

Required: re-add the 80% threshold logic in `AppHeader.tsx` so the storage
pill goes red at `storageUsedPct >= 80`.

### P1 — Ship-blocker for v1

**P1-1 — `CameraScreen.tsx` at 1870 lines + 935 CSS is unmaintainable.**
The file mixes: camera lifecycle, EVP recorder control, sector-indicator
sub-display, posterior live narrator, marker picker, scene picker, dock
controls, install prompt, watchdog snooze, wake-lock management, baseline
loader, and 12 other concerns. Steve flagged it as "horrible." Even with
no immediate bugs, the file is a footgun for every future change.

This is a P1 (not P0) because the file currently works — but it's the
single biggest blocker to making safe customer-facing fixes. Proposed:
extract sub-views to `src/views/camera/*` and dedicated hooks. Out of
scope for this single-agent customer-readiness pass; defer to a follow-up
worktree.

**P1-2 — `Review.tsx` at 1710 lines suffers the same bloat.** Same
diagnosis as P1-1. Defer extraction; not customer-blocking.

**P1-3 — `Setup.tsx` at 1168 lines.** Same diagnosis. Defer extraction.

**P1-4 — Google Fonts loaded over network from `global.css`.**
`@import url("https://fonts.googleapis.com/css2?...")` is the second
import in `src/styles/global.css`. This:
- Breaks the offline-first promise (constraint: "PWA must keep working
  in a basement at 2am with no signal").
- Issues 1+ outgoing HTTP requests on every cold app launch.
- Is a CSP friction point if/when CSP is added.

Required: self-host the three font families locally as `.woff2` in
`/public/fonts/` and reference them with `@font-face` in `global.css`.
Or remove the families entirely and fall back to system-ui where the
brand allows.

**P1-5 — No CSP header set on `_headers`.**
The Cloudflare Pages `_headers` file sets nosniff / referrer-policy /
HSTS / Permissions-Policy / frame-options-deny — but no
`Content-Security-Policy`. For a PWA that handles audio recordings + AI
keys + signed bundles, a CSP is table stakes.

Recommended: add a minimal `Content-Security-Policy` baseline that
allows `'self'`, the WHIP ingest endpoints, and the OpenRouter proxy,
disallows `'unsafe-inline'` for scripts, and reports violations to a
report-only endpoint. Note: this MUST be paired with self-hosted
fonts (P1-4) or fonts.googleapis will be blocked.

**P1-6 — Bundle main entry chunk is 224 KB (71 KB gzip).** Reasonable for
the surface area but worth flagging — `index-DwHorjq8.js` + `react-DvOzSq0X.js`
(231 KB / 74 KB gzip) gives a cold-load JS payload of ~145 KB gzip before
any case is opened. On a 3G connection in a haunted basement, that's a
4-second time-to-interactive penalty.

Defer to a separate perf pass; not customer-blocking.

### P2 — Nice-to-have

- **P2-1** — The 5 onboarding tour steps don't include an iOS install-funnel
  step. The Setup view has the install card (good), but a first-launch user
  on iOS Safari won't know to go to Setup before installing.
- **P2-2** — `SOUTHERN_SIGNAL_HANDOVER.md` line 29 says the Cloudflare Pages
  Production branch is `main` but the repo's working branch is `dev`. Out
  of scope for code; flagged for Steve's manual fix.
- **P2-3** — `pi-hub/` is post-V1 and untouched in this pass.
- **P2-4** — The "BAT" / "DSK" / "REC" / "LIVE" pills in AppHeader use mono
  uppercase abbreviations. Steve's earlier "SCR was horrible" complaint
  was already resolved in CameraScreen (the dock now uses full words —
  "Scenes" / "Clip" / "Torch" / "Rear" / "Front"), but the AppHeader still
  uses the abbreviation style. Defensible (chrome must stay compact) but
  worth a separate UX pass.

## What's CLEAN (verified in this audit)

- **Cultural-sensitivity fail-closed gate** at `cloudAi.ts:69-127`
  — `ensureRoutable` checks DB → ctx flag → global pref, fail-closed on
  every uncertainty. Tests cover this. ✅
- **Country Acknowledgement Gate** at `AcknowledgementGate.tsx` — blocking
  modal with focus-trap, audit-chain append on accept. ✅
- **No YEP The Boys logo/chip/watermark.** Only references are a placeholder
  string in `About.tsx:293` (team-name input example) and a code comment in
  `BroadcastPreview.tsx:15`. No rendered chip on AppHeader or
  MissionControl. ✅
- **Acoustic Sector Indicator (ASI) renders sectors, not degrees** at
  `AcousticSectorIndicator.tsx:6` (comment confirms; code uses
  FRONT-L/C/R / REAR-L/C/R labels exclusively). ✅
- **Honest tool copy**: Spirit Box explicitly says "curated phonemes seeded
  by sensor entropy. Not a radio sweep" at `SpiritBoxTool.tsx:234`. EVP
  editor honest about Whisper-on-device. AI router says "AI proposes; the
  investigator decides." ✅
- **WebCrypto-only forensic chain** — Ed25519 probed at mount via
  `App.tsx:84` → `probeEd25519Support()`. CryptoUnsupportedBanner surfaces
  failure-mode. Manifest + audit-log + RFC 6962 Merkle root all in
  `src/lib/forensic/`. ✅
- **iOS install card in Setup** (`Setup.tsx:1131`) — renders correct copy
  for iOS-manual flow. ✅
- **Pro-mode toggle** via `ExperienceToggle.tsx` + `usePresentationMode.ts`.
  ✅
- **857 passing tests** including 6 adversarial security suites
  (cultural-sensitivity, audit-toctou, ai-relay-auth, forensic-verifier,
  schema-fk, disclaimer-copy). ✅
- **TypeCheck + Lint + Build all pass.** ✅

## Decisions on what to fix vs defer in THIS pass

### Will fix in this pass
- P0-1: ship the Entertainment-only render-layer label as a small,
  always-on banner driven by a module-load constant. Wire it into the
  CameraScreen surface and the MissionControl surface.
- P0-2: extract `STANDING_DISCLAIMERS` to a `src/lib/legal/disclaimers.ts`
  module-load array, leave the existing scattered renderings in place
  (they're already pinned by tests), and add an exported helper that
  components can use to render the full set.
- P0-3: wire the 80% storageUsedPct danger threshold in AppHeader so the
  pill turns red at the right threshold.
- P1-4: self-host the three Google Fonts families locally so the
  `https://fonts.googleapis.com` external load goes away.
- P2-1: add an iOS install-funnel step to the OnboardingTour (small
  conditional step shown only when `usePwaInstall().kind === "ios-manual"`).

### Defer to a separate pass (human judgment / breaking)
- **P0/P1**: large-file extraction (P1-1, P1-2, P1-3) — these are
  multi-thousand-line refactors that require deep familiarity with the
  state machines inside each view; out of scope for a single
  customer-readiness pass.
- **CSP** (P1-5) — requires testing every external integration (WHIP
  endpoints, OpenRouter proxy, HuggingFace model fetch, Anthropic SDK
  fallback path); too risky to ship in a single PR without a dedicated
  test pass. Will document as the next-pass deliverable.
- **Bundle perf** (P1-6) — needs profiling under realistic field
  conditions; out of scope.

