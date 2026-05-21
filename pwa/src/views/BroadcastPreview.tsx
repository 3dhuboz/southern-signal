/**
 * BroadcastPreview — internal design-review surface for the broadcast HUD.
 *
 * Why this exists:
 *   To iterate on the broadcast chrome (BroadcastBug, BroadcastAudioMeter,
 *   BroadcastTimestamp, BroadcastSensorHud, BroadcastSceneSelector,
 *   BroadcastLowerThird) the operator otherwise has to start a real session
 *   — STANDBY shows on the camera, but to compare REC vs LIVE you have to
 *   actually record. That's a deployment workflow, not a design-review one.
 *   This page renders all four status states side-by-side over a neutral
 *   backdrop so designers / reviewers / prospects can scan the whole state
 *   ladder at once.
 *
 * Production note:
 *   This is also useful in production — prospective production / reviewer
 *   contacts have asked for "what does it actually look like on camera",
 *   and a /preview/broadcast URL we can drop in an email is a far better
 *   answer than a video walkthrough. Always-accessible by design; not
 *   surfaced in the main nav so it doesn't muddy the operator's daily
 *   routes.
 *
 * Implementation:
 *   Each "frame" is a relatively-positioned ~16:9 div that establishes a
 *   fresh stacking context for the absolutely-positioned broadcast
 *   components. The components themselves are imported and rendered exactly
 *   as CameraScreen renders them — no forking, no JSX duplication — so any
 *   visual change to the production chrome propagates here automatically.
 *
 *   All six components already accept their displayed values via props, so
 *   no provider mocking is needed. We synthesise plausible sensor samples,
 *   audio RMS, and an investigation object for each frame variant.
 *
 *   Reduced-motion toggle uses a CSS module rule that disables all child
 *   animations / transitions when the preview root carries
 *   `data-prefers-reduced-motion="reduce"` — mirroring the OS-level setting
 *   without requiring a real OS toggle.
 *
 *   Theme toggle calls applyTheme() directly so the broadcast chrome
 *   re-renders against scotopic / daylight / phosphor tokens. Restored on
 *   unmount so the user's persisted preference wins everywhere else.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BroadcastBug, type BroadcastBugState } from "../components/broadcast/BroadcastBug";
import { BroadcastAudioMeter } from "../components/broadcast/BroadcastAudioMeter";
import { BroadcastTimestamp } from "../components/broadcast/BroadcastTimestamp";
import { BroadcastSensorHud } from "../components/broadcast/BroadcastSensorHud";
import { BroadcastSceneSelector } from "../components/broadcast/BroadcastSceneSelector";
import { BroadcastLowerThird } from "../components/broadcast/BroadcastLowerThird";
import type { LightSample } from "../lib/sensors/light";
import type { MagnetometerSample } from "../lib/sensors/magnetometer";
import type { MotionSample } from "../lib/sensors/motion";
import { applyTheme, type Theme, usePreferences } from "../lib/preferences";
import s from "./BroadcastPreview.module.css";

// ── Frame variant config ─────────────────────────────────────────────────────
//
// Four frames, one per BroadcastBugState. Each frame nails down ALL the
// inputs every broadcast component reads so the chrome renders as it would
// on the camera at that lifecycle moment. Centralising the variant table
// here keeps the JSX below short and makes adding a fifth state (e.g.
// "paused") a single object literal.

interface FrameVariant {
  /** Status state — drives the BroadcastBug + the lower-third lifecycle. */
  state: BroadcastBugState;
  /** Human caption shown below the frame. */
  caption: string;
  /** Session-elapsed seconds. */
  elapsedSec: number;
  /** Whether the session is "running" (lower-third + timestamp running flag). */
  running: boolean;
  /** Linear audio RMS (0..1) — fed to BroadcastAudioMeter. */
  audioRms: number;
  /** True to flash the VAD-active rim on the meter. */
  vadActive: boolean;
  /** Active scene display name shown in the top-right chip. */
  sceneName: string;
  /** Sensor samples — null suppresses the corresponding row in the HUD. */
  magnetometer: MagnetometerSample | null;
  light: LightSample | null;
  motion: MotionSample | null;
  /** Per-sensor alert hints — when `alert: true` the HUD row flashes once
   *  on the 0→1 transition. We pin these to false in the preview so the
   *  static screenshot reads cleanly; a future iteration can drive them
   *  off a setInterval if a "live demo" mode is wanted. */
  emfAlert: { alert: boolean } | null;
  motionAlert: { alert: boolean } | null;
  lightAlert: { alert: boolean } | null;
}

/** Build the four canonical frames. Mock investigation values are shared
 *  across frames where the lower-third is visible; the per-frame variation
 *  lives in `state`, `audioRms`, and the scene name (so the operator can
 *  assess truncation behaviour across the four states). */
