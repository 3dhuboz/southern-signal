# Southern Signal — Dev Map

**Last updated:** 2026-05-16 (strategy pivot: streaming-first product. Floorplan cut, MissionControl demoted to `/lab`, overlay-plugin registry + Scenes architecture, HuntSetup pre-flight picker, dock collapsed to a single scene chip)  
**Schema version:** 14  
**Stack:** React 19 · Vite · TypeScript · SQLite-wasm (OPFS) · CSS Modules

Maintain this file whenever you add a new domain, rename a key module, or shift a major pattern. It is the fastest way to orient a new contributor or resume after a context break.

---

## 1. What the app is

A **phone-first paranormal investigation PWA** — and a **self-contained broadcast rig**. Investigators no longer need to carry a second camera to film their tools. The phone sits on a tripod, its rear camera captures the scene, its torch lights it, and the compositor burns all sensor/Bayesian/ITC overlays into the live frame. One tap to record; one tap to go live to YouTube/Twitch/Facebook via WHIP. The phone IS the camera AND the instrument rack AND the broadcast unit.

Everything runs on-device; cloud is opt-in only. The forensic backbone (hash-chained audit log, Merkle manifest, COSE signatures) makes the output defensible. One device = one database = one investigator. Multi-device and the Pi hub are post-V1.

---

## 2. Repository layout

```
so-i-ve-always-wanted-to/
├── pwa/                    ← the entire product (this is the repo root for dev)
│   ├── src/
│   │   ├── components/     ← reusable UI components (56 .tsx + 55 .module.css)
│   │   ├── views/          ← full-page route targets (12 .tsx)
│   │   ├── lib/            ← all business logic, 14 subdirectories
│   │   ├── hooks/          ← 2 standalone React hooks
│   │   ├── styles/         ← global CSS + design tokens
│   │   └── workers/        ← Whisper transcription Web Worker
│   ├── public/             ← static assets, manifest.json, icons
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── pi-hub/                 ← post-V1 Raspberry Pi 5 sensor hub (not shipped)
└── docs/                   ← project documentation
```

---

## 3. Routes (`src/App.tsx`)

`CameraScreen` is **eager** (imported directly). Everything else is **lazy** (`React.lazy` + `Suspense`).

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | `CameraScreen` | Primary screen — full-viewport camera + scene-chip dock. First-run redirects to `/hunt-setup`. |
| `/hunt-setup` | `HuntSetup` | Pre-flight scene picker. The PRIMARY configuration surface — operators pick a scene here BEFORE the hunt. |
| `/lab` | `MissionControl` | **Pro / Lab view** — full investigation panel with Bayesian surfaces, sensors panel, tools. Demoted from primary nav; surface via Setup → Pro toggle. |
| `/investigate` | `MissionControl` | Back-compat alias for `/lab` — older deep-links keep working. |
| `/review` | `Review` | Case review — null-rate, case manager, chain status, export |
| `/evp` | `EvpReview` | EVP playback, trimming, clip export |
| `/estes` | `Estes` | Estes board — two-phone spirit-box session |
| `/setup` | `Setup` | Device config — audio, cloud AI, audit log, pre-air readiness |
| `/brief` | `EvidenceBrief` | Auto-resolve most-recent investigation → printable one-pager |
| `/brief/:investigationId` | `EvidenceBrief` | Specific case one-pager |
| `/research` | `Research` | Cultural significance, heritage, incident browser |
| `/dossier/:id` | `DossierPrint` | Printable AI Investigator research dossier |
| `/community` | `CommunityMap` | Leaflet map of community investigation pins |
| `/about` | `About` | App info, credits, team attribution |

**Cut routes (2026-05-16 strategy pivot):**
- `/floorplan` — deleted. Out of scope for the streaming-first product framing.

**Root-level wrappers (always mounted):**  
`AcknowledgementGate` → `OnboardingTour` → `AppHeader` + `BottomNav` + three banners (ServiceWorkerUpdate, CivilTwilight, InterruptedSession).

---

## 4. Architecture at a glance

```
┌─────────────────────────────────────────────────────┐
│  CameraScreen (/)                                   │
│  ┌─────────────────────────────────────────────┐   │
│  │  LiveStreamView (fullscreen)                │   │
│  │  Camera → canvasCompositor → preview canvas │   │
│  │  WHIP session → Cloudflare/Mux/Restream     │   │
│  └─────────────────────────────────────────────┘   │
│  Floating dock: 13 overlay channels + SBX/OVL + Begin/End  │
└─────────────────────────────────────────────────────┘

           │ Begin session
           ▼
┌─────────────────────────┐      ┌──────────────────────┐
│  siteSession (state)    │      │  useSensors (hook)   │
│  log-odds accumulator   │◄─────│  EMF, motion, light, │
│  + exponential decay    │      │  mic, GPS, temp      │
└─────────────────────────┘      └──────────────────────┘
           │ applyAndAudit()
           ▼
┌─────────────────────────┐
│  audit_log (SQLite)     │  ← append-only, SHA-256 hash-chained
│  seq / ts / kind /      │
│  payload / prev_hash /  │
│  entry_hash             │
└─────────────────────────┘
           │
           ▼
┌─────────────────────────┐
│  exportBundle()         │
│  ZIP: JSONL + media +   │
│  manifest + verify.html │
│  COSE signature         │
└─────────────────────────┘
```

