/**
 * HuntSetup — pre-flight scene picker.
 *
 * The primary configuration surface BEFORE a hunt begins. Operator picks
 * a Scene; the Camera screen then renders that Scene's overlay bundle
 * for the duration of the session. The 14-toggle dock during a hunt is
 * gone — that was the wrong place for config (the F1 cockpit principle:
 * drivers don't tune their dashboard at 200 mph).
 *
 * Five built-in scenes:
 *   Walkthrough · Spirit Box Session · Vigil · Calibration · Pro / Lab
 *
 * Mandatory burnt-in overlays (timestamp + status pills + case ID) are
 * always on regardless of the chosen scene — that's the forensic strip,
 * not optional UI.
 *
 * Each scene card also exposes a "Customise overlays" expand/collapse
 * panel: operators can flip individual overlay toggles for that scene,
 * with per-scene persistence to localStorage. Forensic-mandatory
 * overlays show as always-on and cannot be disabled. Overlays that need
 * sensors not exposed by the device get a small ⚠ amber chip.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  OVERLAY_REGISTRY,
  groupedRegistry,
  type OverlayGroup,
  type OverlayId,
  type OverlayPlugin,
  type SensorDependency,
} from "../lib/overlays/registry";
import {
  BUILT_IN_SCENES,
  DEFAULT_SCENE_ID,
  loadActiveSceneId,
  loadSceneOverrides,
  markSceneEverPicked,
  saveActiveSceneId,
  saveSceneOverrides,
  type Scene,
  type SceneId,
} from "../lib/overlays/scenes";
import s from "./HuntSetup.module.css";

// ── Sensor availability detection ───────────────────────────────────────────
// Run ONCE at module evaluation time inside a useState initialiser; no need
// to re-probe per render. iOS notably hides the Generic Sensor API
// (magnetometer + ambient light), so several overlays warn there.

type SensorAvailability = Record<SensorDependency, boolean>;

function detectSensorAvailability(): SensorAvailability {
  // Window may be undefined in SSR / test contexts — guard defensively.
  const w = typeof window !== "undefined" ? window : ({} as Window);
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  return {
    magnetometer:  "Magnetometer" in w,
    accelerometer: "DeviceMotionEvent" in w,
    audio:         !!nav.mediaDevices?.getUserMedia,
    light:         "AmbientLightSensor" in w,
    geolocation:   "geolocation" in nav,
  };
}

function missingSensors(
  plugin: OverlayPlugin,
  availability: SensorAvailability,
): SensorDependency[] {
  return plugin.sensors.filter((sensor) => !availability[sensor]);
}

// Group order — forensic first, then broadcast, data, instrument, effect,
// bayesian. Mirrors the spec.
const GROUP_ORDER: readonly OverlayGroup[] = [
  "forensic",
  "broadcast",
  "data",
  "instrument",
  "effect",
  "bayesian",
];

const GROUP_LABELS: Record<OverlayGroup, string> = {
  forensic:   "Forensic",
  broadcast:  "Broadcast",
  data:       "Data",
  instrument: "Instruments",
  effect:     "Effects",
  bayesian:   "Bayesian",
};

/**
 * Resolve the *effective* toggle state for a plugin under a scene + the
 * operator's overrides. Forensic-mandatory always wins (true). Otherwise:
 * override > scene > plugin default.
 */
function effectiveEnabled(
  plugin: OverlayPlugin,
  scene: Scene,
  overrides: Partial<Record<OverlayId, boolean>>,
): boolean {
  if (plugin.forensicMandatory) return true;
  if (overrides[plugin.id] !== undefined) return overrides[plugin.id] as boolean;
  if (scene.overlays[plugin.id] !== undefined) return scene.overlays[plugin.id] as boolean;
  return plugin.defaultEnabled;
}

// ── Component ──────────────────────────────────────────────────────────────

