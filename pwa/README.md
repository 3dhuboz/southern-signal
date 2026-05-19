# Southern Signal

A phone-first paranormal investigation tool that fuses sensor data, transparent
statistics, and on-device storage into a record a hostile reviewer can verify.

Deployed as a PWA at [southern-signal.pages.dev](https://southern-signal.pages.dev).

The premise: most "ghost hunting" apps surface a vibe meter and call it a day.
Southern Signal accumulates evidence in a Bayesian posterior with bounded
likelihood ratios per channel, runs an Adversarial Hypothesis Tournament (AHT)
against the AI's best mundane explanations, hash-chains every state change,
and ships a Merkle-rooted export that anyone can re-verify offline. The
strongest possible verdict is **UNEXPLAINED** — never "confirmed paranormal."
That's a hard-coded floor in `lib/posterior/ahtVerdict.ts`, not a tuning knob.

## What it actually does

- **Live posterior, not a vibe meter.** Each channel (acoustic, infrasound,
  magnetometer, cross-channel coupling) emits a bounded log likelihood ratio
  (`|log LR| ≤ 4` per increment, so a chatty channel can't pile-on). The
  posterior is the prior compounded by every LR, decayed back toward the prior
  between events on a 20-minute time constant.
- **Site-baseline-aware likelihoods.** A 90 s / 5 min / 10 min "empty room"
  capture runs before each session. The acoustic and magnetometer LR functions
  refuse readings within the captured site noise floor — they only fire on
  real anomalies above the operator's measured baseline. A "novelty bonus"
  fires when a reading exceeds anything observed during baseline.
- **Sector-accurate acoustic direction (±60°).** A 3-of-3 calibration ritual
  locks an SRP-PHAT-ish stereo cross-correlation to six sectors. Anything
  more precise would be theatre on phone-grade mics.
- **Hash-chained audit log.** Every posterior update, marker, contamination
  tag, AI debunk, disposition, and acknowledgement is appended with
  `entry_hash = sha256(seq | ts | actor | kind | canonical-json(payload) | prev_hash)`.
  Edits are new entries that reference the prior `seq`; the original is never
  updated. `verifyAuditChain()` walks the chain on demand.
- **AHT post-roll verdict.** When the AI debunker keeps failing to find
  plausible mundane explanations, that's a *model* limitation, never evidence
  of the paranormal. H₀ confidence = mean(1 − max-plausibility) over the 30
  most-recent debunk requests; when H₀ ≥ 0.4, every case renders
  INCONCLUSIVE rather than any positive verdict.
- **TV-grade live broadcast.** Camera + mic + sensor overlays composited at
  30 fps to a single canvas, then either (a) recorded to OPFS with a
  per-frame ISO timestamp baked in, or (b) pushed live via WHIP to
  Cloudflare Stream / Mux / Restream / Dolby / Eyevinn / a custom endpoint.
  Includes a one-click Cloudflare → Facebook Live relay setup.
- **Forensic export bundle.** A single `.zip` containing the audit chain as
  JSONL, all media binaries, a printable cover sheet, and a drop-in
  `verify.html` any reviewer can open offline.

## Two modes, one set of data

| Mode    | Audience                | Surface                                                                                          |
|---------|-------------------------|--------------------------------------------------------------------------------------------------|
| Simple  | Amateurs, first-timers  | Plain-English event feed; one big Begin / End button; activity dial without exposed math.        |
| Pro     | Serious operators       | Posterior bar, log-LR per channel, Merkle root, calibration ritual, Estes dual-phone, bait tone. |

Toggle in the header. Identical data captured either way; only the
presentation changes.

## Privacy posture

- **On-device first.** SQLite-WASM in OPFS. Sensors, audio, video, and the
  audit chain all stay on the phone unless the operator opts into cloud sync.
- **Cloud AI is opt-in and gated.** A cultural-sensitivity flag (per-case OR
  device-wide) hard-blocks all cloud AI calls and all sync uploads at
  enqueue time. No exceptions. Audit chain still records locally — chain
  integrity matters even when nothing leaves the device.
- **Acknowledgement of Country gate.** First-launch ethical floor. The
  acknowledgement appears on every exported case report and is logged to the
  audit chain.
- **No analytics, no telemetry, no third-party JS.** First-party only.

## Architecture

- **Vite + React 19 + TypeScript.**
- **Storage:** SQLite via `@sqlite.org/sqlite-wasm` in OPFS. One DB per device.
  Schema lives in `src/lib/db/schema.ts`.
- **Audio capture:** AudioWorklet (with ScriptProcessorNode fallback) →
  Float32 chunks → WAV in OPFS. iOS Wake Lock held while a session is live so
  AudioContext doesn't suspend on screen sleep.
- **Live stream:** OffscreenCanvas-style compositor draws video frames +
  overlay state at 30 fps, then either MediaRecorder→OPFS or WHIP via WebRTC.
- **Cloud AI:** A Cloudflare Pages Function at `/api/ai/chat` proxies to
  OpenRouter (Sonnet by default). The OPENROUTER_API_KEY lives as a Pages
  environment secret — end users never see it. BYOK Anthropic SDK path is
  preserved as a developer escape hatch.
- **Cloud transcription:** A Cloudflare Pages Function at `/api/ai/transcribe`
  proxies to Whisper (server-side). Gated by the cultural-sensitivity flag.
- **On-device transcription:** Whisper-tiny.en (~40 MB) runs in a Web Worker
  via `@huggingface/transformers`. Opt-in from Setup → "On-device
  transcription" → "Download model"; the model caches on the browser side
  and subsequent loads are instant. EvpEditor surfaces a parallel
  "Transcribe (on-device)" button alongside the cloud one. Audio never
  leaves the device on this path — the cultural-sensitivity flag is moot
  because there's nothing to gate. A "Test pipeline" button in Setup
  round-trips a synthetic clip through the worker so operators can
  validate the wiring before recording. Worker entry:
  `src/workers/whisperTranscribe.worker.ts`. API:
  `src/lib/audio/localTranscribe.ts`.
- **Sync:** Append-only `sync_queue` table; a worker drains it to a Pages
  Function backed by R2 (media blobs) + D1 (rows). Idempotent at the server
  via `INSERT OR IGNORE`. Failed rows back off exponentially.
- **Forensic export:** `lib/forensic/manifest.ts` builds a Merkle tree over
  audit-chain entries; `lib/forensic/zip.ts` packages everything plus
  `verify.html`.

## Standing disclaimers

Eight ethical-floor disclaimers live in the UI and are part of every export.
They are not editable from the operator surface; only Pull Requests change
them.

1. *"AI proposes; you decide. Activity readings come from the phone's mic
   and sensors — they're not proof of anything supernatural."* (`SimpleMissionView`)
2. *"Sector accuracy ±60°. Posterior is a model estimate, not a measurement
   of presence. Every increment is hash-chained."* (`MissionControl` Pro)
3. *"Posterior is a model estimate. It does not measure presence."*
   (`PosteriorBar`)
4. *"AI proposes; the investigator decides. AI never claims to hear voices
   or see ghosts. Every call hash-chained."* (`AiAssistant`)
5. Phone speakers cannot reproduce the SPL-coupled physiological effects
   from the Tandy / NASA infrasound literature. Treat as a *timed marker*
   in the audit chain — not a causal stimulator. (`BaitToneTool`)
6. *"All saves are appended to the audit chain — original recording is
   never altered."* (`EvpEditor`)
7. H₀ "AI insufficiency" — when the AI can't generate plausible mundane
   explanations, that's a model limitation, not evidence of the paranormal.
   At H₀ ≥ 0.4 the post-roll renders INCONCLUSIVE. (`Review`)
8. AHT eliminates explanations; it does not confirm causes. The strongest
   positive verdict is UNEXPLAINED. (`Review`, `EvidenceBrief`)

## External review

V1 ships with a public commitment: before any TV-grade premiere using this
tool, an external Bayesian and an external acoustician will sign off on the
methodology. Reviewer shortlist is private until contact is made; the
sign-off itself is published with the release.

## Known limitations

- **iOS 17+ is the minimum.** The forensic Export Bundle and every signed
  AI call (`/api/ai/*`) use WebCrypto Ed25519 to sign requests with a
  hardware-bound, non-extractable key (`lib/forensic/signingKeyStore.ts`).
  Apple shipped Ed25519 in iOS / iPadOS / Safari 17 (September 2023); on
  iOS 16.x or earlier `crypto.subtle.generateKey({ name: "Ed25519" }, …)`
  throws a `NotSupportedError`. The app boots a preflight probe
  (`lib/forensic/cryptoSupport.ts`) and surfaces a persistent banner plus
  disabled Export Bundle / AI Assist buttons when the runtime is too old.
  Review, Camera, About, and the rest of the app stay browsable. We
  deliberately do not polyfill — a JS Ed25519 implementation would have
  to extract the private key into JS memory, defeating the
  non-extractable contract that gives the forensic chain its value.
  Recent Chromium (Chrome 113+, Edge 113+) and Firefox (130+) all
  support Ed25519 natively.

## Development

```bash
pnpm install
pnpm dev           # Vite dev server
pnpm test          # vitest run (one-shot)
pnpm test:watch    # vitest watch
pnpm build         # tsc -b && vite build
pnpm lint
pnpm check:bundle  # bundle-size budget gate (run after `pnpm build`)
```

Tests run fully on Node — no browser. Vitest 4 with `vi.hoisted` for module
mocks. The audio / video / WHIP layers are not unit-tested (they need a real
browser); everything pure (likelihoods, posterior, baseline math, audit
chain, forensic helpers, AHT verdict) is covered.

**Bundle budget.** The main entry chunk is budgeted at **75 KB gzipped**
(currently 65.8 KB, ~9 KB headroom). The `pnpm check:bundle` script reads
`dist/assets/index-*.js`, gzips it, and exits 1 if it crosses the budget;
CI runs it after `pnpm build` and blocks the deploy on bust. The script
also asserts that the Anthropic SDK stays in its own `sdk-*.js` lazy
chunk — the panel work to lazy-load it (335 KB → 211 KB raw) is a
load-bearing perf win we don't want a static-import slip to undo
silently. Budget rationale lives in
[`scripts/check-bundle-size.mjs`](scripts/check-bundle-size.mjs).

## Deployment

Cloudflare Pages. `master` is the production branch. CI build = `npm run
build`; output is `dist/`. Pages Functions live in `functions/` (proxy to
OpenRouter for AI, R2 for media bytes, D1 for rows).

Required Pages environment variables:

| Name                       | Where it's used                              | Required if…                                                          |
|----------------------------|----------------------------------------------|------------------------------------------------------------------------|
| `OPENROUTER_API_KEY`       | `/api/ai/chat`                               | AI assist (questions, debunker) is enabled. **Not used for audio.**    |
| `GROQ_API_KEY`             | `/api/ai/transcribe`                         | Cloud transcription via Groq's Whisper-large-v3-turbo (fast, generous free tier). Preferred. |
| `OPENAI_API_KEY`           | `/api/ai/transcribe`                         | Cloud transcription via OpenAI Whisper-1 directly. Used if `GROQ_API_KEY` is unset. |
| `SYNC_TOKEN`               | `/api/sync/upload`                           | Cloud sync enabled.                                                    |
| `ALLOW_OPENROUTER_AUDIO`   | `/api/ai/transcribe`                         | `1` to opt back into the OpenRouter audio path. **Currently broken** — OpenRouter's gateway JSON-parses the multipart body and returns 400. Use Groq or OpenAI instead. |
| `CF_ACCOUNT_ID`       | `/api/live/fb/connect`                       | Facebook Live one-click setup is used.    |
| `CF_STREAM_API_TOKEN` | `/api/live/fb/connect`                       | Same.                                     |
| `FB_CONNECT_TOKEN`    | `/api/live/fb/connect`                       | Same.                                     |
| `TROVE_API_KEY`       | `/api/community/incidents-in-area`           | Community-map area incident search uses Trove (NLA digitised newspapers) in parallel with Sonar. Free key at https://trove.nla.gov.au/about/create-something/using-api/api-keys (instant signup). Optional — Sonar-only path still works without it. |
| `AI_RELAY_ALLOW_UNSIGNED` | `/api/ai/*` (all relay endpoints) | **Leave unset for production.** All `/api/ai/*` endpoints default to **fail-closed** — the client must sign every POST with its hardware-bound Ed25519 key (`X-SS-Pubkey` / `X-SS-Timestamp` / `X-SS-Signature` headers); unsigned requests get a 401. Set to `1` only as a temporary rollout escape hatch if old PWA installs without the signing client are still in the field. A `console.warn` fires on every request while permissive mode is on so the slip-up is visible in `wrangler tail`. Unset to restore strict mode. |
| `AI_RELAY_REQUIRE_SIGNED` | `/api/ai/*` (all relay endpoints) | **Legacy flag.** Older deployments used this to flip the bit; semantics inverted on 2026-05-19. `=1` is a no-op (same as default strict); `=0` maps to permissive (equivalent to `AI_RELAY_ALLOW_UNSIGNED=1`). Kept so a Cloudflare Pages env that still has it set to `0` doesn't suddenly start rejecting traffic without an operator-visible warning. New deployments should set `AI_RELAY_ALLOW_UNSIGNED` instead. |

### AI relay signing — operator quick reference

- **Production (recommended):** leave both `AI_RELAY_ALLOW_UNSIGNED` and
  `AI_RELAY_REQUIRE_SIGNED` **unset**. The relay rejects every unsigned
  `POST /api/ai/*` with a 401 and a JSON detail explaining the missing
  headers. Signed POSTs from the PWA pass through normally; per-pubkey
  rate limits still apply.
- **Rollout window:** if you cut the strict-mode deploy live and there
  are still PWA installs in the field on a build that doesn't have the
  signing client, set `AI_RELAY_ALLOW_UNSIGNED=1` for a short window.
  The relay then accepts unsigned requests AND continues to verify
  signed ones — `wrangler tail` will log a permissive-mode warning on
  every request. Unset the flag as soon as the field has rolled forward.
- **Legacy compat:** `AI_RELAY_REQUIRE_SIGNED=0` still works as a
  synonym for permissive. Prefer renaming to `AI_RELAY_ALLOW_UNSIGNED`
  on the next env edit so the active default matches the variable name.

Required Pages bindings (D1, KV, R2 — set in `wrangler.jsonc` or the
dashboard):

| Binding            | Type | Where it's used                                       |
|--------------------|------|-------------------------------------------------------|
| `SYNC_DB`          | D1   | `/api/sync/upload` mirror tables                      |
| `MEDIA_BUCKET`     | R2   | `/api/sync/upload` blob storage                       |
| `AI_RATE_LIMIT`    | KV   | Per-IP soft cap shared across AI Investigator + community/incidents-in-area |
| `AI_RATE_LIMIT_SALT` | secret | KV-key IP-hash salt (set via `wrangler pages secret put`) |
| `COMMUNITY_DB`     | D1   | `/api/community/sites` (pins) + `area_incident_cache` (AI-surfaced incidents) |

Local dev needs none of those — the operator surface degrades cleanly when
they're unset (e.g. AI assist shows a "proxy not configured" error).

## Status

- V1 capture pipeline: working.
- AHT post-roll verdict: surfaced on SessionSummaryCard, Review (latest case
  + engine status), and the printable Evidence Brief.
- Cloud transcription: working (gated by cultural-sensitivity flag).
- **On-device transcription: working** (Whisper-tiny.en via
  `@huggingface/transformers`, opt-in from Setup, self-test included).
- 53 test files / 735 tests (as of 2026-05-19) covering forensic
  substrate, posterior math, baseline-aware likelihoods, AHT verdict
  logic, Evidence Brief assembly, WAV resample, sync-queue
  cultural-sensitivity gating, audit-chain verification, sessionBaseline
  persistence, plain-English translators, liveNarrator templates,
  localTranscribe worker plumbing, and adversarial fuzzing of the
  forensic verifier, audit TOCTOU, AI-relay auth, cultural-sensitivity
  gate, and schema-FK enforcement paths.

## License

Source-available; license terms TBD. Don't redistribute without permission
until the LICENSE file lands.