---

## 5. Library domains (`src/lib/`)

### 5.1 Database (`lib/db/`)

| File | Purpose |
|------|---------|
| `schema.ts` | Full SQLite DDL (v14) + all TypeScript interfaces. **Single source of truth for types.** |
| `db.ts` | `query<T>()` / `exec()` wrappers over sqlite-wasm OPFS pool |
| `repo.ts` | Typed CRUD: investigations, media assets, evidence events, sensor samples, dossiers |
| `auditLog.ts` | `appendAuditEntry()` + `verifyAuditChain()` — SHA-256 hash chain |
| `debunkRepo.ts` | Debunking checklist entries |
| `interviewRepo.ts` | Witness interview records |
| `protocolRepo.ts` | Pre-air readiness protocol |
| `triggerObjectRepo.ts` | Trigger object position tracking |
| `bundleSignatureRepo.ts` | Ed25519 signing keys for export bundles |
| `sahPoolWorker.ts` | SQLite async-pool web worker (sqlite-wasm internals) |

**Schema tables (v14):** `schema_meta` · `sync_queue` · `investigations` · `sensor_samples` · `evidence_events` · `media_assets` · `transcripts` · `research_dossiers` · `research_finding_notes` · `reviewer_signoffs` · `debunk_checklist` · `interviews` · `trigger_objects` · `trigger_object_checks` · `bundle_signatures` · `audit_log`

**Key types from `schema.ts`:**

```typescript
type RestrictionLevel = "open" | "pending" | "men_only" | "women_only" | "restricted_sacred"
type Disposition      = "null" | "inconclusive" | "flagged" | "confirmed_mundane"
type MediaType        = "audio" | "image" | "video"
interface Investigation { id, title, location_name, disposition, culturally_sensitive,
                          protocol_json, protocol_hash, to_consent_path,
                          commercial_use_approved, restriction, ... }
interface MediaAsset    { id, investigation_id, media_type, file_path,
                          checksum_sha256, restriction, ... }
interface EvidenceEvent { id, investigation_id, event_type, timestamp,
                          source, title, description, metadata_json, restriction }
```

---

### 5.2 Bayesian inference (`lib/posterior/`)

The core scoring engine. Every sensor event updates a **log-odds accumulator** bounded to [0.001, 0.999], with **exponential decay** toward the prior between events.

| File | Purpose |
|------|---------|
| `posterior.ts` | `getPosterior()` — decay-to-prior + bounded log-odds accumulator |
| `likelihoods.ts` | Per-channel LR tables (EMF, acoustic, motion, ITC, magnetometer, etc.) |
| `siteSession.ts` | Session state machine; `applyAndAudit()` — applies LR + writes audit entry |
| `sessionBaseline.ts` | Per-session p50/p95 dBFS noise floor |
| `ahtVerdict.ts` | AHT post-roll: H₀ AI-insufficiency check, final case verdict |
| `liveNarrator.ts` | Plain-English observation strings + optional SpeechSynthesis |
| `plainEnglish.ts` | Channel/sector descriptions for Simple mode copy |

**Pattern — stable `emitEvidence` closure (important):**  
`CameraScreen` mirrors `siteSession` state into a `siteSessionRef` so the acoustic analyzer (created once at `handleBegin`) always reads fresh state without the `useCallback` deps changing:

```typescript
const siteSessionRef = useRef(siteSession);
useEffect(() => { siteSessionRef.current = siteSession; }, [siteSession]);
const emitEvidence = useCallback(async (input) => {
  const result = await applyAndAudit(siteSessionRef.current, input);
  setSiteSession(result.session);
  ...
}, []); // stable — safe for acoustic analyzer closure capture
```

---

### 5.3 Audio (`lib/audio/`)

| File | Purpose |
|------|---------|
| `liveAnalyzer.ts` | Stereo capture orchestrator — FFT + cross-spectrum → sector + coherence |
| `stereoAnalysis.ts` | ITD (±2 ms), ILD (RMS ratio), MSC coherence for direction inference |
| `sectorIndicator.ts` | 6 × 60° sector classification from ITD/MSC |
| `fft.ts` | Hand-rolled Cooley-Tukey FFT (no deps) |
| `spectrogram.ts` | STFT spectrogram with voice-band (300/1k/3.4k Hz) + mains-hum markers |
| `evpRecorder.ts` | EVP recording → 16-bit PCM WAV → OPFS |
| `localTranscribe.ts` | On-device Whisper via HuggingFace Transformers |
| `infrasound.ts` | Sub-20 Hz anomaly detector |
| `baitTone.ts` | Sub-audible frequency generator (with honest framing disclaimers) |
| `calibration.ts` | Mic calibration reference tone |
| `micLevel.ts` | Real-time dBFS level monitoring |
| `audioUnlock.ts` | AudioContext unlock on first user gesture |
| `wavDecoder.ts` | WAV file parser |
| `chime.ts` | UI notification tone |

