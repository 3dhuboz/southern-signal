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
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BUILT_IN_SCENES,
  DEFAULT_SCENE_ID,
  loadActiveSceneId,
  markSceneEverPicked,
  saveActiveSceneId,
  type SceneId,
} from "../lib/overlays/scenes";
import s from "./HuntSetup.module.css";

export function HuntSetup() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<SceneId>(() => {
    try { return loadActiveSceneId(); }
    catch { return DEFAULT_SCENE_ID; }
  });

  const handleStart = () => {
    saveActiveSceneId(selected);
    markSceneEverPicked();
    navigate("/");
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
          return (
            <button
              key={scene.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`${s.scene} ${isSelected ? s.sceneSelected : ""}`.trim()}
              onClick={() => setSelected(scene.id)}
            >
              <div className={s.sceneHeader}>
                <span className={s.sceneRadio} aria-hidden="true" />
                <span className={s.sceneName}>{scene.name}</span>
                {isPro && <span className={s.proBadge}>Pro</span>}
              </div>
              <p className={s.sceneDescription}>{scene.description}</p>
            </button>
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
