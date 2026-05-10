/**
 * User preferences — stored in localStorage for V1 (small JSON, fast reads).
 *
 * API keys live in IndexedDB instead — see keyStore.ts. They're segregated
 * because keys deserve a stricter handling story (less prone to leaking via
 * accidental localStorage exfil, separate clear-all UX, optional encryption
 * later).
 */

import { useEffect, useState } from "react";

export type Theme = "phosphor" | "scotopic" | "daylight";
export type ScotopicLevel = "dim" | "mid" | "max";
export type ExperienceMode = "simple" | "pro";

export interface AppPreferences {
  theme: Theme;
  /** Brightness preset for scotopic mode — only consulted when theme === "scotopic". */
  scotopicLevel: ScotopicLevel;
  /** When true and geolocation is granted, suggest scotopic mode after civil twilight. */
  scotopicAutoEngage: boolean;
  /** Friendly default for amateurs; "pro" surfaces posterior/log-LR/Merkle math. */
  experienceMode: ExperienceMode;
  acknowledgementOfCountry: {
    accepted: boolean;
    acceptedAt: string | null;
    /** Free-text acknowledgement the user typed/recorded (for the case file). */
    statement: string | null;
  };
  ai: {
    provider: "anthropic" | "openai" | "gemini" | "openrouter" | null;
    /** Hard-coded refusal of cloud AI for cases flagged sensitive — defended in cloudAi.ts. */
    blockOnSensitive: true;
    /** Default model per provider. */
    anthropicModel: string;
    /** Default OpenRouter model (slug like "anthropic/claude-sonnet-4.6"). */
    openrouterModel: string;
  };
  /** Investigators tag the current site as culturally sensitive — disables ALL cloud AI for this device's cases until untoggled. */
  globalCulturalSensitivityFlag: boolean;
  /** Cloud sync (R2/D1) — opt-in. Disabled when the cultural-sensitivity flag is on. */
  sync: {
    enabled: boolean;
    /** Full URL to the upload endpoint, e.g. https://southern-signal.pages.dev/api/sync/upload */
    endpoint: string;
    /** Bearer token (matches env.SYNC_TOKEN on the deployment). */
    token: string | null;
  };
  /** EVP capture preferences. */
  evp: {
    /**
     * When true and the case isn't culturally sensitive, fire cloud Whisper
     * transcription on the full clip immediately after a recording is saved.
     * Default OFF — operators opt in to send audio off-device.
     */
    autoTranscribe: boolean;
  };
}

const DEFAULTS: AppPreferences = {
  theme: "phosphor",
  scotopicLevel: "mid",
  scotopicAutoEngage: true,
  experienceMode: "simple",
  acknowledgementOfCountry: { accepted: false, acceptedAt: null, statement: null },
  ai: { provider: null, blockOnSensitive: true, anthropicModel: "claude-sonnet-4-6", openrouterModel: "anthropic/claude-sonnet-4.6" },
  globalCulturalSensitivityFlag: false,
  sync: { enabled: false, endpoint: "", token: null },
  evp: { autoTranscribe: false },
};

const KEY = "ss-preferences-v1";
const subscribers = new Set<(p: AppPreferences) => void>();

function read(): AppPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    return {
      ...DEFAULTS,
      ...parsed,
      acknowledgementOfCountry: { ...DEFAULTS.acknowledgementOfCountry, ...(parsed.acknowledgementOfCountry ?? {}) },
      ai: { ...DEFAULTS.ai, ...(parsed.ai ?? {}), blockOnSensitive: true },
      sync: { ...DEFAULTS.sync, ...(parsed.sync ?? {}) },
      evp: { ...DEFAULTS.evp, ...(parsed.evp ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

function write(prefs: AppPreferences): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  for (const fn of subscribers) fn(prefs);
}

export function getPreferences(): AppPreferences {
  return read();
}

export function setPreferences(patch: Partial<AppPreferences>): AppPreferences {
  const current = read();
  const next: AppPreferences = {
    ...current,
    ...patch,
    acknowledgementOfCountry: { ...current.acknowledgementOfCountry, ...(patch.acknowledgementOfCountry ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}), blockOnSensitive: true },
    sync: { ...current.sync, ...(patch.sync ?? {}) },
    evp: { ...current.evp, ...(patch.evp ?? {}) },
  };
  write(next);
  return next;
}

export function usePreferences(): [AppPreferences, (patch: Partial<AppPreferences>) => void] {
  const [prefs, setPrefs] = useState<AppPreferences>(read);
  useEffect(() => {
    const fn = (p: AppPreferences) => setPrefs(p);
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }, []);
  return [prefs, setPreferences];
}

/** Apply theme class to <html> so CSS can switch palettes. */
export function applyTheme(theme: Theme, level?: ScotopicLevel): void {
  document.documentElement.dataset.theme = theme;
  if (theme === "scotopic") {
    document.documentElement.dataset.scotopicLevel = level ?? "mid";
  } else {
    delete document.documentElement.dataset.scotopicLevel;
  }
}
