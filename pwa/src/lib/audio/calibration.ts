/**
 * Calibration ritual — the on-air 3-of-3 sector test.
 *
 * Per the physics panel: place a Bluetooth speaker at a marked sector,
 * trigger a 200 ms broadband click, the rig must call the sector right.
 * Three for three (different sectors) before any anomaly reading is
 * trusted. Failure marks the instrument DEGRADED for the remainder of
 * the episode and sector readings render in grey.
 *
 * This module is the state machine. The audio capture + click detection
 * + sector aggregation are wired in by the UI.
 */

import type { Sector } from "./sectorIndicator";

export type CalibrationStatus = "idle" | "running" | "passed" | "degraded";

export interface CalibrationAttempt {
  expected: Sector;
  measured: Sector;
  coherence: number;
  itdMs: number;
  passed: boolean;
  ts: number;
}

export interface CalibrationState {
  status: CalibrationStatus;
  attempts: CalibrationAttempt[];
  /** Required attempts to pass (3 by default). */
  required: number;
  /** Sequence of expected sectors caller wants tested (e.g. ["FRONT-R", "REAR-C", "FRONT-L"]). */
  plan: Sector[];
  /** Index of the current attempt within the plan. */
  cursor: number;
  /** Timestamp the calibration ended (passed or degraded). */
  endedAt: number | null;
}

export const DEFAULT_CALIBRATION_PLAN: Sector[] = ["FRONT-R", "REAR-C", "FRONT-L"];

export function createCalibrationState(plan: Sector[] = DEFAULT_CALIBRATION_PLAN, required = 3): CalibrationState {
  return {
    status: "idle",
    attempts: [],
    required,
    plan,
    cursor: 0,
    endedAt: null,
  };
}

export function startCalibration(state: CalibrationState): CalibrationState {
  return { ...state, status: "running", attempts: [], cursor: 0, endedAt: null };
}

export interface RecordAttemptInput {
  measured: Sector;
  coherence: number;
  itdMs: number;
  ts: number;
}

export function recordAttempt(state: CalibrationState, input: RecordAttemptInput): CalibrationState {
  if (state.status !== "running") return state;
  const expected = state.plan[state.cursor] ?? null;
  const passed = expected !== null && input.measured === expected;
  const attempt: CalibrationAttempt = {
    expected,
    measured: input.measured,
    coherence: input.coherence,
    itdMs: input.itdMs,
    passed,
    ts: input.ts,
  };
  const attempts = [...state.attempts, attempt];

  // If any attempt fails, the rig is DEGRADED — no second chances on air.
  if (!passed) {
    return { ...state, attempts, status: "degraded", endedAt: input.ts };
  }
  const cursor = state.cursor + 1;
  if (cursor >= state.required) {
    return { ...state, attempts, status: "passed", cursor, endedAt: input.ts };
  }
  return { ...state, attempts, cursor };
}

export function isInstrumentTrustworthy(state: CalibrationState): boolean {
  return state.status === "passed";
}

export function summary(state: CalibrationState): string {
  const passes = state.attempts.filter((a) => a.passed).length;
  const total = state.attempts.length;
  if (state.status === "passed") return `CALIBRATION PASS ${passes}/${total} — Sector accuracy ±60°, not bearing.`;
  if (state.status === "degraded") return `CALIBRATION FAIL ${passes}/${total} — Instrument DEGRADED for this episode.`;
  if (state.status === "running") return `CALIBRATION ${passes}/${state.required} — expecting ${state.plan[state.cursor] ?? "?"}.`;
  return "CALIBRATION not started.";
}
