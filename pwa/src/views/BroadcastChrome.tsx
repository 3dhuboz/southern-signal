/**
 * BroadcastChrome — full-bleed 1920×1080 broadcast surface for HDMI output.
 *
 * Why this exists (separate from BroadcastPreview):
 *
 *   /preview/broadcast is the design-review surface — a 2×2 grid of all
 *   four lifecycle states with a header and controls. /broadcast/chrome
 *   is the production output: a SINGLE 16:9 frame meant to be displayed
 *   fullscreen on an HDMI-connected screen driven by a Raspberry Pi 5
 *   running Chromium in kiosk mode. The on-screen talent sees the bug,
 *   the timer, the sensor HUD, and the lower-third exactly as a viewer
 *   would see them, without any operator chrome cluttering the frame.
 *
 *   Setup workflow (V1 → V2):
 *     V1 (this file): Pi 5 in kiosk Chromium with
 *       `/broadcast/chrome?state=live&elapsed=125&investigation=visible`
 *       — a static configuration via URL query params. Useful as a
 *       graphic-source overlay for desktop OBS via Browser Source, OR
 *       as a standalone "monitor" that the operator manually configures.
 *     V2 (not yet shipped): same route, but the Pi 5 reads its state
 *       from a BroadcastChannel API channel the phone publishes on, so
 *       the Pi mirrors the phone's CameraScreen state in real time. The
 *       channel name + message schema is documented in
 *       docs/pi5-broadcast-channel-protocol.md (TBD).
 *
 * Layout:
 *
 *   The viewport is filled with a 16:9 letterboxed stage; the stage is
 *   the same .frame styling BroadcastPreview uses for its variants,
 *   sized to whichever is the limiting dimension. The 6 broadcast
 *   components position themselves absolutely inside the stage at the
 *   same offsets they use on CameraScreen — so the chrome reads exactly
 *   the same as the operator's phone.
 *
 *   No header. No nav. No back-link. This is meant to look like a
 *   broadcast feed, not a web page.
 *
 *   Reduced motion + theme honour the OS / persisted preference. There
 *   is no preview-time control here because a Pi 5 in kiosk mode can't
 *   meaningfully toggle them — the operator sets them once via the
 *   normal Settings tab on the phone.
 *
 * Routing:
 *   /broadcast/chrome — not surfaced in the main nav.
 *
 * URL query param contract (all optional, all clamped/defaulted):
 *   state=idle|ready|rec|live   default live
 *   elapsed=<seconds>           default 125 (so the timecode reads 02:05)
 *   rms=<0..1>                  default 0.18  (≈ -15 dBFS, active speech)
 *   vad=true|false              default true
 *   scene=<string>              default "Outdoor Cemetery"
 *   investigation=visible|hidden  default visible
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { BroadcastBug, type BroadcastBugState } from "../components/broadcast/BroadcastBug";
import { BroadcastAudioMeter } from "../components/broadcast/BroadcastAudioMeter";
import { BroadcastTimestamp } from "../components/broadcast/BroadcastTimestamp";
import { BroadcastSensorHud } from "../components/broadcast/BroadcastSensorHud";
import { BroadcastSceneSelector } from "../components/broadcast/BroadcastSceneSelector";
import { BroadcastLowerThird } from "../components/broadcast/BroadcastLowerThird";
import type { LightSample } from "../lib/sensors/light";
import type { MagnetometerSample } from "../lib/sensors/magnetometer";
import type { MotionSample } from "../lib/sensors/motion";
import s from "./BroadcastChrome.module.css";

/** Parse the `state` query param into a valid BroadcastBugState. Unknown
 *  values fall back to "live" — Pi 5 kiosk mode is overwhelmingly used
 *  to monitor a live broadcast, so that's the right default. */
function parseState(raw: string | null): BroadcastBugState {
  if (raw === "idle" || raw === "ready" || raw === "rec" || raw === "live") return raw;
  return "live";
}

