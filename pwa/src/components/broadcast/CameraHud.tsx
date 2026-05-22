/**
 * CameraHud — the grid wrapper that owns every HUD chrome zone over the
 * live camera frame.
 *
 * Replaces the scatter of `{cond && <Chrome />}` patterns that used to
 * live directly inside CameraScreen.tsx with a single grid container.
 * The grid is documented in CameraHud.module.css. Most visibility
 * predicates that used to be inline in CameraScreen (running, snooze
 * active, marker count > 0, etc.) now live inside this component's
 * render — CameraScreen passes raw state in via props.
 *
 * The broadcast/* sub-components (BroadcastBug, BroadcastAudioMeter,
 * BroadcastSceneSelector, BroadcastSensorHud, BroadcastLowerThird) each
 * own their own absolute positioning to the camera viewport. Mounting
 * them inside CameraHud doesn't move them visually — they pin to the
 * nearest positioned ancestor (.hud, which is `position: absolute; inset
 * 0`). The grid is the framework for:
 *   - DOM order + a11y grouping (status / sense / dock / lower-third)
 *   - The inline chips that used to be CameraScreen-positioned absolutes
 *     (deviceChip, snoozeChip, markerCountPillWrap, evpDock wrapper).
 *
 * The bottom dock (row 5) is rendered as a CameraDock sibling of CameraHud
 * by CameraScreen — keeping the dock's start/stop wiring at the same level
 * as the BIG SHUTTER it sits beneath.
 *
 * Naming note: there's an existing `views/BroadcastChrome.tsx` for the Pi 5
 * HDMI kiosk surface. CameraHud is a different role (in-app phone HUD)
 * with a deliberately different name to avoid the collision.
 */
import { type ReactNode, type RefObject } from "react";
import { BroadcastBug, type BroadcastBugState } from "./BroadcastBug";
import { BroadcastAudioMeter } from "./BroadcastAudioMeter";
import { BroadcastSceneSelector } from "./BroadcastSceneSelector";
import { BroadcastSensorHud } from "./BroadcastSensorHud";
import { BroadcastLowerThird } from "./BroadcastLowerThird";
import type { AnomalyTile, SensorSnapshot } from "../../lib/sensors/useSensors";
import s from "./CameraHud.module.css";

// Marker breakdown rows for the HUD popover. Mirrors the priority used in
// CameraScreen so reviewers see the same order on both surfaces.
const MARKER_BREAKDOWN: ReadonlyArray<{ id: "sound" | "movement" | "felt" | "untagged"; label: string }> = [
  { id: "sound",    label: "sound" },
  { id: "movement", label: "movement" },
  { id: "felt",     label: "felt" },
  { id: "untagged", label: "untagged" },
];

interface SensorsLike {
  snapshot: SensorSnapshot;
  emf: AnomalyTile | null;
  vibration: AnomalyTile | null;
  lightAnomaly: AnomalyTile | null;
  magnetometerAvailable: boolean;
  lightAvailable: boolean;
}

export interface CameraHudProps {
  // Session state
  running: boolean;
  topPillState: BroadcastBugState;
  sessionSecs: number;

  // Audio
  audioRmsCoarse: number;
  vadActive: boolean;

  // Sensors
  sensors: SensorsLike;

  // Device chip — fed by the watchdog tick in CameraScreen
  hudBatteryPct: number | null;
  hudBatteryCharging: boolean;
  hudStorageMb: number | null;
  hudBatteryWarn: boolean;
  hudStorageWarn: boolean;

  // Snooze
  watchdogSnoozeUntil: number | null;
  onClearSnooze: () => void;

  // Scene
  sceneName: string;
  onOpenScenePicker: () => void;

  // Marker pill
  sessionMarkerCount: number;
  markerPillOpen: boolean;
  onToggleMarkerPill: () => void;
  sessionMarkerByCat: { sound: number; movement: number; felt: number; untagged: number };
  markerPillWrapRef: RefObject<HTMLDivElement | null>;
  markerPillTrapRef: RefObject<HTMLDivElement | null>;
  onNavigateReview: () => void;

  // Lower third (investigation slate burn-in)
  caseTitle?: string | null;
  caseLocation?: string | null;
  caseStartedAt?: string | null;

  // EVP dock content — CameraScreen owns the EvpRecorderControl wiring +
  // the scene gate; CameraHud just provides the slot. Pass `null` (or
  // omit) to skip the dock.
  evpDock?: ReactNode;

  // Pro mode toggle — Simple-mode hides SensorHud + ASI + posterior in
  // line with the 2026-05-09 "amateur audience matters too" pivot. Pro
  // unlocks the full forensic strip.
  proMode: boolean;
}