function buildVariants(): FrameVariant[] {
  // Reused sensor snapshots — same EMF / LUX / ACC across the running
  // frames so the operator's eye can spot state-specific differences rather
  // than chasing changes in unrelated numbers.
  const nowPerf = typeof performance !== "undefined" ? performance.now() : 0;
  const baseMag: MagnetometerSample = {
    timestamp: nowPerf,
    magnitude: 0.42,
    x: 0.21,
    y: 0.18,
    z: 0.31,
  };
  const baseLight: LightSample = {
    timestamp: nowPerf,
    lux: 12,
    source: "ambient-light-sensor",
  };
  const baseMotion: MotionSample = {
    timestamp: nowPerf,
    accelMagnitude: 9.81,
    ax: 0.02,
    ay: 0.01,
    az: 9.81,
    alpha: 0,
    beta: 0,
    gamma: 0,
  };

  return [
    // STANDBY — no session running, no audio meter visible (CameraScreen
    // hides the meter outside of running). We pass silent RMS anyway so the
    // meter, if a future iteration mounts it pre-roll, would still render.
    {
      state: "idle",
      caption: "Standby (idle)",
      elapsedSec: 0,
      running: false,
      audioRms: 0,
      vadActive: false,
      sceneName: "Walkthrough",
      // Sensors suppressed pre-session — matches the real lifecycle where
      // useSensors only subscribes after permissions are granted via Begin.
      magnetometer: null,
      light: null,
      motion: null,
      emfAlert: null,
      motionAlert: null,
      lightAlert: null,
    },
    // READY — pre-roll. Session timer starts, sensors warmed up, audio at
    // a quiet floor. -42 dBFS ≈ amplitude 10^(-42/20) ≈ 0.00794.
    {
      state: "ready",
      caption: "Ready (pre-roll)",
      elapsedSec: 0,
      running: true,
      audioRms: 0.00794,
      vadActive: false,
      sceneName: "Walkthrough",
      magnetometer: baseMag,
      light: baseLight,
      motion: baseMotion,
      emfAlert: { alert: false },
      motionAlert: { alert: false },
      lightAlert: { alert: false },
    },
    // REC — actively recording. Active speech level (-14 dBFS ≈ 0.1995).
    // Scene flipped to "Outdoor Cemetery" so the chip's truncation behaviour
    // gets exercised on a longer label.
    {
      state: "rec",
      caption: "Recording (REC 0:42)",
      elapsedSec: 42,
      running: true,
      audioRms: 0.1995,
      vadActive: true,
      sceneName: "Outdoor Cemetery",
      magnetometer: baseMag,
      light: baseLight,
      motion: baseMotion,
      emfAlert: { alert: false },
      motionAlert: { alert: false },
      lightAlert: { alert: false },
    },
    // LIVE — broadcasting. Same audio shape as REC; scene flipped again to
    // "Indoor Quiet" for label variety. Elapsed bumped to 1:23 so the bug's
    // mm:ss formatter exercises the >1m branch.
    {
      state: "live",
      caption: "Going live (LIVE 1:23)",
      elapsedSec: 83,
      running: true,
      audioRms: 0.1995,
      vadActive: true,
      sceneName: "Indoor Quiet",
      magnetometer: baseMag,
      light: baseLight,
      motion: baseMotion,
      emfAlert: { alert: false },
      motionAlert: { alert: false },
      lightAlert: { alert: false },
    },
  ];
}

// ── Single frame ─────────────────────────────────────────────────────────────
//
// Wraps the six broadcast components in a 16:9 box. The box is
// `position: relative` so the components' `position: absolute` rules anchor
// to the frame edges (matching how they sit inside CameraScreen's
// .cameraWrap). The same hard-coded offsets (top: 12px+44px, bottom: 24px+…)
// the components ship with will land in roughly the right spots — slightly
// scaled down because the frame is smaller than a full phone viewport, but
// faithful enough for design review.

interface FrameProps {
  variant: FrameVariant;
}