---

### 5.4 Media / Streaming (`lib/media/`)

| File | Purpose |
|------|---------|
| `canvasCompositor.ts` | **The compositor.** 30 Hz rAF loop compositing camera feed + 10 overlay channels to a single `<canvas>`. Output stream feeds both local recording and WHIP. `drawPill()` is 4-pass broadcast-quality paint; path built once per pill per frame. |
| `whip.ts` | WHIP (WebRTC-HTTP Ingest Protocol) client — pushes `MediaStream` to Cloudflare Stream Live / Mux / Restream / Dolby.io / Eyevinn |
| `overlayChannelStorage.ts` | Shared `localStorage` helpers for overlay channel state. Key: `ss-overlay-channels`. Used by both `LiveStreamView` and `CameraScreen` to share preferences. |
| `whipStorage.ts` | **Single source of truth for WHIP config.** Exports `WHIP_URL_KEY / WHIP_BEARER_KEY / WHIP_PROVIDER_KEY` (localStorage keys), `WhipProviderKey` type, `WhipProviderTemplate` interface, and `WHIP_PROVIDERS` array. Imported by both `LiveStreamView` and `Setup`. |

**`OverlayChannels` interface** (14 toggles — 10 original + 3 virtual instruments + audio meter):
`activityPill` · `posteriorPill` · `edgeGlow` · `sensors` · `itc` · `directionArrow` · `caption` · `timestamp` · `cornerBrackets` · `statusPills` · `kiiMeter` · `remPod` · `nightVision` · `audioMeter`

**Overlay plugin registry** (`lib/overlays/registry.ts`) — the declarative source-of-truth for which channels exist + their metadata. Each entry: `id`, `name`, `description`, `group`, `defaultEnabled`, `forensicMandatory?`, `sensors[]`, `proOnly?`. Adding a new overlay is a 3-step contract:
1. Add the boolean field to `OverlayChannels` (canvasCompositor.ts).
2. Add the draw call to `renderFrame` (canvasCompositor.ts).
3. Add the `OverlayPlugin` entry to `OVERLAY_REGISTRY` so it's discoverable to Scenes + HuntSetup.

`resolveOverlaysFromScene()` merges a scene's sparse overlay map against registry defaults, forcing `forensicMandatory` channels always-on regardless of the scene.

**Scenes** (`lib/overlays/scenes.ts`) — named bundles. The OBS-style preset pattern; pre-flight config instead of mid-hunt toggling. Five built-in scenes:
- `walkthrough` (default for first-time users — moving, lights on, sensor data visible)
- `spirit_box_session` (stationary, ITC running, selfie cam, NV on)
- `vigil` (cinematic, minimal HUD — audio meter + timestamp only)
- `calibration` (pre-session raw-data capture, no inference)
- `pro_lab` (Bayesian surfaces visible — review-grade only; NOT recommended for general streaming)

Each scene: sparse `overlays: Partial<Record<OverlayId, boolean>>` + tool config (Spirit Box / Ovilus auto-start) + camera defaults (torch, facing). Active scene + first-run-picked flag persisted via localStorage (`ss-active-scene`, `ss-has-picked-scene`).

**Skeptical-panel rule** — `activityPill`, `posteriorPill`, `edgeGlow` are `proOnly: true` and `defaultEnabled: false`. They surface in the `pro_lab` scene only. The default broadcast frame shows raw sensor data, NOT "probability of haunting" Bayesian UI that a general audience could misread as a ghost detector.

**Virtual instruments** (all off by default — operator enables per session):
- `kiiMeter` → `drawKiiMeter()` — 5-LED bar drawn bottom-left, colour-mapped G·G·Y·O·R. Lit count from `kiiLedFromZScore(emfZScore)` when present (thresholds 1.5/2.5/3.5/5.0 → 1-5 LEDs) for instant EMF response; falls back to `activityBand` mapping otherwise.
- `remPod` → `drawRemPod()` — oval body + antenna + 6 perimeter LEDs drawn bottom-right. Three staggered pulsing rings expand outward when active; ring period 1.1 s, phase-shifted by 1/3 each. Lit count + ring intensity driven by `remLedFromZScore(emfZScore)` (instant response) when present; falls back to `activityBand` otherwise.
- `nightVision` → `applyNightVision()` — applied IMMEDIATELY after the camera `drawImage` and before any other overlay. Per-pixel: `R = luma*0.06, G = luma, B = luma*0.06` producing classic green-channel NV. Runs `getImageData/putImageData` at 30 fps (~4–8 ms at 1080p).

