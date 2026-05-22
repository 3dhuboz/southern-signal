/**
 * CameraShutter — the BIG SHUTTER button anchored above the dock.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * The visual contract (88x88 circular target, red-when-idle, white-with-red-
 * square-when-recording, scale-on-active) is preserved verbatim — only the
 * JSX + module.css co-locate alongside the rest of the camera/ family
 * (CameraDock, CameraDeviceChip, …) instead of bloating CameraScreen.
 *
 * State machine (handled entirely by the parent — this is pure presentation):
 *
 *   running ── disabled? ─── busy? ──── label / title ──────── shutterRecording class
 *     no       false          false      "Begin session"        no
 *     no       true           true       "Begin session"        no   (disabled visual)
 *     yes      false          false      "End session"          yes
 *     yes      true           true       "End session"          yes  (disabled visual)
 *
 * Tokens consumed: --shutter-bg / --shutter-ring / --shutter-rec-bg /
 * --shutter-rec-core / --focus-ring (Wave 1A tokenisation pass).
 */
import s from "./CameraShutter.module.css";

export interface CameraShutterProps {
  /** True while a session is running — toggles the visual + label. */
  running: boolean;
  /** True while the begin/end transition is in flight — suppresses re-fires. */
  busy: boolean;
  /** Fires on click. Parent picks between handleBegin / handleStop based on
   *  `running`; the shutter doesn't know which side of the toggle it's on. */
  onClick: () => void;
}

export function CameraShutter({ running, busy, onClick }: CameraShutterProps) {
  return (
    <button
      type="button"
      className={`${s.shutter} ${running ? s.shutterRecording : ""}`.trim()}
      onClick={onClick}
      disabled={busy}
      aria-label={running ? "End session" : "Begin session"}
      title={running ? "End session" : "Begin session"}
    >
      <span className={s.shutterCore} aria-hidden="true" />
    </button>
  );
}