export function HuntSetup() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<SceneId>(() => {
    try { return loadActiveSceneId(); }
    catch { return DEFAULT_SCENE_ID; }
  });

  // Per-scene override map — keyed by scene id so flipping a toggle in one
  // scene's customise panel doesn't leak into another's.
  const [overridesBySceneId, setOverridesBySceneId] = useState<Record<SceneId, Partial<Record<OverlayId, boolean>>>>(() => {
    const out = {} as Record<SceneId, Partial<Record<OverlayId, boolean>>>;
    for (const scene of BUILT_IN_SCENES) {
      try { out[scene.id] = loadSceneOverrides(scene.id); }
      catch { out[scene.id] = {}; }
    }
    return out;
  });

  // Which scene's customise panel is open. Only one expanded at a time so
  // the page doesn't turn into a wall of toggles.
  const [expandedSceneId, setExpandedSceneId] = useState<SceneId | null>(null);

  // Sensor detection — capture once per mount. Sensor exposure cannot change
  // without a page reload (it's a property of the runtime, not state).
  const [sensorAvailability] = useState<SensorAvailability>(detectSensorAvailability);

  // Memoise the grouped registry — pure function of static input.
  const grouped = useMemo(() => groupedRegistry(), []);

  const handleStart = () => {
    saveActiveSceneId(selected);
    // Persist whichever scene the operator is starting with; other scenes'
    // overrides were already persisted as they were toggled.
    saveSceneOverrides(selected, overridesBySceneId[selected] ?? {});
    markSceneEverPicked();
    navigate("/");
  };

  const handleToggleOverride = (sceneId: SceneId, plugin: OverlayPlugin) => {
    // Forensic-mandatory can't be flipped — short-circuit defensively even
    // though the UI disables the input.
    if (plugin.forensicMandatory) return;
    setOverridesBySceneId((prev) => {
      const sceneOverrides = { ...(prev[sceneId] ?? {}) };
      const scene = BUILT_IN_SCENES.find((sc) => sc.id === sceneId)!;
      const currentEffective = effectiveEnabled(plugin, scene, sceneOverrides);
      const nextEffective = !currentEffective;

      // Decide what the scene's "baseline" expectation is so we only store an
      // override when it actually diverges from that baseline. Keeps storage
      // sparse and lets operators "reset" by toggling back to the baseline.
      const baseline = scene.overlays[plugin.id] !== undefined
        ? scene.overlays[plugin.id] as boolean
        : plugin.defaultEnabled;

      if (nextEffective === baseline) {
        delete sceneOverrides[plugin.id];
      } else {
        sceneOverrides[plugin.id] = nextEffective;
      }

      // Persist immediately — operator expectation is that toggles "stick"
      // even if they bail out of HuntSetup without pressing Start.
      saveSceneOverrides(sceneId, sceneOverrides);

      return { ...prev, [sceneId]: sceneOverrides };
    });
  };

  return (
    <div className={s.screen}>
      <div className={s.eyebrow}>Pre-flight</div>
      <h1 className={s.title}>Hunt Setup</h1>
      <p className={s.subtitle}>
        Pick a scene before you begin. Each scene bundles a different set
        of overlays burnt into the recording and live stream.
        Timestamp, recording-state pills, and case ID are always on for
        forensic-chain integrity.
      </p>

      <div className={s.scenes} role="radiogroup" aria-label="Available scenes">
        {BUILT_IN_SCENES.map((scene) => {
          const isSelected = scene.id === selected;
          const isPro = scene.id === "pro_lab";
          const isExpanded = expandedSceneId === scene.id;
          const overrides = overridesBySceneId[scene.id] ?? {};
          const customisedCount = Object.keys(overrides).length;

          return (
            <div
              key={scene.id}
              className={`${s.scene} ${isSelected ? s.sceneSelected : ""}`.trim()}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={s.sceneButton}
                onClick={() => setSelected(scene.id)}
              >
                <div className={s.sceneHeader}>
                  <span className={s.sceneRadio} aria-hidden="true" />
                  <span className={s.sceneName}>{scene.name}</span>
                  {isPro && <span className={s.proBadge}>Pro</span>}
                </div>
                <p className={s.sceneDescription}>{scene.description}</p>
              </button>

              {/* Customise expand/collapse — a sibling row inside the card,
                  outside the radio button so its own clicks don't toggle
                  scene selection. */}
              <button
                type="button"
                className={s.customiseToggle}
                aria-expanded={isExpanded}
                aria-controls={`customise-${scene.id}`}
                onClick={() => setExpandedSceneId(isExpanded ? null : scene.id)}
              >
                <span className={s.customiseToggleLabel}>
                  Customise overlays
                  {customisedCount > 0 && (
                    <span className={s.customiseCountBadge} aria-label={`${customisedCount} customised`}>
                      {customisedCount}
                    </span>
                  )}
                </span>
                <span className={s.customiseChevron} aria-hidden="true">
                  {isExpanded ? "▴" : "▾"}
                </span>
              </button>

              {isExpanded && (
                <div
                  id={`customise-${scene.id}`}
                  className={s.customisePanel}
                  role="group"
                  aria-label={`Customise overlays for ${scene.name}`}
                >
                  {GROUP_ORDER.map((groupKey) => {
                    const groupPlugins = grouped[groupKey];
                    if (!groupPlugins || groupPlugins.length === 0) return null;
                    return (
                      <div key={groupKey} className={s.customiseGroup}>
                        <div className={s.customiseGroupLabel}>{GROUP_LABELS[groupKey]}</div>
                        <ul className={s.customiseList}>
                          {groupPlugins.map((plugin) => {
                            const enabled = effectiveEnabled(plugin, scene, overrides);
                            const missing = missingSensors(plugin, sensorAvailability);
                            const hasMissingSensors = missing.length > 0;
                            const isMandatory = plugin.forensicMandatory === true;
                            return (
                              <li key={plugin.id} className={s.customiseRow}>
                                <div className={s.customiseRowText}>
                                  <div className={s.customiseRowHead}>
                                    <span className={s.customiseRowName}>{plugin.name}</span>
                                    {isMandatory && (
                                      <span className={s.alwaysOnChip} title="Forensic chain — cannot be turned off">
                                        Always on
                                      </span>
                                    )}
                                    {hasMissingSensors && (
                                      <span
                                        className={s.sensorWarnChip}
                                        title={`Missing sensor${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. This overlay may not work on this device.`}
                                        aria-label={`Warning: missing sensor${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`}
                                      >
                                        <span aria-hidden="true">⚠</span> {missing.join(" · ")}
                                      </span>
                                    )}
                                  </div>
                                  <p className={s.customiseRowDesc}>{plugin.description}</p>
                                </div>
                                <label
                                  className={`${s.customiseSwitch} ${isMandatory ? s.customiseSwitchDisabled : ""}`.trim()}
                                  aria-label={`Toggle ${plugin.name}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    disabled={isMandatory}
                                    onChange={() => handleToggleOverride(scene.id, plugin)}
                                  />
                                  <span className={s.customiseSwitchTrack} aria-hidden="true" />
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                  {/* Sanity assertion: every registry entry should appear in
                      exactly one group above. If a group ever gets a new
                      member that doesn't fit GROUP_ORDER, surface it here
                      rather than silently dropping it. */}
                  {OVERLAY_REGISTRY.some((p) => !GROUP_ORDER.includes(p.group)) && (
                    <div className={s.customiseFallbackWarn}>
                      Some overlays are missing from the customise panel. Reload the app.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={s.footer}>
        <button type="button" className={s.startBtn} onClick={handleStart}>
          Start hunt with this scene
          <span className={s.startBtnArrow} aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