**Status pills** (`drawStatusPills`, `statusPills` channel — centre-top row):
- `● REC MM:SS` when `recording === true` (red). Elapsed-time suffix uses `recordingStartedAt` (Unix ms) — compositor computes `Date.now() - t` every frame so the seconds tick at 30 fps without React state churn. Crosses `H:MM:SS` past one hour.
- `◉ LIVE MM:SS` when `liveStreaming === true` (teal). Same pattern with `liveStartedAt`.
- `⚠ OFFLINE` when `recording === true && online === false` (amber) — proves forensic chain: footage was captured local-only before any cloud sync. Row is centred horizontally so all 0-3 pills sit symmetrically.

**Audio level meter** (`drawAudioMeter`, `audioMeter` channel — centre-top, beneath status pills):
- Horizontal gradient bar (green→yellow→red), ~22 % of frame width, height ~1.8 % of frame.
- Level uses `Math.pow(audioRms, 0.55)` — compressing the low end so quiet audio still moves the bar visibly.
- Tick marks at 70 % (loud) and 85 % (clipping zones).
- Position calculated from the status-pills row anchor so it always sits 6 px below them regardless of whether REC/LIVE/OFFLINE are showing.

**External channel control pattern:**  
`CameraScreen` lifts channel state and passes `externalChannels` + `onExternalChannelChange` props to `LiveStreamView`. When these props are present, `LiveStreamView` uses the external state instead of its own; its internal toggle panel is hidden. `MissionControl` uses internal channel state as before.

**Broadcast-rig dock ref pattern** (torch + flip added alongside record/live):  
`CameraScreen` passes four `MutableRefObject<(() => void) | null>` refs into `LiveStreamView`. The component wires its internal callbacks onto them in one `useEffect`. The dock buttons call `ref.current?.()` directly — no state prop-threading needed.  
`onCameraState` reports back: `{ streamOn, whipConfigured, torchSupported, torchOn, facingMode }`. The torch button renders only when `torchSupported === true` (hidden on front cams and devices with no torch). The inline `cameraControls` row inside `LiveStreamView` is suppressed in `fullscreen` mode so the two surfaces don't duplicate.

---

### 5.5 Forensic export (`lib/forensic/`)

The export pipeline runs in order: **redact → restrict → label → manifest → sign.**

| File | Purpose |
|------|---------|
| `exportBundle.ts` | `buildExportBundle(investigationId?)` → ZIP blob. Restricted media is redacted and replaced with a notice + TK label. `buildRestrictionNotice()` generates plain-text redaction notices. |
| `manifest.ts` | `buildManifest()` — Merkle root + chain summary JSON |
| `merkle.ts` | RFC 6962 Merkle tree over SHA-256 |
| `evidenceBrief.ts` | `buildEvidenceBrief(id)` — one-page case summary with AHT verdict |
| `preAirReadiness.ts` | `checkPreAirReadiness()` — deployment checklist (protocol locked, chain ok, reviewer sign-offs, etc.) |
| `coseSign1.ts` | COSE Sign1 Ed25519 bundle signature |
| `tsaClient.ts` | RFC 3161 TSA timestamp anchoring (queued offline) |
| `verifyDeno.ts` | Generates the `verify.html` + `verify.ts` bundle verifier |
| `manifestVerifier.ts` | In-app manifest verification |
| `zip.ts` | Pure-JS ZIP assembly |
| `canonicalJson.ts` | Deterministic JSON serialization |
| `bytes.ts` | Byte/hex/base64 utilities |

**Export bundle summary type:**
```typescript
{ blob, summary: { filename, byteLength, entries, mediaIncluded,
                   mediaMissing, mediaRestricted, scope, investigationIds } }
```

---

### 5.6 Sensors (`lib/sensors/`)

| File | Purpose |
|------|---------|
| `useSensors.ts` | **Main hook.** Aggregates all device sensors into one `SensorState` object. |
| `magnetometer.ts` | EMF via Generic Sensor API |
| `motion.ts` | Accelerometer + gyroscope + device-orientation fusion |
| `light.ts` | Ambient light sensor |
| `geolocation.ts` | GPS tracking |
| `baseline.ts` | Exponentially-weighted z-score baseline anomaly detector |
| `civilTwilight.ts` | Solar altitude calculation → day / civil-twilight / night |
| `sensitiveSiteClassifier.ts` | Lat/lng → colonial massacre site match (bundled GeoJSON) |
| `sensorsDiscovery.ts` | Enumerate supported sensors on this device |
| `shakeDetector.ts` | Vibration / shake detection |
| `permissions.ts` | Sensor permission request helpers |

---

### 5.7 ITC channels (`lib/itc/`)

ITC tools (Spirit Box, Ovilus, EVP auto-emit) publish words/phonemes to the canvas overlay via `itcChannels.ts`.

