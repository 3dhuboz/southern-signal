/**
 * BroadcastSceneSelector — top-right chip that opens the scene picker.
 *
 * Replaces the bare unicode-chevron button the camera shipped with. Same
 * glass + hairline cyan shell as the BroadcastBug, mirrored to the right.
 * Title-cases the scene name (no SHOUTY caps) and uses a clean SVG chevron
 * — the unicode ▼ glyph the old chip used renders inconsistently across
 * Android Chrome / iOS Safari / desktop.
 *
 * Tap target: WCAG 2.5.5 minimum 44 × 44 css px. The visible chip is ~36
 * tall but a pseudo-element extends the hit region downward, matching the
 * pattern the original cornerPillTopRight used.
 *
 * The chip is presentation-only — it just calls `onOpen`. The parent
 * (CameraScreen) owns the SceneSheet open/close state and the actual
 * sheet UI. We keep no internal state here so the SceneSheet remains the
 * single source of truth for picker visibility.
 */
import s from "./BroadcastSceneSelector.module.css";

interface Props {
  /** Active scene's display name (Scene type guarantees a non-empty
   *  human-readable label). Falls back to "Walkthrough" in the parent
   *  if no scene is resolved. */
  sceneName: string;
  /** Optional eyebrow above the scene name. Defaults to "SCENE". Lets
   *  the chip read as "SCENE / Walkthrough" instead of a bare name, so
   *  first-time operators understand what the chip does. */
  eyebrow?: string;
  /** Called when the chip is tapped — parent opens the SceneSheet. */
  onOpen: () => void;
}

/** Clean SVG chevron — replaces the unicode ▼ glyph that rendered ugly
 *  on Android Chrome. Sized to match the BroadcastBug's mark glyph. */
function Chevron() {
  return (
    <svg
      viewBox="0 0 12 8"
      xmlns="http://www.w3.org/2000/svg"
      className={s.chevron}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M1.5 2 L6 6 L10.5 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function BroadcastSceneSelector({ sceneName, eyebrow = "SCENE", onOpen }: Props) {
  return (
    <button
      type="button"
      className={s.chip}
      onClick={onOpen}
      aria-label={`Scene: ${sceneName}. Tap to change.`}
      title="Change scene"
    >
      <span className={s.body}>
        <span className={s.eyebrow}>{eyebrow}</span>
        <span className={s.name}>{sceneName}</span>
      </span>
      <Chevron />
    </button>
  );
}