/** Parse a numeric query param with min/max clamping + default fallback.
 *  We clamp rather than reject so a typo'd URL still renders something
 *  sensible on the HDMI screen — better to show "the configured state
 *  with a clamped value" than a blank screen and an error overlay. */
function parseNumber(raw: string | null, def: number, min: number, max: number): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function parseBool(raw: string | null, def: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return def;
}

export function BroadcastChrome() {
  const [params] = useSearchParams();

  const state = parseState(params.get("state"));
  const elapsedSec = parseNumber(params.get("elapsed"), 125, 0, 86_400);
  const rms = parseNumber(params.get("rms"), 0.18, 0, 1);
  const vadActive = parseBool(params.get("vad"), true);
  const sceneName = params.get("scene") ?? "Outdoor Cemetery";
  const investigationVisible = (params.get("investigation") ?? "visible") !== "hidden";

  // `running` is implied by state: idle is the only non-running state.
  // ready / rec / live are all "session active" lifecycles in the
  // production CameraScreen wiring; we mirror that here.
  const running = state !== "idle";

  // Demo sensor snapshots — same plausible values BroadcastPreview uses
  // so the two surfaces read consistently. We deliberately use ONE static
  // set of readings (no animation) because the Pi 5 monitor is meant to
  // display a "live broadcast" feed; injecting fake jitter into the
  // numbers would be theatre, not data.
  const sensors = useMemo(() => {
    const t = typeof performance !== "undefined" ? performance.now() : 0;
    const mag: MagnetometerSample = { timestamp: t, magnitude: 0.42, x: 0.21, y: 0.18, z: 0.31 };
    const light: LightSample = { timestamp: t, lux: 12, source: "ambient-light-sensor" };
    const motion: MotionSample = {
      timestamp: t, accelMagnitude: 9.81,
      ax: 0.02, ay: 0.01, az: 9.81,
      alpha: 0, beta: 0, gamma: 0,
    };
    return { mag, light, motion };
  }, []);

  const investigation = useMemo(
    () => ({
      title: "St. Mary's Cemetery walkthrough",
      location: "Cemetery South",
      startedAt: "2026-05-19T20:00:00.000Z",
    }),
    [],
  );

  return (
    <div className={s.stage} data-broadcast-state={state}>
      <div
        className={s.frame}
        role="group"
        aria-label="Broadcast HDMI output"
        data-state={state}
      >
        {/* Placeholder backdrop — solid dark wash with a subtle vignette so
            the chrome reads on its own (the Pi 5 surface itself is the
            "video source" for a downstream OBS Browser Source, so we don't
            include any video here). */}
        <div className={s.backdrop} aria-hidden="true" />

        {/* Status bug — always rendered. */}
        <BroadcastBug state={state} elapsedSec={elapsedSec} />

        {/* Audio meter — running-gate parity with CameraScreen. */}
        {running && <BroadcastAudioMeter rms={rms} vadActive={vadActive} />}

        {/* Scene selector — `onOpen` is a no-op on the kiosk surface; the
            chip is still a real button for AT consistency, but tapping it
            does nothing because there's no operator behind the Pi 5
            screen to pick a scene from there. */}
        <BroadcastSceneSelector
          sceneName={sceneName}
          onOpen={() => {
            /* kiosk: intentionally inert */
          }}
        />

        {/* Sensor HUD — running-gate parity. */}
        {running && (
          <BroadcastSensorHud
            magnetometer={sensors.mag}
            light={sensors.light}
            motion={sensors.motion}
            emfAlert={{ alert: false }}
            motionAlert={{ alert: false }}
            lightAlert={{ alert: false }}
            magnetometerAvailable={true}
            lightAvailable={true}
          />
        )}

        {/* Timestamp slate — always mounted on CameraScreen, mirror here. */}
        <BroadcastTimestamp running={running} elapsedSec={elapsedSec} />

        {/* Lower-third — running + visible-by-URL gates both required. */}
        {running && investigationVisible && (
          <BroadcastLowerThird
            running={running}
            title={investigation.title}
            location={investigation.location}
            startedAt={investigation.startedAt}
          />
        )}
      </div>
    </div>
  );
}