| File | Purpose |
|------|---------|
| `itcChannels.ts` | Module-level pub/sub; `setSpiritBoxEmission()` / `setOvilusEmission()` / `setEvpEmission()` → canvas `itc` channel |
| `radioSweep.ts` | Radio frequency sweep (Spirit Box) |
| `phonemeSynth.ts` | Phoneme synthesis for ITC emissions |
| `ovilusDictionary.ts` | Ovilus word dictionary |
| `phonemes.ts` | Phoneme inventory |
| `useSpiritBox.ts` | Dock-tier hook — runs phoneme cycle + SpeechSynthesis, publishes to ITC overlay. No UI. Called from `CameraScreen`. |
| `useOvilus.ts` | Dock-tier hook — runs word-gen cycle + SpeechSynthesis, publishes to ITC overlay. No UI. Called from `CameraScreen`. |

**Dock ITC flow (broadcast mode):**
```
CameraScreen
  useSpiritBox(itcEntropy, running) → setSpiritBoxEmission(phoneme) ──┐
  useOvilus(itcEntropy, running)    → setOvilusEmission(word)         ├─► itcChannels store
                                                                       │
canvasCompositor (30Hz)  ◄── getItcChannels() each frame ─────────────┘
  → drawItcOverlay()  (only when channels.itc === true)
```

The **`itc` overlay channel must be ON** for ITC output to appear in the broadcast frame. The dock SBX/OVL buttons only start/stop the cycles — they don't auto-enable the channel. This lets operators run the spirit box for audio without cluttering the video frame.

---

### 5.8 ICIP / Restricted content (`lib/restricted/`)

| File | Purpose |
|------|---------|
| `tkLabels.ts` | `RestrictionLevel` → TK Label mapping. `ALL_RESTRICTION_LEVELS`, `RESTRICTION_LABELS`, `RESTRICTION_SHORT`, `tkLabelForRestriction()`, `isRestricted()` |

TK Labels map: `open → null` · `pending → TK Notice` · `men_only → TK Men General` · `women_only → TK Women General` · `restricted_sacred → TK Secret/Sacred`

---

### 5.9 Cloud AI (`lib/ai/`)

All cloud AI calls are **blocked** when `culturally_sensitive = 1` on the active investigation.

| File | Purpose |
|------|---------|
| `cloudAi.ts` | Question generator + auto-debunker. Routes via OpenRouter proxy or direct Anthropic SDK. |
| `cloudTranscribe.ts` | Whisper cloud transcription (Cloudflare Workers AI) |
| `keyStore.ts` | BYOK API key management (localStorage, never transmitted) |
| `openRouterClient.ts` | OpenRouter proxy client |
| `embeddings.ts` | Text embedding utilities |

---

### 5.10 Sync / offline (`lib/sync/`)

| File | Purpose |
|------|---------|
| `queue.ts` | Append-only FIFO sync queue in SQLite (`sync_queue` table). `safeEnqueue()` is a no-op when offline. |
| `syncWorker.ts` | Background worker — drains queue with exponential backoff when online |
| `types.ts` | `SyncQueueItem` type definitions (`media_row` · `media_blob` · `evidence_event` · `investigation`) |

Started in `main.tsx` after first paint: `syncWorker.start()`.

---

### 5.11 System utilities

| File | Purpose |
|------|---------|
| `lib/system/liveBroadcast.ts` | Module-level pub/sub for recording/live state. Any view can call `useLiveBroadcastState()` to show REC/LIVE without prop drilling. |
| `lib/system/wakeLock.ts` | Screen wake-lock (prevents screen sleep during sessions) |
| `lib/system/systemStatus.ts` | Battery, network, storage stats |
| `lib/opfs.ts` | OPFS read/write/delete. `readFile()` · `writeBytes()` · `writeText()` · `writeJson()` · `deletePath()` · `listDirectory()` · `exists()` |
| `lib/preferences.ts` | `usePreferences()` hook + `setPreferences()`. Persists to localStorage. Includes `experienceMode` (simple/pro), scotopic level, cultural sensitivity overrides. |
| `lib/session.ts` | Global session state (current investigation ID, running flag) |
| `lib/bootstrap.ts` | Ensure one investigation exists for today on app start |
| `lib/modelCache.ts` | On-device ML model caching (HuggingFace Transformers.js) |
| `lib/wav.ts` | WAV encode/decode |
| `lib/registerServiceWorker.ts` | SW registration + update detection |

---

## 6. Components index

### Camera & streaming
| Component | Purpose |
|-----------|---------|
| `LiveStreamView` | Camera → canvasCompositor → preview. WHIP live broadcast controls. Record button. Handles `externalChannels` prop from `CameraScreen`. |
| `CameraCapture` | Rear camera snapshot with motion-triggered auto-snap |
| `ScreenRecordButton` | Start/stop screen + audio recording via MediaRecorder |
| `VideoEvpCaptureTile` | Simultaneous video + EVP dual-channel capture |

