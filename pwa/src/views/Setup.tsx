import { useEffect } from "react";
import { applyTheme, usePreferences } from "../lib/preferences";
import s from "./View.module.css";
import st from "./Setup.module.css";

export function Setup() {
  const [prefs, setPrefs] = usePreferences();

  useEffect(() => { /* no key listing needed — AI is server-side */ }, []);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Setup</span>
        <h1 className={s.title}>Settings</h1>
        <p className={s.lede}>Theme, AI assistance, privacy. Keys stay on this device.</p>
      </div>

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
        </div>
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