export function CameraHud(props: CameraHudProps) {
  const {
    running,
    topPillState,
    sessionSecs,
    audioRmsCoarse,
    vadActive,
    sensors,
    hudBatteryPct,
    hudBatteryCharging,
    hudStorageMb,
    hudBatteryWarn,
    hudStorageWarn,
    watchdogSnoozeUntil,
    onClearSnooze,
    sceneName,
    onOpenScenePicker,
    sessionMarkerCount,
    markerPillOpen,
    onToggleMarkerPill,
    sessionMarkerByCat,
    markerPillWrapRef,
    markerPillTrapRef,
    onNavigateReview,
    caseTitle,
    caseLocation,
    caseStartedAt,
    evpDock,
    proMode,
  } = props;

  return (
    <div className={s.hud}>
      {/* ── Status rail (top-left): broadcast bug → audio meter → device
            chip → snooze chip. The broadcast components own their own
            absolute positioning and pin to the cameraWrap; mounting them
            here is a DOM-order / a11y-grouping choice, not a layout one.
            The chips that DO follow the rail's flex flow are the device
            chip + snooze chip — they used to be absolute children of
            CameraScreen and now ride the rail. */}
      <div className={s.statusRail}>
        <BroadcastBug state={topPillState} elapsedSec={sessionSecs} />
        {running && (
          <BroadcastAudioMeter rms={audioRmsCoarse} vadActive={vadActive} />
        )}
        {running && (hudBatteryPct !== null || hudStorageMb !== null) && (
          <div
            className={`${s.deviceChip} ${hudBatteryWarn || hudStorageWarn ? s.deviceChipWarn : ""}`.trim()}
            aria-label="Device state"
          >
            {hudBatteryPct !== null && (
              <span className={`${s.deviceChipReading} ${hudBatteryWarn ? s.deviceChipReadingWarn : ""}`.trim()}>
                {hudBatteryCharging && <span className={s.deviceChipIcon} aria-hidden="true">⚡</span>}
                <span className={s.deviceChipValue}>{hudBatteryPct}%</span>
              </span>
            )}
            {hudBatteryPct !== null && hudStorageMb !== null && (
              <span className={s.deviceChipSep} aria-hidden="true">·</span>
            )}
            {hudStorageMb !== null && (
              <span className={`${s.deviceChipReading} ${hudStorageWarn ? s.deviceChipReadingWarn : ""}`.trim()}>
                <span className={s.deviceChipValue}>
                  {hudStorageMb >= 1024
                    ? `${(hudStorageMb / 1024).toFixed(1)}GB`
                    : `${hudStorageMb}MB`}
                </span>
                <span className={s.deviceChipUnit}>free</span>
              </span>
            )}
          </div>
        )}
        {running && watchdogSnoozeUntil !== null && (
          <button
            type="button"
            className={s.snoozeChip}
            onClick={onClearSnooze}
            title="Watchdog toasts are silenced. Tap to resume immediately."
            aria-label="Watchdog snoozed — tap to resume"
          >
            <span className={s.snoozeChipIcon} aria-hidden="true">🔕</span>
            <span className={s.snoozeChipLabel}>
              Snoozed {Math.max(0, Math.ceil((watchdogSnoozeUntil - Date.now()) / 60_000))}m
            </span>
          </button>
        )}
      </div>

      {/* ── Sense rail (top-right): scene picker → sensor HUD → EVP
            recorder dock. Pro-mode gates the sensor strip per the
            "amateur audience matters too" pivot — Simple-mode operators
            see scene + EVP only. */}
      <div className={s.senseRail}>
        <BroadcastSceneSelector sceneName={sceneName} onOpen={onOpenScenePicker} />
        {running && proMode && (
          <BroadcastSensorHud
            magnetometer={sensors.snapshot.magnetometer}
            light={sensors.snapshot.light}
            motion={sensors.snapshot.motion}
            emfAlert={sensors.emf}
            motionAlert={sensors.vibration}
            lightAlert={sensors.lightAnomaly}
            magnetometerAvailable={sensors.magnetometerAvailable}
            lightAvailable={sensors.lightAvailable}
          />
        )}
        {evpDock && <div className={s.evpDockSlot}>{evpDock}</div>}
      </div>

      {/* ── Lower-third row: reserved horizontal band. The component
            absolute-pins itself; the row keeps the grid contract honest
            (row 2 stays talent-clear) and reserves a place a future
            inline lower-third could occupy. */}
      <div className={s.lowerThirdRow}>
        <BroadcastLowerThird
          running={running}
          title={caseTitle ?? null}
          location={caseLocation ?? null}
          startedAt={caseStartedAt ?? null}
        />
      </div>

      {/* ── Marker tally pill ─────────────────────────────────────────
            UX spec: bottom-left of the shutter band, NOT under the
            shutter. Sits in grid row 4, anchored bottom-left so the
            popover can open upward into row 3 without crowding the
            BroadcastTimestamp slate. Hidden until the first marker lands
            so an empty HUD stays clean. */}
      {running && sessionMarkerCount > 0 && (
        <div className={s.markerPillWrap} ref={markerPillWrapRef}>
          <button
            type="button"
            className={s.markerCountPill}
            onClick={(e) => { e.stopPropagation(); onToggleMarkerPill(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Tap to see this session's marker breakdown"
            aria-expanded={markerPillOpen}
            aria-label={`${sessionMarkerCount} marker${sessionMarkerCount === 1 ? "" : "s"} this session — tap for breakdown`}
          >
            <span className={s.markerCountIcon} aria-hidden="true">●</span>
            <span className={s.markerCountValue}>{sessionMarkerCount}</span>
            <span className={s.markerCountLabel}>marker{sessionMarkerCount === 1 ? "" : "s"}</span>
          </button>
          {markerPillOpen && (
            <div
              className={s.markerCountPopover}
              role="dialog"
              aria-modal="true"
              aria-label="Marker breakdown by category"
              ref={markerPillTrapRef}
              tabIndex={-1}
            >
              <ul className={s.markerCountList}>
                {MARKER_BREAKDOWN.filter((row) => sessionMarkerByCat[row.id] > 0).map((row) => (
                  <li key={row.id}>
                    <span className={s.markerCountDot} data-category={row.id} aria-hidden="true">●</span>
                    {sessionMarkerByCat[row.id]} {row.label}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={s.markerCountReviewLink}
                onClick={(e) => { e.stopPropagation(); onNavigateReview(); }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                Open Review →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