### Sensors & live HUD
| Component | Purpose |
|-----------|---------|
| `SensorsPanel` | Real-time sensor readout (EMF, motion, light, temp, GPS) |
| `AcousticSectorIndicator` | 6-sector SVG direction indicator (top-right HUD) |
| `EmfSpikeLed` | EMF spike LED indicator |
| `PosteriorBar` | Anomaly probability bar (0% → 100%) |
| `SlsPoseTracker` | SLS skeleton overlay |
| `TiltToWakeStatus` | Device orientation status |

### ITC tools
| Component | Purpose |
|-----------|---------|
| `SpiritBoxTool` | Radio sweep spirit box |
| `OvilusTool` | Ovilus word generator |
| `BaitToneTool` | Sub-audible tone generator |
| `SpectrogramViewer` | Real-time FFT spectrogram |

### Session & evidence
| Component | Purpose |
|-----------|---------|
| `ControlSessionPanel` | Start / stop / paired session control |
| `ContaminationMarker` | Quick-tap contamination event buttons |
| `EvidenceLedger` | Chronological event stream |
| `DebunkChecklist` | Mundane-explanation checklist for flagged events |
| `EventDebunkPanel` | Collapsible debunk wrapper for case review |
| `SessionBaselineCard` | Baseline stats for current session |
| `SessionSummaryCard` | Session recap (total LR weight, posterior peak) |
| `DispositionPicker` | Classify session disposition (null/inconclusive/flagged/mundane) |
| `RestrictionPicker` | Set ICIP restriction level on a media asset or evidence event. `compact=true` → inline `<select>`. `compact=false` → tile grid + TK label reference. |

### Cases & forensic
| Component | Purpose |
|-----------|---------|
| `CaseManager` | List / drill / edit / export investigations; media browser with `RestrictionPicker`; TO consent upload; commercial-use approval |
| `NullRateDashboard` | Base-rate charts per location + investigator lifetime |
| `BaseRatePanel` | Null-rate statistics table |
| `AuditLogInspector` | View hash-chained audit entries with kind-filter |
| `ManifestVerifier` | Paste/drop exported manifest to verify integrity |
| `ReviewerSignoffsPanel` | Record external Bayesian / acoustician sign-offs |
| `PreAirReadinessPanel` | Full deployment checklist |
| `PreAirReadinessChip` | Compact ready/not-ready status chip |

### Setup & config
| Component | Purpose |
|-----------|---------|
| `DeploymentHealth` | Battery, network, storage, model-cache, WHIP relay status |
| `SyncPanel` | Offline sync queue status + manual flush |
| `ExperienceToggle` | Simple ↔ Pro mode toggle |
| `ScotopicToggle` | Scotopic (red) theme toggle |
| `TriggerObjectTracker` | Before/after position comparator for trigger objects |

### Cultural / compliance
| Component | Purpose |
|-----------|---------|
| `AcknowledgementGate` | First-launch Country acknowledgement (AIATSIS polygon lookup) |
| `SensitiveSiteWarning` | Colonial massacre site proximity modal |
| `ProtocolWizard` | Pre-registered hypothesis wizard (locks to SHA-256 hash) |
| `ProtocolSummaryChip` | Compact locked/draft protocol status |

### Layout & navigation
| Component | Purpose |
|-----------|---------|
| `AppHeader` | Top bar with back/title and broadcast state indicator |
| `BottomNav` | Tab bar: Camera · Investigate · Review · Setup (+ more) |
| `OnboardingTour` | First-launch interactive tutorial overlay |
| `CivilTwilightBanner` | Auto-suggest scotopic mode at twilight/night |
| `InterruptedSessionBanner` | Notify when prior session was interrupted |
| `ServiceWorkerUpdateBanner` | Prompt reload on new SW |

---

## 7. Views index

| View | Route | Key components used |
|------|-------|---------------------|
| `CameraScreen` | `/` | `LiveStreamView`, `useSensors`, `liveAnalyzer`, `siteSession`, `PosteriorBar` (via overlay) |
| `MissionControl` | `/investigate` | `LiveStreamView`, `SensorsPanel`, `PosteriorBar`, `EvidenceLedger`, `AiAssistant`, all ITC tools |
| `Review` | `/review` | `CaseManager`, `NullRateDashboard`, `InterviewsList`, chain verification, export |
| `EvpReview` | `/evp` | `EvpEditor`, `SpectrogramViewer` |
| `Estes` | `/estes` | WebRTC peer, spirit-box audio, dual-phone session log |
| `Setup` | `/setup` | `DeploymentHealth`, `SyncPanel`, `AuditLogInspector`, `ManifestVerifier`, `PreAirReadinessPanel`, `ReviewerSignoffsPanel` |
| `Floorplan` | `/floorplan` | Canvas sketch tool, zone annotation |
| `EvidenceBrief` | `/brief/:id` | `buildEvidenceBrief()`, `PreAirReadinessChip`, AHT verdict card, 8 ethical disclaimers |
| `Research` | `/research` | `ResearchSnapshot`, Perplexity Sonar API client, dossier save |
| `DossierPrint` | `/dossier/:id` | Printable AI research dossier |
| `CommunityMap` | `/community` | Leaflet map, community API client |
| `About` | `/about` | Credits, team attribution, version info |

