/**
 * CameraNoVideoOverlay — fallback surface for the camera route when the
 * live preview isn't actually rendering.
 *
 * Why this exists (was previously inline in CameraScreen.tsx):
 *
 *   The camera surface stacks backdrop-blur glass panels (BroadcastBug,
 *   BroadcastSceneSelector, BroadcastSensorHud, …). Backdrop-blur SAMPLES
 *   whatever is behind it — if the video element underneath isn't yet
 *   painting frames (permission idle, getUserMedia in flight, or hardware
 *   error), the glass panels see straight through the page to whatever
 *   the browser was compositing previously (on mobile Chrome that turns
 *   out to be the previous tab). This overlay paints a guaranteed-opaque
 *   dark backdrop over the camera area while the no-stream states are
 *   active so the glass HUD always has a clean dark canvas to sample.
 *
 * Contract:
 *   - Pure presentational. CameraScreen owns the state machine (driven
 *     by LiveStreamView.onOpenStateChange) and just hands the current
 *     state + retry handler in.
 *   - Renders `null` when state === "streaming" (the live preview owns
 *     the surface from there).
 *   - Glass card has role="dialog" + aria-modal="false" + a labelled
 *     heading so screen readers announce the prompt without trapping
 *     focus the way a true modal would.
 *
 * Lifted into its own file (was inline in views/CameraScreen.tsx) so the
 * state-machine behaviour can be pinned by focused tests without dragging
 * CameraScreen's 30+ heavy module imports into the test runner.
 */
import s from "./CameraNoVideoOverlay.module.css";

export type CameraOpenState = "idle" | "opening" | "streaming" | "error";

interface Props {
  /** Current camera open state — drives copy + which buttons render. */
  state: CameraOpenState;
  /** Error text to show under the "Camera unavailable" heading. Only
   *  surfaced when `state === "error"`. */
  errorText?: string | null;
  /** Tapped by the "Allow camera + mic" button (when state === "idle"). */
  onAllowAccess: () => void;
  /** Tapped by the "Retry" button (when state === "error"). */
  onRetry: () => void;
}

/** Loading spinner SVG. aria-hidden because the surrounding card carries
 *  the live region — duplicating the spinner as an accessible name would
 *  just add noise. */
function SpinnerGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path
        d="M12 3 a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

/** Strikethrough-camera glyph used for the error state. */
function CameraOffGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="36"
      height="36"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="6.5" width="14" height="11" rx="2" />
      <path d="M16.5 10 L21 7.5 V16.5 L16.5 14 Z" />
      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Camera glyph used for the idle (first-load) state. */
function CameraGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="36"
      height="36"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="6.5" width="14" height="11" rx="2" />
      <path d="M16.5 10 L21 7.5 V16.5 L16.5 14 Z" />
    </svg>
  );
}

export function CameraNoVideoOverlay({ state, errorText, onAllowAccess, onRetry }: Props) {
  // Streaming → live preview owns the surface; render nothing. Important
  // that this short-circuit happens before any DOM is touched so the test
  // can assert `container` is empty.
  if (state === "streaming") return null;

  const title =
    state === "opening" ? "Starting camera…" :
    state === "error"   ? "Camera unavailable" :
                          "Camera permission required";

  const body =
    state === "opening" ? "Waiting on the browser to hand us the camera + mic." :
    state === "error"   ? (errorText ?? "We couldn't open the camera.") :
                          "Southern Signal needs camera + microphone access to show the live feed, record clips, and stream. Your video stays on this device unless you go live.";

  const icon =
    state === "opening" ? <SpinnerGlyph /> :
    state === "error"   ? <CameraOffGlyph /> :
                          <CameraGlyph />;

  return (
    <div
      className={s.overlay}
      role="dialog"
      aria-modal="false"
      aria-labelledby="ss-novideo-title"
      data-novideo-pinned
      data-state={state}
    >
      <div className={s.card}>
        <div className={s.icon}>{icon}</div>
        <h2 id="ss-novideo-title" className={s.title}>{title}</h2>
        <p className={s.body}>{body}</p>
        {state !== "opening" && (
          <button
            type="button"
            className={s.cta}
            onClick={state === "error" ? onRetry : onAllowAccess}
          >
            {state === "error" ? "Retry" : "Allow camera + mic"}
          </button>
        )}
        {state === "error" && (
          <p className={s.hint}>
            If the prompt didn't appear, open your browser's site settings and re-enable camera and microphone for this page.
          </p>
        )}
      </div>
    </div>
  );
}