function Frame({ variant }: FrameProps) {
  // Mock investigation reused by every running frame. Pinned date so the
  // lower-third subtitle reads consistently across screenshots (the
  // BroadcastLowerThird formatter renders this in the local locale).
  const investigation = useMemo(
    () => ({
      title: "St. Mary's Cemetery walkthrough",
      location: "Cemetery South",
      // Anchor the date to Sun 19 May 2026 by passing a fixed ISO; the
      // formatter handles the locale rendering.
      startedAt: "2026-05-19T20:00:00.000Z",
    }),
    [],
  );

  // Lower-third only shows when an investigation is "running" — match the
  // production CameraScreen behaviour. STANDBY hides the slate entirely.
  const showLowerThird = variant.running;

  return (
    <figure className={s.frameFigure}>
      <div
        className={s.frame}
        role="group"
        aria-label={`Broadcast HUD preview — ${variant.caption}`}
      >
        {/* Placeholder backdrop — a subtle radial gradient that mimics the
            ambient cast of a low-light video frame without leaning on any
            specific imagery. Keeps the chrome the focus of the preview. */}
        <div className={s.backdrop} aria-hidden="true" />

        {/* Status bug — always rendered (idle is the only state CameraScreen
            also always mounts the bug for). */}
        <BroadcastBug state={variant.state} elapsedSec={variant.elapsedSec} />

        {/* Audio meter — production code only mounts this when running, so
            we mirror that gate here. STANDBY frame skips it; the other
            three render against the variant's RMS. */}
        {variant.running && (
          <BroadcastAudioMeter rms={variant.audioRms} vadActive={variant.vadActive} />
        )}

        {/* Scene selector — onOpen is a no-op in preview; we don't surface
            a SceneSheet here. The chip is still interactive (a real button)
            so accessibility tooling sees the same focus behaviour. */}
        <BroadcastSceneSelector
          sceneName={variant.sceneName}
          onOpen={() => {
            /* preview: intentionally inert — no SceneSheet to mount */
          }}
        />

        {/* Sensor HUD — same running-gate as on CameraScreen. STANDBY frame
            doesn't show the strip. */}
        {variant.running && (
          <BroadcastSensorHud
            magnetometer={variant.magnetometer}
            light={variant.light}
            motion={variant.motion}
            emfAlert={variant.emfAlert}
            motionAlert={variant.motionAlert}
            lightAlert={variant.lightAlert}
            magnetometerAvailable={variant.magnetometer != null}
            lightAvailable={variant.light != null}
          />
        )}

        {/* Timestamp slate — always mounted on CameraScreen so we match. */}
        <BroadcastTimestamp running={variant.running} elapsedSec={variant.elapsedSec} />

        {/* Lower-third — only renders when an investigation is active. The
            component holds its own "sticky" content for the slide-out
            animation; we only need to drive the visibility flag. */}
        {showLowerThird && (
          <BroadcastLowerThird
            running={variant.running}
            title={investigation.title}
            location={investigation.location}
            startedAt={investigation.startedAt}
          />
        )}
      </div>
      <figcaption className={s.caption}>{variant.caption}</figcaption>
    </figure>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function BroadcastPreview() {
  const variants = useMemo(() => buildVariants(), []);

  // Local theme override. We honour the user's persisted theme on first
  // paint, let them flip it for the preview session, and restore the
  // persisted theme on unmount so the rest of the app isn't affected.
  const [prefs] = usePreferences();
  const [previewTheme, setPreviewTheme] = useState<Theme>(prefs.theme);

  useEffect(() => {
    applyTheme(previewTheme, prefs.scotopicLevel);
    // Restore the persisted theme when the route unmounts so a back-nav
    // doesn't leave the user with a surprise palette. The dep on prefs is
    // intentional — if the user toggles theme in Setup from a different
    // tab while this page is open, we still want the persisted value to
    // win on unmount.
    return () => {
      applyTheme(prefs.theme, prefs.scotopicLevel);
    };
  }, [previewTheme, prefs.theme, prefs.scotopicLevel]);

  const [reducedMotion, setReducedMotion] = useState<boolean>(false);

  return (
    <div
      className={s.page}
      data-prefers-reduced-motion={reducedMotion ? "reduce" : "no-preference"}
    >
      <header className={s.head}>
        <div className={s.headLeft}>
          <h1 className={s.title}>Broadcast HUD preview</h1>
          <p className={s.subtitle}>
            All four status states rendered side-by-side over a neutral
            backdrop. Internal design-review surface — chrome reads exactly
            as it will on the camera at each lifecycle moment.
          </p>
        </div>
        <nav className={s.headNav} aria-label="Preview controls">
          <fieldset className={s.controlGroup}>
            <legend className={s.controlLabel}>Theme</legend>
            <div className={s.segmented} role="radiogroup" aria-label="Theme">
              {(["phosphor", "scotopic", "daylight"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={previewTheme === t}
                  className={`${s.segmentBtn} ${previewTheme === t ? s.segmentBtnActive : ""}`.trim()}
                  onClick={() => setPreviewTheme(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>
          <label className={s.toggleRow}>
            <input
              type="checkbox"
              checked={reducedMotion}
              onChange={(e) => setReducedMotion(e.target.checked)}
            />
            <span>Reduced motion</span>
          </label>
          <Link to="/about" className={s.backLink}>
            ← About
          </Link>
        </nav>
      </header>

      <section className={s.grid} aria-label="Broadcast HUD frames">
        {variants.map((v) => (
          <Frame key={v.state} variant={v} />
        ))}
      </section>

      <footer className={s.footer}>
        <p>
          Tools / internal — not part of the main app navigation.
          Reachable only via direct URL <code>/preview/broadcast</code>.
        </p>
      </footer>
    </div>
  );
}
