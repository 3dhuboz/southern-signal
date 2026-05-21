# Southern Signal Handover

Date: 2026-05-21 (replaces the 2026-05-08 FastAPI-era doc)

## Read this first

The product architecture pivoted on 2026-05-08 from a FastAPI/Raspberry-Pi-first design to a **mobile-only PWA**. If you're reading an older handover that talks about uvicorn, `pi-hub/app/main.py`, or `http://127.0.0.1:8000` as the primary surface, that document is stale. The Pi codebase still exists, but it has been demoted to an optional accessory for users who own a Pi 5 + Sense HAT.

## Current architecture

V1 = a phone-first, mobile-only PWA. The phone is the entire product.

| Layer            | Tech                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Build / app      | Vite 8 + React 19 + TypeScript 6                                                              |
| UI               | Radix UI primitives + plain CSS variables + CSS modules (no Tailwind)                         |
| Storage          | sqlite-wasm 3.53 with OPFS VFS (worker API, not Worker1/Promiser1) + sqlite-vec               |
| Audio            | AudioWorklet streaming 16 kHz PCM mono to OPFS via `FileSystemSyncAccessHandle`               |
| On-device AI     | Whisper-base.en WASM (~57 MB), Silero VAD (~2 MB), RNNoise (~1 MB), bge-small-en-v1.5 (~130 MB) |
| Cloud AI (opt-in)| Sonnet 4.6 / Haiku 4.5 / Gemini / OpenAI via user-supplied API keys; Steve never holds keys   |
| Package manager  | pnpm 9.15.4; Node >= 20                                                                       |

The PWA lives in `pwa/` in this repo. The repo also contains `pi-hub/` (FastAPI accessory, post-V1) and `docs/`.

## Deploy pipeline

- **Cloudflare Pages project:** `southern-signal` (account `6700423b76671a05d196916b43410458`).
- **No GitHub provider connection.** Deploys are pushed via `wrangler pages deploy` from CI/CD, not auto-built by Cloudflare from GitHub commits.
- The Pages project's Production branch is currently `main`, but the GitHub repo's default branch is `master`. Deploys against `master`/`dev` land in the Preview environment. The last actual Production deploy was a week ago on `main`. This is a known mismatch to resolve — either point the Pages project's Production branch at `master`, or rename `master` to `main` everywhere, or push specifically to a `main` branch when promoting.
- Public preview URL pattern: `https://<deploy-id>.southern-signal.pages.dev`. Apex is `southern-signal.pages.dev`.

## Codebase reconciliation

