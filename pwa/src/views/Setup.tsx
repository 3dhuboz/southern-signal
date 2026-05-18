import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, usePreferences, type AppPreferences } from "../lib/preferences";
import { MicLevelMeter } from "../lib/audio/micLevel";
import { startVad, type VadHandle } from "../lib/audio/vad";
import { usePwaInstall } from "../lib/system/usePwaInstall";
import { WHIP_URL_KEY, WHIP_BEARER_KEY, WHIP_PROVIDER_KEY, WHIP_PROVIDERS } from "../lib/media/whipStorage";
import { AuditLogInspector } from "../components/AuditLogInspector";
import { CaseManager } from "../components/CaseManager";
import { DeploymentHealth } from "../components/DeploymentHealth";
import { ManifestVerifier } from "../components/ManifestVerifier";
import { PreAirReadinessPanel } from "../components/PreAirReadinessPanel";
import { ReviewerSignoffsPanel } from "../components/ReviewerSignoffsPanel";
import { SyncPanel } from "../components/SyncPanel";
import {
  DEFAULT_LOCAL_MODEL,
  WHISPER_SAMPLE_RATE,
  loadLocalWhisperModel,
  transcribeOnDevice,
  unloadLocalWhisperModel,
  useLocalTranscribeStatus,
} from "../lib/audio/localTranscribe";
import s from "./View.module.css";
import st from "./Setup.module.css";

const ONBOARDING_KEY = "ss-onboarding-completed-v1";

