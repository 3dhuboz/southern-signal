/**
 * SceneSheet — inline bottom-sheet scene picker for the camera surface.
 *
 * Operators tap the active-scene chip on the camera screen to swap presets
 * mid-session without leaving the viewfinder. This sheet renders the same
 * BUILT_IN_SCENES list HuntSetup uses, mirroring the order so muscle memory
 * carries between the two surfaces. Picking a scene fires `onSelect` and
 * then closes; an explicit "Customise overlays…" footer link routes to
 * HuntSetup for the deeper config flow.
 *
 * Rendering: backdrop + sheet are always present in the DOM and CSS-faded
 * via the `open` flag so we get a CSS-only slide animation on entry/exit.
 * The sheet sets `display: none` when closed so it can't trap focus or
 * intercept pointer events on the camera frame underneath.
 */

import { useNavigate } from "react-router-dom";
import { BUILT_IN_SCENES, type SceneId } from "../lib/overlays/scenes";
import s from "./SceneSheet.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  activeSceneId: SceneId;
  onSelect: (sceneId: SceneId) => void;
}

export function SceneSheet({ open, onClose, activeSceneId, onSelect }: Props) {
  const navigate = useNavigate();
  // We render nothing when closed — keeps the camera surface free of an
  // invisible-but-still-mounted dialog stealing pointer events.
  if (!open) return null;
  return (
    <>
      <div className={s.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={s.sheet} role="dialog" aria-label="Pick a scene">
        <div className={s.handle} aria-hidden="true" />
        <h2 className={s.title}>Scene</h2>
        {BUILT_IN_SCENES.map((scene) => {
          const isActive = scene.id === activeSceneId;
          return (
            <button
              key={scene.id}
              type="button"
              className={`${s.sceneRow} ${isActive ? s.sceneRowActive : ""}`.trim()}
              onClick={() => {
                onSelect(scene.id);
                onClose();
              }}
            >
              <span
                className={`${s.sceneRadio} ${isActive ? s.sceneRadioActive : ""}`.trim()}
                aria-hidden="true"
              />
              <div className={s.sceneText}>
                <div className={s.sceneName}>{scene.name}</div>
                <div className={s.sceneDesc}>{scene.description}</div>
              </div>
            </button>
          );
        })}
        <button
          type="button"
          className={s.customiseLink}
          onClick={() => {
            onClose();
            navigate("/hunt-setup");
          }}
        >
          Customise overlays…
        </button>
      </div>
    </>
  );
}