---

## 8. Key data flows

### 8.1 Evidence event → audit log
```
sensor spike / user tap
  → applyAndAudit(siteSession, evidenceInput)   [lib/posterior/siteSession.ts]
  → getPosterior()                               [lib/posterior/posterior.ts]
  → appendAuditEntry({ kind: "evidence.*", payload: { log_lr, posterior_before, posterior_after } })
  → SHA-256 hash(prev_hash + payload) stored in audit_log
```

### 8.2 Media capture → OPFS → export
```
MediaRecorder / CameraCapture / EVP recorder
  → writeBytes(path, blob)                       [lib/opfs.ts]
  → registerMedia({ file_path, media_type, checksum_sha256 })  [lib/db/repo.ts]
  → INSERT INTO media_assets
  → safeEnqueue({ kind: "media_blob", file_path })             [lib/sync/queue.ts]
  
On export:
  → buildExportBundle(investigationId)           [lib/forensic/exportBundle.ts]
  → for each asset: if restricted → buildRestrictionNotice() else readFile()
  → buildManifest() → Merkle root
  → COSE Sign1 → ZIP
```

### 8.3 Live broadcast pipeline
```
getUserMedia (camera + mic)
  → canvasCompositor (30Hz rAF)                  [lib/media/canvasCompositor.ts]
     ├── drawPill() × N overlays (4-pass paint, path built once per pill)
     ├── posterior bar / sector / glow / timestamp / caption / ITC
     └── canvas.captureStream(30) → compositorStream
  
compositorStream
  ├── MediaRecorder → local recording (OPFS)
  └── startWhipSession({ url, stream })           [lib/media/whip.ts]
      → RTCPeerConnection → ICE gather → HTTP POST SDP
      → LIVE to Cloudflare/Mux/Restream/Dolby
```

### 8.4 ICIP restriction flow
```
Operator tags asset: RestrictionPicker (compact) in CaseManager media row
  → handleSetMediaRestriction(assetId, level)
  → UPDATE media_assets SET restriction = ?
  → appendAuditEntry({ kind: "media.restriction" })

On export (buildExportBundle):
  → isRestricted(asset.restriction) → skip binary
  → buildRestrictionNotice(assetId, path, mediaType, restriction, tkLabel)
  → include plain-text notice in ZIP instead of file bytes
  → summary.mediaRestricted++ 
```

---

## 9. SQLite schema highlights

```
investigations      id (uuid) · title · location_name · disposition · culturally_sensitive
                    protocol_json · protocol_hash (sha256) · to_consent_path · commercial_use_approved
                    restriction · paired_investigation_id (control sessions)

media_assets        id · investigation_id · media_type · file_path · timestamp_start
                    checksum_sha256 · metadata_json · restriction

evidence_events     id · investigation_id · timestamp · source · event_type · title
                    description · metadata_json · linked_file · restriction

audit_log           seq · ts_utc · actor · kind · payload_json · prev_hash · entry_hash
                    (append-only, never UPDATE — hash chain would break)

sync_queue          id · kind · ref_id · payload_json · file_path · created_at · attempts
                    last_attempt_at · last_error · status (pending/uploading/done/failed)
```

**Never UPDATE `audit_log`.** Every edit is a new entry. `verifyAuditChain()` re-hashes the chain and returns `{ ok, brokenAtSeq }`.

---

## 10. CSS design tokens (`src/styles/tokens.css`)

### Colours (dark theme default)
| Token | Value | Use |
|-------|-------|-----|
| `--bg-canvas` | `#07090C` | Page background |
| `--bg-surface` | `#0E1218` | Card / input background |
| `--bg-elevated` | `#151A22` | Elevated card |
| `--bg-overlay` | `#1F2632` | Hover state |
| `--signal` | `#5DF2C7` | Brand teal — primary accent, active states |
| `--signal-dim` | `#2BA386` | Dimmed accent |
| `--signal-wash` | `#0F2A24` | Tint background for active/chosen |
| `--warning` | `#F2B95D` | Amber — warnings, pending states |
| `--warning-wash` | `#2A210F` | Amber tint background |
| `--danger` | `#EF6E6E` | Red — errors, destructive, restricted-sacred |
| `--danger-wash` | `#2A1313` | Red tint background |
| `--text-primary` | `#E7ECF3` | Main text |
| `--text-muted` | `#5C6677` | Secondary / hint text |

**Scotopic (red) theme** — `[data-theme="scotopic"]` overrides all tokens to `#0A0000` canvas + `#8B0000`-family reds. Applied by `ScotopicToggle` / auto civil-twilight.

### Spacing (`--s-*`)
`--s-2` through `--s-48` (2px steps up to 48px).

