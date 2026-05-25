/**
 * CameraDock — redesigned bottom dock for the camera surface.
 *
 * Replaces the previous dockSlim inline JSX in CameraScreen.tsx. The UX
 * brief was simple: kill the cryptic 3-letter labels (SCR / Clip / Rear /
 * Front), get full-word labels with icons inline, keep the row dense
 * enough that all the actions still fit on a 360-px-wide phone.
 *
 * Layout (single 56-px tall row, BIG SHUTTER absolutely-positioned above
 * it by the parent):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Scenes  ●Markers   [BIG SHUTTER]   ●Clip  ▣Screen  ↺Lens  ⚡Torch │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Why one row instead of the 2-tier UX-spec proposal: the spec wanted a
 * second row above the shutter for "Markers / Lens / Torch / More", but
 * (a) putting actionable chrome above the shutter on a 360-px-wide phone
 * pushes into the lower-third reserved space, and (b) full-word labels
 * already solve the legibility complaint without the layout fragility of
 * a second floating row. The worker report documents this choice;
 * upgrading to 2-tier is a clean follow-up if Steve wants it.
 *
 * Token usage:
 *   --dock-bg / --dock-rim / --dock-text → idle button chrome
 *   --dock-rec-bg / --dock-rec-rim / --dock-rec-text → active state
 *   --hud-glass-bg-strong → hover state (matches the rest of the HUD)
 *
 * Touch targets meet WCAG 2.5.5 — 44 css px min on every interactive
 * surface. Wave 3 will audit; built to spec already.
 *
 * ScreenRecordButton is passed through as a child via the parent because
 * it owns its own iOS / Android branch (the iOS tip dialog). Wrapping it
 * here would duplicate that branch.
 */

import { type RefObject } from "react";
import { ScreenRecordButton } from "../ScreenRecordButton";
import s from "./CameraDock.module.css";

// ── Dock button icons ──────────────────────────────────────────────────
// Inlined SVG so the dock doesn't pull in an icon dependency for six
// glyphs. Same visual style as the icons that already lived inline in
// CameraScreen.tsx for ScreenRecordButton / Flip / Torch — kept here so
// the dock's import surface is self-contained.

function IconScenes() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="0.8" fill="currentColor" />
    </svg>
  );
}

function IconMarkers() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconHud() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 9h8M8 15h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="9" r="1.6" fill="currentColor" />
      <circle cx="14" cy="15" r="1.6" fill="currentColor" />
    </svg>
  );
}

function IconRecord() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="7" fill="currentColor" />
    </svg>
  );
}

function IconLive() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}

function IconLens() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="2" y="7" width="20" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="14" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 4.5 Q12 2 15 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <polyline points="13.5,3 15,4.5 13.5,6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTorch() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M9 2 H15 L20 21 H4 Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="8.5" y="0.5" width="7" height="3.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="2.25" r="1" fill="currentColor" />
    </svg>
  );
}

export interface CameraDockProps {
  /** Active scene — drives the simplifiedDock visibility gate. Null when no
   *  scene is resolved (defensive default, falls through to full dock). */
  simplifiedDock: boolean;
  /** EVP capture already has its own camera HUD; on narrow phones, suppress
   *  the secondary dock so the recorded frame stays presenter-clean. */
  evpMode?: boolean;
  /** Broadcast-state slice the dock cares about: whether an in-app clip
   *  is recording so the Clip button can reflect it. */
  broadcastRecording: boolean;
  /** True while WHIP is actively broadcasting. */
  broadcastLive: boolean;
  /** Camera-state slice: stream open + facing + torch availability. */
  cameraState: {
    streamOn: boolean;
    whipConfigured: boolean;
    facingMode: "environment" | "user";
    torchSupported: boolean;
    torchOn: boolean;
  };
  /** Inline clip-record toggle — fires LiveStreamView's MediaRecorder. */
  recordToggleRef: RefObject<(() => void) | null>;
  /** WHIP broadcast toggle — fires LiveStreamView's live workflow. */
  liveToggleRef: RefObject<(() => void) | null>;
  /** Flip-camera toggle. */
  flipCameraRef: RefObject<(() => void) | null>;
  /** Torch on/off — only renders when cameraState.torchSupported. */
  torchToggleRef: RefObject<(() => void) | null>;
  /** Opens the scene picker (parent owns SceneSheet state). */
  onScenesOpen: () => void;
  onHudOpen: () => void;
  /** Opens the broadcast setup surface when no WHIP destination is ready. */
  onLiveSetupOpen: () => void;
  /** Navigates to /review — the marker review tab. */
  onMarkersOpen: () => void;
  /** Investigation id for the embedded ScreenRecordButton (so its
   *  recording.start / recording.stop entries hash-chain into the
   *  active case's audit chain). Null when no session has started. */
  investigationId: string | null;
}

