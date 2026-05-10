import { useCallback, useEffect, useState } from "react";
import { applyTheme, usePreferences } from "../lib/preferences";
import { CaseManager } from "../components/CaseManager";
import { SyncPanel } from "../components/SyncPanel";
import s from "./View.module.css";
import st from "./Setup.module.css";

const ONBOARDING_KEY = "ss-onboarding-completed-v1";

export function Setup() {
  const [prefs, setPrefs] = usePreferences();
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | null>(() => {
    try { return localStorage.getItem(ONBOARDING_KEY); } catch { return null; }
  });

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

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Setup · Case manager</span>
        <h1 className={s.title}>Cases, theme, privacy</h1>
        <p className={s.lede}>Manage all investigations on this device. Edit metadata, browse media, set disposition, export, or delete. AI keys are server-side — nothing to configure here.</p>
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


      {/* Cloud sync (R2 + D1) */}
      <SyncPanel />

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