### Radius (`--r-*`)
`--r-sm: 6px` · `--r-md: 10px` · `--r-lg: 14px` · `--r-xl: 20px` · `--r-full: 999px`

### Layout constants
`--bottom-nav-height: 64px` · `--safe-bottom` (env(safe-area-inset-bottom))

### Global button classes (`src/styles/buttons.css`)
`.btn` (base) · `.btn-primary` (signal fill) · `.btn-ghost` (surface + border) · `.btn-danger` (danger wash) · `.btn-danger-solid` (danger fill) · `.btn-warning` (warning fill)

---

## 11. Patterns & conventions

### Module-level pub/sub (preferences, session, liveBroadcast)
Modules that need to be read anywhere without prop-drilling use the pattern:
```typescript
const subscribers = new Set<(s: State) => void>();
let current: State = INITIAL;
export function setXxx(next: State): void {
  if (/* no change */) return;   // ← always guard — prevents no-op re-renders
  current = next;
  for (const fn of subscribers) fn(current);
}
export function useXxx(): State {
  const [value, setValue] = useState(current);
  useEffect(() => { subscribers.add(setValue); setValue(current); return () => { subscribers.delete(setValue); }; }, []);
  return value;
}
```
Files: `lib/preferences.ts` · `lib/session.ts` · `lib/system/liveBroadcast.ts`

### siteSessionRef — stable callbacks with live state
When a long-lived object (e.g. acoustic analyzer) captures a callback at creation time, use a ref to avoid stale closures:
```typescript
const siteSessionRef = useRef(siteSession);
useEffect(() => { siteSessionRef.current = siteSession; }, [siteSession]);
const stableCallback = useCallback(async () => {
  doThing(siteSessionRef.current);  // always fresh
}, []);                              // empty deps — never recreated
```

### CSS Modules + global tokens
All component styles are `.module.css`. Tokens are on `:root` and consumed as `var(--signal)` etc. Never hardcode colours in module files.

### Audit entries — kind naming
`domain.action` format: `evidence.acoustic` · `media.register` · `media.restriction` · `investigation.edit` · `bundle.export` · `investigation.consent_doc_uploaded`

### OPFS paths
```
media/{investigationId}/{timestamp}_{type}.{ext}
consent/{investigationId}/to_consent.{ext}
evp/{investigationId}/{timestamp}.wav
```

### No-op guard on state updates
Before updating module-level state, check for equality and return early. Prevents subscribers firing when nothing changed. Pattern enforced in posterior decay interval, liveBroadcast setter, and preferences.

---

## 12. Environment variables (Cloudflare Pages)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API (cloud AI, debunker, question generator) |
| `OPENROUTER_API_KEY` | OpenRouter proxy (alternative AI routing) |
| `CF_ACCOUNT_ID` | Cloudflare account (community map, stream) |
| `CF_STREAM_API_TOKEN` | Cloudflare Stream Live for WHIP relay |
| `WHIP_RELAY_ENDPOINT` | Pre-configured WHIP ingest URL (optional) |
| `WHIP_RELAY_TOKEN` | Bearer token for WHIP relay (optional) |
| `FB_CONNECT_TOKEN` | Facebook live connector bearer token |
| `FB_CONNECT_STATE` | D1 binding for Facebook live connector idempotency |
| `COMMUNITY_DB` | D1 binding name for community map database |
| `PERPLEXITY_API_KEY` | Sonar Pro for Research view (incident/heritage search) |

All variables are server-side (Cloudflare Workers/Functions). Nothing secret is shipped to the browser.

---

## 13. Open work / known gaps

| Gap | Where to look |
|-----|---------------|
| ~~**Camera dock: no Record / Go Live buttons**~~ | ✅ Fixed — `recordToggleRef` / `liveToggleRef` MutableRef props on `LiveStreamView`; dock buttons in `CameraScreen` call them. `onCameraState` prop drives enabled/disabled. |
| ~~**No online/offline indicator**~~ | ✅ Fixed — `AppHeader` listens to `window` online/offline events; shows OFFLINE badge when `!navigator.onLine`. |
| ~~**No elapsed session timer on camera screen**~~ | ✅ Fixed — 1-second interval in `CameraScreen` renders `m:ss` below Begin/End label while session is running. |
| ~~**WHIP URL config not in Setup**~~ | ✅ Fixed — `Setup.tsx` now has a **Broadcast** section that reads/writes `ss-whip-url`, `ss-whip-bearer`, `ss-whip-provider` via the same localStorage keys LiveStreamView uses. Provider `<select>` lists all 7 providers. |
| ~~**ScreenRecordButton not in camera dock**~~ | ✅ Fixed — `CameraScreen.tsx` imports and mounts `<ScreenRecordButton investigationId={session.current?.id ?? null} />` after the Go Live button in the dock. |

---

*Update this file when: a new `lib/` subdirectory is added, a route changes, a major pattern shifts, or schema version increments.*