export function CameraDock({
  simplifiedDock,
  evpMode = false,
  broadcastRecording,
  broadcastLive,
  cameraState,
  recordToggleRef,
  liveToggleRef,
  flipCameraRef,
  torchToggleRef,
  onScenesOpen,
  onHudOpen,
  onLiveSetupOpen,
  onMarkersOpen,
  investigationId,
}: CameraDockProps) {
  const hasLiveDestination = cameraState.whipConfigured;
  const liveLabel = broadcastLive ? "End live" : hasLiveDestination ? "Go live" : "Live setup";
  const liveTitle = broadcastLive
    ? "End live broadcast"
    : hasLiveDestination
      ? cameraState.streamOn ? "Go live" : "Start camera before going live"
      : "Configure live broadcast";
  const liveAria = broadcastLive
    ? "End live broadcast"
    : hasLiveDestination
      ? "Start live broadcast"
      : "Open live broadcast setup";
  const handleLiveClick = () => {
    if (!broadcastLive && !hasLiveDestination) {
      onLiveSetupOpen();
      return;
    }
    if (!cameraState.streamOn && !broadcastLive) return;
    liveToggleRef.current?.();
  };

  return (
    <div
      className={`${s.dock} ${simplifiedDock ? s.dockSimplified : ""} ${evpMode ? s.dockEvp : ""}`.trim()}
      role="toolbar"
      aria-label="Camera secondary controls"
    >
      {/* Left group — Scenes + Markers. Sits to the left of the BIG
          SHUTTER (which is absolutely positioned by the parent). */}
      <div className={`${s.group} ${s.groupLeft}`}>
        <button
          type="button"
          className={`${s.btn} ${s.scenesBtn}`}
          onClick={onScenesOpen}
          aria-label="Open scene picker"
          title="Scenes"
        >
          <span className={s.icon} aria-hidden="true"><IconScenes /></span>
          <span className={s.label}>Scenes</span>
        </button>

        {/* Markers shortcut → navigates to /review where the marker
            editor lives. The HUD pill above the shutter shows the
            session-scoped count; this button is the quick-jump
            affordance for after the session ends. */}
        <button
          type="button"
          className={`${s.btn} ${s.hudBtn}`}
          onClick={onHudOpen}
          aria-label="Open HUD layout"
          title="HUD layout"
        >
          <span className={s.icon} aria-hidden="true"><IconHud /></span>
          <span className={s.label}>HUD</span>
        </button>

        {!simplifiedDock && (
          <button
            type="button"
            className={`${s.btn} ${s.markerBtn}`}
            onClick={onMarkersOpen}
            aria-label="Open marker review"
            title="Markers"
          >
            <span className={s.icon} aria-hidden="true"><IconMarkers /></span>
            <span className={s.label}>Markers</span>
          </button>
        )}
      </div>

      {/* Right group — Clip (in-app MediaRecorder) + Screen record +
          Lens (flip) + Torch (when supported). Hidden entirely on
          simplifiedDock scenes (Vigil) so the cinematic framing isn't
          broken by chip chrome. */}
      {!simplifiedDock && (
        <div className={`${s.group} ${s.groupRight}`}>
          {/* In-app clip recorder — fires the LiveStreamView MediaRecorder.
              "Record clip" beats "Clip" / "Rec" — operator knows what
              tapping it does without prior context. */}
          <button
            type="button"
            className={`${s.btn} ${s.clipBtn} ${broadcastRecording ? s.btnActive : ""}`.trim()}
            onClick={() => recordToggleRef.current?.()}
            disabled={!cameraState.streamOn}
            aria-pressed={broadcastRecording}
            aria-label={broadcastRecording ? "Stop clip recording" : "Start clip recording"}
            title={broadcastRecording ? "Stop clip" : "Record clip"}
          >
            <span className={s.icon} aria-hidden="true"><IconRecord /></span>
            <span className={s.label}>{broadcastRecording ? "Stop" : "Record clip"}</span>
          </button>

          <button
            type="button"
            className={`${s.btn} ${s.liveBtn} ${broadcastLive ? s.btnLive : !hasLiveDestination ? s.btnAttention : ""}`.trim()}
            onClick={handleLiveClick}
            disabled={!broadcastLive && hasLiveDestination && !cameraState.streamOn}
            aria-pressed={broadcastLive}
            aria-label={liveAria}
            title={liveTitle}
          >
            <span className={s.icon} aria-hidden="true"><IconLive /></span>
            <span className={s.label}>{liveLabel}</span>
          </button>

          {/* Screen record — full-word label, dock-chrome styling. The
              ScreenRecordButton owns the iOS-tip dialog vs Android
              MediaRecorder branching; we just hand it dock classes so
              it matches the rest of the row. */}
          <ScreenRecordButton
            investigationId={investigationId}
            classNames={{
              idle:   `${s.btn} ${s.screenRecordBtn}`,
              active: `${s.btn} ${s.btnActive} ${s.screenRecordBtn}`,
              icon:   s.icon,
              label:  s.label,
            }}
          />

          {/* Lens flip — full word, not "Rear"/"Front" (the old labels
              were confusing because they named the DESTINATION, not
              the action). Aria-label still names the destination so
              AT users get the more useful announcement. */}
          <button
            type="button"
            className={`${s.btn} ${s.lensBtn}`}
            onClick={() => flipCameraRef.current?.()}
            disabled={!cameraState.streamOn}
            aria-label={cameraState.facingMode === "environment" ? "Switch to front camera" : "Switch to rear camera"}
            title="Flip camera"
          >
            <span className={s.icon} aria-hidden="true"><IconLens /></span>
            <span className={s.label}>Lens</span>
          </button>

          {/* Torch — only when the active camera reports support (front
              cameras / laptops typically don't). */}
          {cameraState.torchSupported && (
            <button
              type="button"
              className={`${s.btn} ${s.torchBtn} ${cameraState.torchOn ? s.btnActive : ""}`.trim()}
              onClick={() => torchToggleRef.current?.()}
              aria-pressed={cameraState.torchOn}
              aria-label={cameraState.torchOn ? "Turn torch off" : "Turn torch on"}
              title="Torch"
            >
              <span className={s.icon} aria-hidden="true"><IconTorch /></span>
              <span className={s.label}>Torch</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