// Derive a key→label lookup from the shared WHIP_PROVIDERS list so the
// provider <select> stays in sync with LiveStreamView without manual duplication.
const WHIP_PROVIDER_LABELS = Object.fromEntries(WHIP_PROVIDERS.map((p) => [p.key, p.label]));

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Setup() {
  const [prefs, setPrefs] = usePreferences();
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | null>(() => {
    try { return localStorage.getItem(ONBOARDING_KEY); } catch { return null; }
  });

  // ── WHIP broadcast config ──────────────────────────────────────────────────
  const [whipUrl, setWhipUrl] = useState(() => {
    try { return localStorage.getItem(WHIP_URL_KEY) ?? ""; } catch { return ""; }
  });
  const [whipBearer, setWhipBearer] = useState(() => {
    try { return localStorage.getItem(WHIP_BEARER_KEY) ?? ""; } catch { return ""; }
  });
  const [whipProvider, setWhipProvider] = useState(() => {
    try {
      const stored = localStorage.getItem(WHIP_PROVIDER_KEY) ?? "";
      return stored in WHIP_PROVIDER_LABELS ? stored : "custom";
    } catch { return "custom"; }
  });
  const [whipSaved, setWhipSaved] = useState(false);
  const whipSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Derive once per render — used in badge, Clear-button guard, and save handler.
  const trimmedWhipUrl = whipUrl.trim();
  useEffect(() => () => { if (whipSavedTimerRef.current) clearTimeout(whipSavedTimerRef.current); }, []);

  const handleSaveWhip = useCallback(() => {
    try {
      if (trimmedWhipUrl) localStorage.setItem(WHIP_URL_KEY, trimmedWhipUrl);
      else localStorage.removeItem(WHIP_URL_KEY);
      if (whipBearer.trim()) localStorage.setItem(WHIP_BEARER_KEY, whipBearer.trim());
      else localStorage.removeItem(WHIP_BEARER_KEY);
      localStorage.setItem(WHIP_PROVIDER_KEY, whipProvider);
      if (whipSavedTimerRef.current) clearTimeout(whipSavedTimerRef.current);
      setWhipSaved(true);
      whipSavedTimerRef.current = setTimeout(() => setWhipSaved(false), 2000);
    } catch { /* swallow — localStorage unavailable */ }
  }, [trimmedWhipUrl, whipBearer, whipProvider]);

  const handleClearWhip = useCallback(() => {
    setWhipUrl("");
    setWhipBearer("");
    setWhipProvider("custom");
    try {
      localStorage.removeItem(WHIP_URL_KEY);
      localStorage.removeItem(WHIP_BEARER_KEY);
      localStorage.removeItem(WHIP_PROVIDER_KEY);
    } catch { /* swallow */ }
  }, []);

  // Stay in sync if the operator finishes the tour in another tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ONBOARDING_KEY) setOnboardingCompletedAt(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleReplayTour = useCallback(() => {
    try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* swallow */ }
    setOnboardingCompletedAt(null);
    // OnboardingTour reads the key on mount; reload re-mounts the App tree
    // and brings the tour back. window.location.assign keeps router history
    // intact better than reload() for users coming from a deep link.
    window.location.assign("/");
  }, []);

  // On-device transcription — opt-in. Drives the Whisper Worker via the
  // localTranscribe library; the worker is created lazily on first load().
  const localStatus = useLocalTranscribeStatus();
  const [loadError, setLoadError] = useState<string | null>(null);
  const handleDownloadModel = useCallback(async () => {
    setLoadError(null);
    try {
      await loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const handleUnloadModel = useCallback(() => {
    unloadLocalWhisperModel();
    setLoadError(null);
    setSelfTest(null);
  }, []);

  // Self-test: synthesize 1 s of low-amplitude noise at 16 kHz, round-trip
  // through the worker, and report timing + output. Real-browser sanity
  // check — confirms the worker bundled, the model is actually loaded into
  // the pipeline, and message-passing round-trips. Whisper on noise usually
  // returns empty / "[BLANK_AUDIO]" — that's a passing test, not a failure.
  const [selfTest, setSelfTest] = useState<{ status: "running" | "ok" | "fail"; ms?: number; text?: string; error?: string } | null>(null);
  const handleSelfTest = useCallback(async () => {
    setSelfTest({ status: "running" });
    try {
      const samples = new Float32Array(WHISPER_SAMPLE_RATE); // 1 s at 16 kHz
      // Low-amplitude pseudorandom noise; deterministic seed-free is fine
      // since we only care about pipeline plumbing.
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = (Math.random() - 0.5) * 0.001;
      }
      const t0 = performance.now();
      const result = await transcribeOnDevice(samples, WHISPER_SAMPLE_RATE, { language: "en", returnTimestamps: false });
      const ms = Math.round(performance.now() - t0);
      setSelfTest({ status: "ok", ms, text: result.text });
    } catch (err) {
      setSelfTest({ status: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Setup · Configuration</span>
        <h1 className={s.title}>Cases, broadcast, privacy</h1>
        <p className={s.lede}>Manage investigations, configure live broadcast (WHIP), tune on-device transcription and AI, set rig loadout, and manage privacy posture. All data stays on this device unless you explicitly enable cloud sync.</p>
      </div>

      {/* CASE MANAGER */}
      <section className={st.panel}>
        <CaseManager />
      </section>

      {/* Theme */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Theme</h2>
        </header>
        <p className={st.panelLede}>
          Phosphor (default) reads as a serious instrument under indoor light. Scotopic red preserves dark-adapted vision in the field — switch to it before a 3am investigation.
        </p>
        <div className={st.themeRow}>
          <button
            type="button"
            className={prefs.theme === "phosphor" ? st.themeActive : st.theme}
            onClick={() => { setPrefs({ theme: "phosphor" }); applyTheme("phosphor"); }}
          >
            <span className={st.themeSwatch} data-theme="phosphor" aria-hidden="true" />
            <span className={st.themeLabel}>Phosphor</span>
            <span className={st.themeMeta}>Default — cyan on near-black.</span>
          </button>
          <button
            type="button"
            className={prefs.theme === "scotopic" ? st.themeActive : st.theme}
            onClick={() => { setPrefs({ theme: "scotopic" }); applyTheme("scotopic"); }}
          >
            <span className={st.themeSwatch} data-theme="scotopic" aria-hidden="true" />
            <span className={st.themeLabel}>Scotopic red</span>
            <span className={st.themeMeta}>Field mode — preserves rod-cell adaptation.</span>
          </button>
          <button
            type="button"
            className={prefs.theme === "daylight" ? st.themeActive : st.theme}
            onClick={() => { setPrefs({ theme: "daylight" }); applyTheme("daylight"); }}
          >
            <span className={st.themeSwatch} data-theme="daylight" aria-hidden="true" />
            <span className={st.themeLabel}>Daylight</span>
            <span className={st.themeMeta}>Bright outdoor — daytime planning + equipment checks.</span>
          </button>
        </div>
      </section>


      {/* Pro / Lab mode — surface the demoted MissionControl as a Lab tab */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Pro / Lab mode</h2>
        </header>
        <label className={st.toggleRow}>
          <span>
            <strong>Pro / Lab mode</strong>
            <span className={st.toggleHint}>
              Surfaces the full MissionControl panel (sensors panel, Bayesian posterior breakdowns, all ITC tools) as a "Lab" tab in the bottom nav. Recommended only for review-grade work — not general streaming.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.proMode}
            onChange={(e) => setPrefs({ proMode: e.target.checked })}
          />
        </label>
        <label className={st.toggleRow}>
          <span>
            <strong>Monitor ITC tones through headphones</strong>
            <span className={st.toggleHint}>
              Routes the Spirit Box / Ovilus tone mixer to the device's default audio out as well as the recording. <strong>Enable only with headphones plugged in</strong> — through speakers, the mic re-captures the tones and creates a feedback loop in the recording. The recording path itself is unaffected by this toggle.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.itcMonitor}
            onChange={(e) => setPrefs({ itcMonitor: e.target.checked })}
          />
        </label>
        <label className={st.toggleRow}>
          <span>
            <strong>Hands-free narration (voice-activity ducking)</strong>
            <span className={st.toggleHint}>
              When you start speaking, the ITC tones automatically duck −18dB so your voice lands cleanly on the recording. Releases when you stop. The long-press-anywhere push-to-talk still works as a manual override. Threshold adapts to the room's noise floor over the first few seconds — wait a beat before talking after a noisy moment.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.vadAutoDuck}
            onChange={(e) => setPrefs({ vadAutoDuck: e.target.checked })}
          />
        </label>
        {prefs.vadAutoDuck && (
          <div className={st.fieldRow} style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
            <label className={st.fieldLabel}>
              Sensitivity: {prefs.vadConfig.sensitivityDb} dB above floor
              <input
                type="range"
                min={6} max={24} step={1}
                value={prefs.vadConfig.sensitivityDb}
                onChange={(e) => setPrefs({ vadConfig: { ...prefs.vadConfig, sensitivityDb: Number(e.target.value) } })}
              />
              <span className={st.toggleHint}>Lower = fires on quieter voices (better indoors); higher = resists outdoor wind / HVAC false-positives.</span>
            </label>
            <label className={st.fieldLabel}>
              Attack: {prefs.vadConfig.attackMs} ms
              <input
                type="range"
                min={40} max={400} step={20}
                value={prefs.vadConfig.attackMs}
                onChange={(e) => setPrefs({ vadConfig: { ...prefs.vadConfig, attackMs: Number(e.target.value) } })}
              />
              <span className={st.toggleHint}>How long voice must stay above threshold before the duck engages. Faster = less missed first-syllable, more chatter triggers.</span>
            </label>
            <label className={st.fieldLabel}>
              Release: {prefs.vadConfig.releaseMs} ms
              <input
                type="range"
                min={150} max={1200} step={50}
                value={prefs.vadConfig.releaseMs}
                onChange={(e) => setPrefs({ vadConfig: { ...prefs.vadConfig, releaseMs: Number(e.target.value) } })}
              />
              <span className={st.toggleHint}>How long silence must persist before tones come back. Longer = smoother re-entry between phrases.</span>
            </label>
            <SoundCheckCard vadConfig={prefs.vadConfig} />
          </div>
        )}
      </section>

      {/* PWA install card — only renders when the browser exposed an install
          prompt OR we're on iOS (manual A2HS guidance). Hides when already
          installed so we don't pester forever. */}
      <PwaInstallCard />

      {/* Broadcast — WHIP live-stream destination */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Broadcast</h2>
          <span className={st.panelBadge}>{trimmedWhipUrl ? "Configured" : "Not set"}</span>
        </header>
        <p className={st.panelLede}>
          Configure your WHIP live-stream destination. The Go Live button on the Camera screen uses these settings. Supported providers: Cloudflare Stream, Mux, Dolby.io, Restream, and any standards-compliant WHIP endpoint. Bearer token is optional — most Cloudflare and Mux endpoints don't require one.
        </p>
        <div className={st.fieldRow}>
          <label className={st.fieldLabel} htmlFor="setup-whip-provider">Provider</label>
          <select
            id="setup-whip-provider"
            className={st.input}
            value={whipProvider}
            onChange={(e) => setWhipProvider(e.target.value)}
          >
            {Object.entries(WHIP_PROVIDER_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
        <div className={st.fieldRow}>
          <label className={st.fieldLabel} htmlFor="setup-whip-url">WHIP endpoint URL</label>
          <input
            id="setup-whip-url"
            type="url"
            className={st.input}
            value={whipUrl}
            onChange={(e) => setWhipUrl(e.target.value)}
            placeholder="https://…/webrtc/publish"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={st.fieldRow}>
          <label className={st.fieldLabel} htmlFor="setup-whip-bearer">Bearer token <span className={st.fieldLabelSuffix}>(optional)</span></label>
          <input
            id="setup-whip-bearer"
            type="password"
            className={st.input}
            value={whipBearer}
            onChange={(e) => setWhipBearer(e.target.value)}
            placeholder="Leave blank if not required"
            autoComplete="new-password"
          />
        </div>
        <div className={st.actionRow}>
          <button type="button" className={st.linkBtn} onClick={handleSaveWhip}>
            {whipSaved ? "Saved ✓" : "Save broadcast settings"}
          </button>
          {trimmedWhipUrl && (
            <button type="button" className={st.linkBtn} onClick={handleClearWhip}>
              Clear
            </button>
          )}
        </div>
      </section>

      {/* Cloud sync (R2 + D1) */}
      <SyncPanel />

      {/* On-device Whisper transcription — opt-in, model is downloaded once. */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>On-device transcription</h2>
          <span className={st.panelBadge}>
            {localStatus.state === "ready" ? "Ready" :
             localStatus.state === "loading" ? "Loading…" :
             localStatus.state === "error" ? "Error" : "Off"}
          </span>
        </header>
        <p className={st.panelLede}>
          Transcribe EVP recordings entirely on this device — no audio leaves
          the phone. Required for culturally-sensitive cases (cloud
          transcription is hard-blocked there). Default model is
          Whisper-tiny.en, English-only, downloaded once and cached.
          {" "}<strong>Performance:</strong> roughly real-time on a current-
          generation phone (a 30-second clip transcribes in ~30s); the very
          first call after launch warms the model and may take a few seconds
          longer. Slower without WebGPU.
        </p>
        {localStatus.state === "unloaded" && (
          <>
            <button type="button" className={st.linkBtn ?? ""} onClick={handleDownloadModel}>
              Download model (~40 MB, one-off)
            </button>
            {loadError && <p className={st.errorLine}>{loadError}</p>}
          </>
        )}
        {localStatus.state === "loading" && (
          <div className={st.loadProgress}>
            <p className={st.toggleHint}>
              {localStatus.progress?.stage ?? "Downloading"}
              {localStatus.progress?.file ? ` · ${localStatus.progress.file}` : ""}
              {localStatus.progress?.total
                ? ` · ${formatBytes(localStatus.progress.loaded)} / ${formatBytes(localStatus.progress.total)}`
                : ""}
            </p>
            {localStatus.progress?.total ? (
              <div className={st.progressBar} aria-hidden="true">
                <div
                  className={st.progressFill}
                  style={{
                    width: `${Math.min(100, Math.max(0, (localStatus.progress.loaded / localStatus.progress.total) * 100))}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        )}
        {localStatus.state === "ready" && (
          <>
            <p className={st.toggleHint}>
              Model loaded: <code>{localStatus.loadedModel ?? DEFAULT_LOCAL_MODEL}</code>. EVP recordings can now be transcribed locally — see the editor on the EVP screen.
            </p>
            <div className={st.actionRow ?? ""}>
              <button
                type="button"
                className={st.linkBtn ?? ""}
                onClick={handleSelfTest}
                disabled={selfTest?.status === "running"}
                title="Round-trips a 1-second synthetic clip through the worker to confirm the pipeline is wired correctly."
              >
                {selfTest?.status === "running" ? "Testing…" : "Test pipeline"}
              </button>
              <button type="button" className={st.linkBtn ?? ""} onClick={handleUnloadModel}>
                Unload model (frees memory)
              </button>
            </div>
            {selfTest?.status === "ok" && (
              <p className={st.toggleHint}>
                Pipeline OK · {selfTest.ms} ms · output: <code>{selfTest.text?.trim() || "(empty — Whisper returned no transcript for synthetic noise, which is expected)"}</code>
              </p>
            )}
            {selfTest?.status === "fail" && (
              <p className={st.errorLine}>Pipeline test failed: {selfTest.error}</p>
            )}
          </>
        )}
        {localStatus.state === "error" && (
          <>
            <p className={st.errorLine}>{localStatus.error ?? "Loading failed."}</p>
            <button type="button" className={st.linkBtn ?? ""} onClick={handleDownloadModel}>
              Try again
            </button>
          </>
        )}
      </section>

      {/* EVP capture */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>EVP capture</h2>
        </header>
        <label className={st.toggleRow}>
          <span>
            <strong>Auto-transcribe EVP recordings</strong>
            <span className={st.toggleHint}>
              When you save a recording, send the full clip to cloud Whisper and store the transcript on the case. Skipped automatically when offline, on culturally-sensitive cases, or for clips under one second. Off by default — opt in only if you trust cloud transcription for this device.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.evp.autoTranscribe}
            onChange={(e) => setPrefs({ evp: { ...prefs.evp, autoTranscribe: e.target.checked } })}
          />
        </label>
      </section>

      {/* AI Investigator */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>AI Investigator</h2>
        </header>
        <label className={st.toggleRow}>
          <span>
            <strong>Enable venue archive deep-dive</strong>
            <span className={st.toggleHint}>
              Routes venue research through Perplexity Sonar via the OpenRouter proxy, returns tier-classified findings with primary-source citations. Counts against a 3/device/24h soft cap. Always refused on culturally-sensitive cases regardless of this toggle. Turn off to hide every entry point and the /research route entirely.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.research.enabled}
            onChange={(e) => setPrefs({ research: { ...prefs.research, enabled: e.target.checked } })}
          />
        </label>
      </section>

      {/* Rig loadout — compose the toolkit per venue type */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Rig loadout</h2>
          <span className={st.panelBadge}>PRO</span>
        </header>
        <p className={st.panelLede}>
          Toggle Pro-mode instrument tiles on or off. Different venues need different rigs — outdoor cemetery doesn't need a spirit box; a forensic indoor sweep wants every channel. Simple-mode tiles stay visible regardless.
        </p>
        {([
          { key: "emfSpikeLed", label: "EMF spike LEDs", hint: "K-II-style 5-segment bar that lights up when the magnetometer spikes above the live baseline. Visual companion to the EMF chart." },
          { key: "videoEvpCapture", label: "Video + EVP session reel", hint: "Records video from the back camera with synchronized mic audio while a session is running. Both files land in OPFS, audit-chained, paired by start timestamp." },
          { key: "slsTracker", label: "SLS stick-figure tracker", hint: "Honest motion-shape SLS analogue. Camera-based — when person-shaped motion is detected a stick figure is drawn over the bounding box. Phone hardware has no IR depth sensor; this is heuristic, not a true Kinect-style skeleton." },
          { key: "spiritBox", label: "Spirit Box", hint: "Frequency-sweep ITC tool. Outputs synthesized phoneme audio you scrub through for perceived words." },
          { key: "ovilus", label: "Ovilus dictionary speech", hint: "Sensor-seeded word picker. Speaks one word per spike — analogous to Spirit Talker / Ovilus apps." },
          { key: "baitTone", label: "Bait tone", hint: "Sub-audible carrier tones. Optional probe — leave off if you want a clean acoustic baseline." },
          { key: "camera", label: "Camera scene snapshots", hint: "Audit-chained still capture from the live preview. Off by default if you broadcast video instead." },
          { key: "contaminationMarkers", label: "Contamination markers", hint: "One-tap grid for tagging known mundane causes (HVAC, train, plumbing) during a session." },
          { key: "sensorsPanel", label: "Sensor inventory", hint: "Diagnostic list of every sensor this phone exposes. Useful for setup, less so mid-session." },
          { key: "estesTile", label: "Estes Method tile", hint: "Quick link to the dual-phone sensory-deprivation rig. Hide if you only investigate solo." },
        ] as const).map((opt) => (
          <label key={opt.key} className={st.toggleRow}>
            <span>
              <strong>{opt.label}</strong>
              <span className={st.toggleHint}>{opt.hint}</span>
            </span>
            <input
              type="checkbox"
              checked={prefs.rig.modules[opt.key]}
              onChange={(e) => setPrefs({ rig: { modules: { ...prefs.rig.modules, [opt.key]: e.target.checked } } })}
            />
          </label>
        ))}
      </section>

      {/* Community map — opt-in public pinning */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Community map</h2>
        </header>
        <label className={st.toggleRow}>
          <span>
            <strong>Enable public Community map</strong>
            <span className={st.toggleHint}>
              Adds the Map tab to the nav and the publish flow on a case.
              Pin a haunt for other operators to see; coordinates are
              coarsened to ~100 m server-side. Hard-blocked when the
              cultural-sensitivity flag is on. Off here = nothing
              published, nothing shown.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.community.enabled}
            onChange={(e) => setPrefs({ community: { ...prefs.community, enabled: e.target.checked } })}
          />
        </label>
      </section>

      {/* Privacy */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Privacy</h2>
        </header>
        <label className={st.toggleRow}>
          <span>
            <strong>Treat all sites as culturally sensitive</strong>
            <span className={st.toggleHint}>
              Disables ALL cloud AI and external network calls for every case on this device. Audio and notes never leave the device. Use this when investigating Country-significant or restricted sites.
            </span>
          </span>
          <input
            type="checkbox"
            checked={prefs.globalCulturalSensitivityFlag}
            onChange={(e) => setPrefs({ globalCulturalSensitivityFlag: e.target.checked })}
          />
        </label>
      </section>

      {/* Deployment health — which server features are configured */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Deployment health</h2>
        </header>
        <DeploymentHealth />
      </section>

      {/* External reviewer sign-offs — methodology blessings logged for export */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>External reviewer sign-off</h2>
          <span className={st.panelBadge}>Forensic</span>
        </header>
        <ReviewerSignoffsPanel />
      </section>

      {/* Pre-air readiness — aggregate status across the methodology gates */}
      <section id="pre-air-readiness" className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Pre-air readiness</h2>
          <span className={st.panelBadge}>Forensic</span>
        </header>
        <PreAirReadinessPanel />
      </section>

      {/* Manifest verifier — reviewer-side integrity check */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Manifest verifier</h2>
          <span className={st.panelBadge}>Forensic</span>
        </header>
        <ManifestVerifier />
      </section>

      {/* Audit log inspector — chain status + recent entries */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Audit log</h2>
          <span className={st.panelBadge}>Forensic</span>
        </header>
        <AuditLogInspector />
      </section>

      {/* Onboarding tour */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Onboarding tour</h2>
          <span className={st.panelBadge}>{onboardingCompletedAt ? "Seen" : "Pending"}</span>
        </header>
        <p className={st.panelLede}>
          {onboardingCompletedAt ? (
            <>You finished the tour on {new Date(onboardingCompletedAt).toLocaleString()}. Replay it any time to refresh on calibration, broadcast, or the privacy posture.</>
          ) : (
            <>You haven't been through the tour yet. It runs automatically the first time you open the app — four short steps covering calibration, broadcast, and how data stays on the device.</>
          )}
        </p>
        {onboardingCompletedAt && (
          <button type="button" className={st.linkBtn ?? ""} onClick={handleReplayTour}>
            Replay tour
          </button>
        )}
      </section>

      {/* Acknowledgement of Country */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>Acknowledgement of Country</h2>
          <span className={st.panelBadge}>{prefs.acknowledgementOfCountry.accepted ? "Acknowledged" : "Pending"}</span>
        </header>
        <p className={st.panelLede}>
          {prefs.acknowledgementOfCountry.accepted ? (
            <>You acknowledged on {new Date(prefs.acknowledgementOfCountry.acceptedAt!).toLocaleString()}. The text below appears on every exported case report.</>
          ) : (
            <>You'll be asked to acknowledge before your first session. The acknowledgement appears in the report.</>
          )}
        </p>
        {prefs.acknowledgementOfCountry.accepted && prefs.acknowledgementOfCountry.statement && (
          <blockquote className={st.statement}>
            {prefs.acknowledgementOfCountry.statement}
          </blockquote>
        )}
      </section>

    </section>
  );
}

/**
 * Sound-check — inline mic test wired against the operator's *current* VAD
 * config. Grabs getUserMedia({audio:true}) on demand, runs MicLevelMeter for
 * the visible peak bar AND startVad with the live thresholds so the operator
 * can see exactly when their voice will trip the auto-duck. Tearing the test
 * down releases the stream so we're not holding the mic open after the
 * operator leaves the panel.
 *
 * Lives inside the VAD config row, only rendered when prefs.vadAutoDuck is
 * ON — Setup.tsx gates the wrapper so the mic-test surface only appears when
 * it's relevant to the feature being configured.
 */
function SoundCheckCard({ vadConfig }: { vadConfig: AppPreferences["vadConfig"] }) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [vadActive, setVadActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef  = useRef<MicLevelMeter | null>(null);
  const vadRef    = useRef<VadHandle | null>(null);

  // Restart VAD whenever the thresholds change while the mic test is live so
  // the operator can drag the sensitivity slider and see the result. The
  // MicLevelMeter doesn't depend on config so it isn't recreated.
  useEffect(() => {
    if (!active || !streamRef.current) return;
    vadRef.current?.stop();
    setVadActive(false);
    try {
      vadRef.current = startVad(streamRef.current, setVadActive, {
        activationDb: vadConfig.sensitivityDb,
        deactivationDb: Math.max(2, vadConfig.sensitivityDb / 2),
        attackMs: vadConfig.attackMs,
        releaseMs: vadConfig.releaseMs,
      });
    } catch { /* swallow — getLevelDb returns -Infinity, UI just shows inactive */ }
  }, [active, vadConfig.sensitivityDb, vadConfig.attackMs, vadConfig.releaseMs]);

  const stop = useCallback(() => {
    vadRef.current?.stop(); vadRef.current = null;
    meterRef.current?.stop(); meterRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActive(false);
    setLevel(0);
    setVadActive(false);
  }, []);

  // Tear down on unmount so a panel close mid-test doesn't leak the mic.
  useEffect(() => () => { stop(); }, [stop]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const meter = new MicLevelMeter(stream);
      meter.start(setLevel);
      meterRef.current = meter;
      setActive(true); // the effect above wires startVad once active flips
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone unavailable");
    }
  }, []);

  return (
    <div className={st.soundCheckRow}>
      <button
        type="button"
        className={st.linkBtn}
        onClick={active ? stop : start}
      >
        {active ? "Stop test" : "Test mic"}
      </button>
      <div className={st.soundCheckMeterWrap}>
        <div className={st.soundCheckMeterBar} aria-hidden="true">
          <span
            className={st.soundCheckMeterFill}
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, level))})` }}
          />
        </div>
        <span className={st.soundCheckHint}>
          {active ? "Speak normally — the bar shows your peak level." : "Tap Test mic to confirm the mic is hot and tune VAD live."}
        </span>
      </div>
      <span className={`${st.soundCheckVadDot} ${vadActive ? st.soundCheckVadActive : ""}`.trim()}>
        {vadActive ? "VAD · trips" : "VAD · idle"}
      </span>
      {error && <p className={st.soundCheckError}>{error}</p>}
    </div>
  );
}

/**
 * Install-this-PWA card. Renders only when the browser exposed an install
 * prompt (Android / desktop Chrome / Edge) or we're on iOS Safari (manual
 * A2HS guidance). Hides when already installed or on browsers that don't
 * support installation (Firefox).
 */
function PwaInstallCard() {
  const status = usePwaInstall();
  const [busy, setBusy] = useState(false);
  if (status.kind === "installed" || status.kind === "unavailable") return null;
  return (
    <section className={st.panel}>
      <header className={st.panelHeader}>
        <h2 className={st.panelTitle}>Install Southern Signal</h2>
      </header>
      <p className={st.panelLede}>
        Installing as a standalone app gives you fullscreen capture without
        the browser chrome, a proper app icon on your home screen, and
        keeps the camera permission grant across launches. Recordings still
        live in the same OPFS storage either way.
      </p>
      {status.kind === "ready" ? (
        <button
          type="button"
          className={st.fileBtn}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await status.prompt();
            setBusy(false);
          }}
        >
          {busy ? "Installing…" : "Install"}
        </button>
      ) : (
        <p className={st.toggleHint}>
          <strong>iOS:</strong> tap the Share button at the bottom of Safari,
          then choose <strong>Add to Home Screen</strong>. The icon will
          launch the camera surface directly into fullscreen.
        </p>
      )}
    </section>
  );
}
