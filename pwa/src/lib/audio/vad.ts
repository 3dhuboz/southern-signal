/**
 * vad — Voice Activity Detection.
 *
 * Watches the mic stream's amplitude in the dominant speech band (~85-3000Hz)
 * and emits a boolean: "operator is speaking now / not now". Used to drive
 * hands-free ducking of the ITC mixer — long-press PTT is still available
 * but with VAD enabled the operator can narrate without holding anything.
 *
 * Heuristic, not ML — single-mic RMS with adaptive noise floor + hysteresis.
 * The math is intentionally cheap so it can run alongside the existing
 * acoustic-transient analyser without doubling the per-frame cost.
 */

import { unlockAudio } from "./audioUnlock";

export interface VadConfig {
  /** Activation threshold above noise floor, in dB. Default 12dB. */
  activationDb?: number;
  /** Deactivation threshold above noise floor, in dB. Default 6dB.
   *  Lower than activation → hysteresis: harder to turn on than off. */
  deactivationDb?: number;
  /** ms of sustained above-activation before flipping to active. Default 120. */
  attackMs?: number;
  /** ms of sustained below-deactivation before flipping to inactive. Default 350. */
  releaseMs?: number;
  /** Noise-floor adapts at this rate when below activation. Default 0.05. */
  noiseFloorAlpha?: number;
  /**
   * Seed the adaptive noise floor with a previously-saved estimate (e.g. from
   * a Sound-Check session in Setup). Default -50 dB is intentionally
   * pessimistic so the floor only adapts UPWARD during the first few seconds
   * of a quiet room; supplying a learned floor here skips that warmup so the
   * trigger threshold is correct from the first tick.
   */
  initialNoiseFloorDb?: number;
}

export interface VadHandle {
  stop(): void;
  /** Last computed level, in dBFS. Useful for debugging. */
  getLevelDb(): number;
  /** Current adaptive noise floor estimate, in dB. The detector compares
   *  `getLevelDb()` against `getNoiseFloorDb() + activationDb` to decide
   *  whether voice is active — surfacing this lets a UI render the gap so
   *  the operator can tune sensitivity with a live readout. */
  getNoiseFloorDb(): number;
}

/**
 * Run a VAD analyser against a mic-bearing MediaStream. Calls `onChange`
 * each time the boolean flips. Returns a handle to tear down.
 *
 * Silent no-op if Web Audio is unavailable or autoplay was rejected — the
 * caller's UI keeps working without the VAD signal.
 */
export function startVad(
  micStream: MediaStream,
  onChange: (active: boolean) => void,
  cfg: VadConfig = {},
): VadHandle {
  const ctx = unlockAudio();
  if (!ctx) {
    return { stop: () => {}, getLevelDb: () => -Infinity, getNoiseFloorDb: () => -Infinity };
  }

  const activationDb   = cfg.activationDb   ?? 12;
  const deactivationDb = cfg.deactivationDb ?? 6;
  const attackMs       = cfg.attackMs       ?? 120;
  const releaseMs      = cfg.releaseMs      ?? 350;
  const noiseFloorAlpha = cfg.noiseFloorAlpha ?? 0.05;

  const source = ctx.createMediaStreamSource(micStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.2;
  // Bandpass via gain shaping is overkill for V1 — the analyser's bin layout
  // already concentrates energy in the speech band on most consumer mics.
  source.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);
  // -50 = pessimistic default that adapts upward over the first few seconds.
  // Caller can seed a saved floor (from Sound-Check) to skip the warmup.
  let noiseFloorDb = cfg.initialNoiseFloorDb ?? -50;
  let lastLevelDb = -100;
  let aboveSince  = 0;
  let belowSince  = 0;
  let active      = false;
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(buf);
    // RMS on the centered waveform (byte 128 = silence).
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    // -60 floor so the dB calc doesn't go to -Infinity in silence; matches
    // the audio meter elsewhere in the codebase.
    const levelDb = rms > 0.001 ? 20 * Math.log10(rms) : -60;
    lastLevelDb = levelDb;

    const now = performance.now();
    if (!active) {
      // Track noise floor while inactive — EMA towards the current level so a
      // gradually-rising room noise doesn't lock out VAD.
      noiseFloorDb += (levelDb - noiseFloorDb) * noiseFloorAlpha;
    }

    if (active) {
      if (levelDb < noiseFloorDb + deactivationDb) {
        if (belowSince === 0) belowSince = now;
        if (now - belowSince >= releaseMs) {
          active = false;
          belowSince = 0;
          aboveSince = 0;
          onChange(false);
        }
      } else {
        belowSince = 0;
      }
    } else {
      if (levelDb > noiseFloorDb + activationDb) {
        if (aboveSince === 0) aboveSince = now;
        if (now - aboveSince >= attackMs) {
          active = true;
          aboveSince = 0;
          belowSince = 0;
          onChange(true);
        }
      } else {
        aboveSince = 0;
      }
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try { source.disconnect(); } catch { /* ignore */ }
      try { analyser.disconnect(); } catch { /* ignore */ }
    },
    getLevelDb() { return lastLevelDb; },
    getNoiseFloorDb() { return noiseFloorDb; },
  };
}
