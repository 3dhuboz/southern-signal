import { useEffect, useState } from "react";
import { applyTheme, usePreferences } from "../lib/preferences";
import { deleteApiKey, listProvidersWithKeys, setApiKey } from "../lib/ai/keyStore";
import s from "./View.module.css";
import st from "./Setup.module.css";

export function Setup() {
  const [prefs, setPrefs] = usePreferences();
  const [providersWithKeys, setProvidersWithKeys] = useState<string[]>([]);
  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [keyHasSecret, setKeyHasSecret] = useState(false);

  useEffect(() => {
    void listProvidersWithKeys().then((list) => {
      setProvidersWithKeys(list);
      setKeyHasSecret(list.includes("anthropic"));
    });
  }, []);

  const saveKey = async () => {
    try {
      await setApiKey("anthropic", anthropicKeyInput);
      setAnthropicKeyInput("");
      setKeyMessage("Key saved.");
      setKeyHasSecret(true);
      setProvidersWithKeys(await listProvidersWithKeys());
      setPrefs({ ai: { ...prefs.ai, provider: "anthropic" } });
    } catch (err) {
      setKeyMessage((err as Error).message);
    }
  };

  const removeKey = async () => {
    await deleteApiKey("anthropic");
    setKeyHasSecret(false);
    setProvidersWithKeys(await listProvidersWithKeys());
    setKeyMessage("Key removed.");
    if (prefs.ai.provider === "anthropic") setPrefs({ ai: { ...prefs.ai, provider: null } });
  };

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

      {/* AI assistance */}
      <section className={st.panel}>
        <header className={st.panelHeader}>
          <h2 className={st.panelTitle}>AI assistance</h2>
          <span className={st.panelBadge}>{keyHasSecret ? "Key on file" : "No key"}</span>
        </header>
        <p className={st.panelLede}>
          Bring your own Anthropic API key. We never see it; it stays in this device's encrypted IndexedDB. Used for question generation, mundane-cause hypothesis testing, and report drafting.
        </p>
        <div className={st.field}>
          <label htmlFor="anthropic-key" className={st.fieldLabel}>Anthropic API key</label>
          <input
            id="anthropic-key"
            type="password"
            placeholder={keyHasSecret ? "•••••••••••••• (replace)" : "sk-ant-..."}
            className={st.input}
            value={anthropicKeyInput}
            onChange={(e) => setAnthropicKeyInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={st.actionsRow}>
          <button type="button" className={st.primary} onClick={saveKey} disabled={!anthropicKeyInput.trim()}>Save key</button>
          {keyHasSecret && (
            <button type="button" className={st.danger} onClick={removeKey}>Remove key</button>
          )}
        </div>
        {keyMessage && <p className={st.statusLine}>{keyMessage}</p>}

        <div className={st.fieldRow}>
          <span className={st.fieldLabel}>Default model</span>
          <select
            className={st.input}
            value={prefs.ai.anthropicModel}
            onChange={(e) => setPrefs({ ai: { ...prefs.ai, anthropicModel: e.target.value } })}
          >
            <option value="claude-haiku-4-5">Haiku 4.5 — fastest, cheapest</option>
            <option value="claude-sonnet-4-6">Sonnet 4.6 — recommended</option>
            <option value="claude-opus-4-7">Opus 4.7 — deep reasoning</option>
          </select>
        </div>

        <p className={st.privacyNote}>
          AI calls are routed off-device only when you opt in per case AND the case is not flagged culturally sensitive. Audio is never sent to AI providers in V1.
        </p>
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

      <p className={st.footerNote}>
        Key providers configured: {providersWithKeys.length === 0 ? "none" : providersWithKeys.join(", ")}.
      </p>
    </section>
  );
}