There is a parallel Expo / React Native scaffold at `C:\Users\Steve\Desktop\GitHub\ghost-app-feasibility\app\` (Expo 54 + RN 0.76 from 2026-04-26). **That scaffold is pre-pivot and abandoned.** It is not the path forward. Do not import code from it, do not commit to it, and do not delete it in passing — Steve will decide whether to archive or remove it explicitly.

## V1 punch-list (build order, ~6–8 weeks calendar)

1. PWA shell — Vite + React + Radix, manifest, icons, splashes, vanilla service worker, `display: standalone`.
2. OPFS infrastructure — typed wrapper, `FileSystemSyncAccessHandle` WAV writer, model fetch + cache.
3. sqlite-wasm + schema (cases / sessions / markers / sensor_samples / transcripts / embeddings / contamination / photos / audio_segments). Port `analysis/calibration.py` math from `pi-hub/`.
4. Sensor permission + capture pipeline — `DeviceMotionEvent.requestPermission()` flow, AudioWorklet @ 16 kHz PCM, geolocation, DeviceOrientation, Magnetometer (Android only — feature-detect).
5. Real-tools v1: EMF (Android) / compass-anomaly (iOS), vibration detector, ambient-light fallback (camera mean-luminance), GPS-pin markers.
6. EVP recorder + Whisper-base.en WASM with Silero VAD gating. Foreground-only on iOS, document loudly.
7. Spirit-box (curated phoneme bank, **explicitly not a radio sweep**) + Ovilus word generator (sensor-entropy seeded).
8. Spectrogram review UI — click-to-mark, on-device Whisper transcript indexed to file offsets.
9. Embeddings + sqlite-vec semantic search across notes/transcripts (bge-small-en-v1.5).
10. Cloud AI router with privacy guardrails — user-supplied keys; hard-coded refusal at the router layer (not UI layer) for cases flagged `culturallySensitive: true`. Question generator + auto-debunker + report writer atop Sonnet 4.6.
11. Floorplan sketcher + marker projection (Canvas only, no maps API).
12. Optional Pi sync endpoint — single REST POST that accepts a signed `bundle.zip`; trim existing FastAPI to this one route, archive the rest.

## Hard constraints (don't quietly drift on any of these)

- **No whitelabel.** Constraint #123 on the working task list. Southern Signal is one product with one brand. Don't add tenant theming, multi-org config, or "configurable for partners" abstractions.
- **8 hard-coded disclaimers** stay (Site Posterior Bar premiere headline doc). They live in code, not config, and they ship on-screen.
- **Site Posterior Bar replaces Adversarial Hypothesis Tournament.** ASI replaces DOA — sectors, not degrees.
- **External Bayesian + acoustician must sign off pre-air.** Wave 1 outreach drafts exist for Drovandi, Grant, Cabrera, Howard, Biddle.
- **Default UI = Simple mode.** Pro toggle gates the math, the priors, and the raw forensic detail. Amateur audience matters.
- **Remove the YEP The Boys logo** anywhere it appears until the partnership is actually signed.
- **Cultural-sensitivity gate is fail-closed at the AI router layer.** UI cannot override it.
- **iOS PWA constraints — non-negotiable:**
  - No Web Bluetooth on iOS, ever. No K-II / REM-pod / BLE sensors on iPhone.
  - No raw Magnetometer on iOS — only `webkitCompassHeading` (filtered compass derivative). Label honestly; don't conflate with the Android EMF tool.
  - JS context is suspended when backgrounded. Continuous background recording is impossible; UX must say "screen must stay unlocked during a session."
  - Wake Lock API is broken in installed iOS PWAs (WebKit bug 254545). The screen will dim.
  - OPFS storage realistically caps at ~1–4 GiB. Implement quota-warning UX at 80%.
  - No Vibration API, no Battery API, no Network Info API on iOS. Degrade gracefully.
  - WebGPU only on iOS 26+. Pre-26 iOS = WASM-only fallback (Phi-3-mini works, Llama 8B does not).
  - `beforeinstallprompt` does not fire on iOS — user must tap Share → Add to Home Screen. Ship a one-time tutorial.

## Recent work shipped (representative, not exhaustive)

- Broadcast HUD components: `BroadcastBug`, `BroadcastAudioMeter`, `BroadcastTimestamp`, `BroadcastSensorHud`, `BroadcastSceneSelector`, `BroadcastLowerThird`, `BroadcastPreview`.
- `CameraScreen` no-video state machine pinned with tests; bottom action row + SCENES + cog layout redesigned.
- `MissionControl` Simple/Pro presentation mode toggle.
- DB v14 — FK enforcement + transactions.
- Auth on `/api/ai/*` Pages Functions; cultural-sensitivity fail-closed gate.
- Adversarial test suite: `forensic-verifier`, `audit-toctou`, `ai-relay-auth`, `cultural-sensitivity`, `schema-fk`.
- Pi 5 HDMI kiosk at `/broadcast/chrome` (Pi as broadcast accessory, not primary product).
- Math PDF skeleton for reviewer outreach attachments.

## Open items to triage

- Reviewer outreach Wave 1 — drafts exist for Drovandi, Grant, Cabrera, Howard, Biddle; not yet sent.
- Math PDF — skeleton only; needs real content before the next wave of outreach.
- Cloudflare Pages branch mismatch — the Production branch on the Pages project is `main` but development happens on `master`/`dev`. Either reconfigure Pages or change the deploy target.
- `ghost-app-feasibility/app/` — pre-pivot RN scaffold; keep-or-archive decision pending.
- PR #143 on `3dhuboz/SocialAI-Studio` (`claude/keen-vaughan-e42cc6`) was in `CONFLICTING` / `DIRTY` state as of 2026-05-21 — not Southern Signal but tracked here because it shares the SocialAI Cloudflare account.

## Workspace pointers

- Repo: `3dhuboz/southern-signal` (public, TypeScript, default branch `master`).
- Local clone: `C:\Users\Steve\Documents\Codex\2026-05-07\so-i-ve-always-wanted-to`.
- PWA: `pwa/` (Vite + React + sqlite-wasm).
- Pi accessory (post-V1, demoted): `pi-hub/` (FastAPI + Sense HAT).
- Branches `master` and `dev` were in sync at `63dac21` as of 2026-05-21.

---

Last updated 2026-05-21 by Steve via Claude.
