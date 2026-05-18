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
  /** AI Investigator (venue archive deep-dive) preferences. */
  research: {
    /**
     * Master switch. When false the /research route + every entry point
     * (SimpleMissionView quick-action tile, CaseManager link, snapshot
     * card, MissionControl details) is hidden. Default ON.
     *
     * Cultural-sensitivity flags (global + per-case) sit *above* this —
     * even with research.enabled = true, a sensitive case is still
     * hard-blocked. This switch is for operators who don't want cloud
     * AI in their workflow at all, period.
     */
    enabled: boolean;
  };
  /**
   * Rig loadout — which Pro-tier instrument tiles render in Mission
   * Control. Lets the operator compose a venue-specific kit
   * (outdoor-cemetery vs. indoor-house vs. minimal-record) instead of
   * scrolling past tools they don't need.
   *
   * Simple-mode tiles are always shown. The rig only gates the Pro tools:
   * spirit box, Ovilus, bait tone, camera, contamination markers, Estes
   * tile, sensor inventory panel, and the new EMF spike LEDs +
   * simultaneous video+EVP capture.
   */
  rig: {
    modules: {
      emfSpikeLed: boolean;
      spiritBox: boolean;
      ovilus: boolean;
      baitTone: boolean;
      camera: boolean;
      contaminationMarkers: boolean;
      sensorsPanel: boolean;
      estesTile: boolean;
      /** When ON, the in-session "Record video+EVP" tile records a video
       *  clip with synchronized mic audio so both end up on the same
       *  evidence reel. */
      videoEvpCapture: boolean;
      /** Honest stick-figure motion tracker (camera + frame-difference +
       *  human-shape heuristic). Not a true SLS — no IR depth sensor — but
       *  it surfaces "person-shaped motion" with stick-figure overlays. */
      slsTracker: boolean;
    };
  };
  /** Community map — opt-in publish-and-browse of pinned haunt sites. */
  community: {
    /** Master switch for the Community map route + nav entry. Default ON
     *  but every publish is still an explicit per-case action. */
    enabled: boolean;
    /** Auto-generated anonymous id used to tag pins this device created
     *  (lets the operator delete their own pins without an account). */
    anonymousId: string | null;
  };
  /**
   * Pro / Lab mode — surfaces the full MissionControl panel (sensors panel,
   * Bayesian posterior breakdowns, all ITC tools) as a "Lab" tab in the
   * bottom nav. Default OFF — the streaming-first surface stays focused
   * on the broadcast rig; power users opt in for review-grade work.
   */
  proMode: boolean;
  /**
   * Headphone monitoring for the ITC mixer. When ON, the synthesised tones
   * (spirit box / ovilus / future EVP synths) ALSO route to ctx.destination
   * so the operator can hear them through plugged-in headphones. Default OFF
   * because routing through speakers feedback-loops back into the mic and
   * defeats the no-speakers fix the mixer exists for — operator only enables
   * this when monitoring through headphones.
   */
  itcMonitor: boolean;
  /**
   * Voice-activity-driven auto-ducking of the ITC mixer. When ON, the camera
   * surface watches the mic stream and ducks the tones whenever the operator
   * is speaking — no long-press required. Long-press PTT still works as a
   * manual override. Default OFF because VAD thresholds aren't a one-size-
   * fits-all proposition (noisy outdoor hunts vs quiet attics).
   */
  vadAutoDuck: boolean;
  /**
   * Operator-level overrides for the mid-session preflight watchdog. When
   * non-null, these supersede the module defaults for ALL scenes —
   * useful for power users running on devices with a different
   * risk profile than the canned defaults assume. Scenes that explicitly
   * set their own override still win (scene > pref > module default).
   *
   * lowBatteryFraction: battery level (0..1) under which the watchdog warns.
   * minStorageMb: free storage (MB) under which the watchdog blocks.
   */
  preflight: {
    lowBatteryFraction: number | null;
    minStorageMb: number | null;
  };
  /**
   * Tuning for the VAD detector. All thresholds are relative to the adaptive
   * noise floor — sensitivity is the activation threshold in dB above the
   * floor (lower = more sensitive, fires on quieter voices but more prone to
   * false-positives on outdoor wind / HVAC). attackMs / releaseMs govern how
   * long the signal must stay above/below threshold before flipping; bumping
   * them up smooths out fast chatter at the cost of a perceptible delay.
   */
  vadConfig: {
    sensitivityDb: number;
    attackMs: number;
    releaseMs: number;
    /**
     * Saved noise-floor estimate from a Sound-Check session. When present, a
     * new VAD instance can seed its adaptive floor here instead of the
     * pessimistic -50 dB default — operators in consistent rooms get an
     * instantly-correct trigger threshold without waiting for the EMA to
     * adapt during the first few seconds of a hunt. null = unseeded.
     */
    noiseFloorDb: number | null;
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
  research: { enabled: true },
  rig: {
    modules: {
      emfSpikeLed: true,
      spiritBox: true,
      ovilus: true,
      baitTone: true,
      camera: true,
      contaminationMarkers: true,
      sensorsPanel: true,
      estesTile: true,
      videoEvpCapture: true,
      slsTracker: true,
    },
  },
  community: { enabled: true, anonymousId: null },
  proMode: false,
  itcMonitor: false,
  vadAutoDuck: false,
  preflight: { lowBatteryFraction: null, minStorageMb: null },
  vadConfig: { sensitivityDb: 12, attackMs: 120, releaseMs: 350, noiseFloorDb: null },
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
      research: { ...DEFAULTS.research, ...(parsed.research ?? {}) },
      rig: {
        modules: { ...DEFAULTS.rig.modules, ...(parsed.rig?.modules ?? {}) },
      },
      community: { ...DEFAULTS.community, ...(parsed.community ?? {}) },
      preflight: { ...DEFAULTS.preflight, ...(parsed.preflight ?? {}) },
      vadConfig: { ...DEFAULTS.vadConfig, ...(parsed.vadConfig ?? {}) },
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
    research: { ...current.research, ...(patch.research ?? {}) },
    rig: {
      modules: { ...current.rig.modules, ...(patch.rig?.modules ?? {}) },
    },
    community: { ...current.community, ...(patch.community ?? {}) },
    preflight: { ...current.preflight, ...(patch.preflight ?? {}) },
    vadConfig: { ...current.vadConfig, ...(patch.vadConfig ?? {}) },
  };
  write(next);
  return next;
}

/** Read or mint the anonymous community id. Survives across cases on this
 *  device; lets the operator delete their own pins without an account. */
export function getOrCreateAnonymousCommunityId(): string {
  const prefs = read();
  if (prefs.community.anonymousId) return prefs.community.anonymousId;
  const id = crypto.randomUUID();
  setPreferences({ community: { ...prefs.community, anonymousId: id } });
  return id;
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
