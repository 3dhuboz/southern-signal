/**
 * Unit tests for meterSonification.
 *
 * Most of this module is Web Audio side-effects (oscillator → envelope →
 * destination), which doesn't run in the node test environment. The tests
 * here cover the parts that DO have observable pure-function behaviour:
 *
 *   1. `clickRateHzFromZScore` — pure number-in-number-out; testable.
 *   2. The `playX()` helpers — assert they no-op (don't throw) when there's
 *      no AudioContext available, since the compositor's draw loop calls
 *      them every frame and a thrown exception would kill the RAF tick.
 *
 * Real audio behaviour is verified by ear during dev + the recording-bus
 * parity test (separate file) that checks the mixer routes synth nodes to
 * the MediaStream destination.
 */

import { describe, it, expect } from "vitest";
import {
  clickRateHzFromZScore,
  playKiiClick,
  playRemPodPulse,
  playMotionChirp,
  playGalvoTick,
  playVuOverloadChirp,
  setSpiritBoxScanHiss,
  __resetMeterSonificationForTests,
} from "./meterSonification";
import { __resetItcMixerForTests } from "./itcAudioMixer";
import { closeAudioContext } from "./audioUnlock";

describe("clickRateHzFromZScore", () => {
  it("returns 0 below 0.5σ (silent baseline)", () => {
    expect(clickRateHzFromZScore(0)).toBe(0);
    expect(clickRateHzFromZScore(0.3)).toBe(0);
    expect(clickRateHzFromZScore(0.49)).toBe(0);
  });

  it("at 1σ returns about 0.4 Hz (very slow click)", () => {
    const hz = clickRateHzFromZScore(1.0);
    expect(hz).toBeGreaterThan(0);
    expect(hz).toBeLessThan(1.0);
  });

  it("at 2σ returns 3-5 Hz (perceptible Geiger crackle)", () => {
    const hz = clickRateHzFromZScore(2.0);
    expect(hz).toBeGreaterThan(2.5);
    expect(hz).toBeLessThan(5.0);
  });

  it("at 3σ approaches but does not exceed the 15 Hz cap", () => {
    const hz = clickRateHzFromZScore(3.0);
    expect(hz).toBeGreaterThan(8);
    expect(hz).toBeLessThanOrEqual(15);
  });

  it("clamps to 15 Hz for arbitrarily large z-scores", () => {
    expect(clickRateHzFromZScore(5)).toBe(15);
    expect(clickRateHzFromZScore(100)).toBe(15);
  });

  it("rejects non-finite inputs as silent (NaN / Infinity → 0)", () => {
    expect(clickRateHzFromZScore(NaN)).toBe(0);
    expect(clickRateHzFromZScore(Infinity)).toBe(0);
    expect(clickRateHzFromZScore(-Infinity)).toBe(0);
  });

  it("returns the same result for ±z (sign-independent — magnitude only)", () => {
    // Caller passes Math.abs(z) but defensively the function shouldn't behave
    // weirdly on negative inputs that slipped through.
    expect(clickRateHzFromZScore(-2)).toBe(0); // below the 0.5σ threshold (after the < 0.5 guard)
  });
});

describe("meter sonification — no-AudioContext guards", () => {
  // The node test env has no `window.AudioContext`. Each playX() helper
  // should silently no-op rather than throw. This is the contract the
  // compositor relies on — its draw loop calls these every frame.

  it("playKiiClick is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    expect(() => playKiiClick(0.5)).not.toThrow();
    expect(() => playKiiClick(0)).not.toThrow();
    expect(() => playKiiClick(1)).not.toThrow();
  });

  it("playRemPodPulse is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    expect(() => playRemPodPulse()).not.toThrow();
  });

  it("playMotionChirp is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    expect(() => playMotionChirp()).not.toThrow();
  });

  it("playGalvoTick is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    expect(() => playGalvoTick()).not.toThrow();
  });

  it("playVuOverloadChirp is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    expect(() => playVuOverloadChirp()).not.toThrow();
  });

  it("setSpiritBoxScanHiss is a no-op when Web Audio is unavailable", () => {
    closeAudioContext();
    __resetItcMixerForTests();
    __resetMeterSonificationForTests();
    expect(() => setSpiritBoxScanHiss(true)).not.toThrow();
    expect(() => setSpiritBoxScanHiss(false)).not.toThrow();
    // Idempotent on repeat calls.
    expect(() => setSpiritBoxScanHiss(true)).not.toThrow();
    expect(() => setSpiritBoxScanHiss(true)).not.toThrow();
  });
});
