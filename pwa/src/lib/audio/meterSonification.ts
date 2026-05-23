/**
 * meterSonification — per-meter audio cues for the skeuomorphic gear stack.
 *
 * # Why this exists
 *
 * The Phases A+B overhaul gave every meter a polished visual look. Audio is
 * the second half of the spec ("they need to look good AND sound great"):
 * each meter emits a characteristic short cue at the moment its visual state
 * changes (K-II LED count step, REM Pod pulse trigger, VU overload, motion
 * trigger, EMF galvanometer needle deflection).
 *
 * All cues are synthesised with the Web Audio API — no shipped sample files
 * (the budget for audio assets is 0 KB; the bundle has limited headroom and
 * we don't want to spend any of it on samples that the synth alternative
 * covers adequately). Every cue routes through the shared `itcAudioMixer` so
 * it lands on (a) operator monitor headphones, (b) the recorded MP4/WebM,
 * AND (c) the WHIP livestream — identical recording-bus parity with the
 * existing Spirit Box / Ovilus tools.
 *
 * # Trigger discipline
 *
 * The compositor's draw loop ticks at 30 fps. A naive "play a click on every
 * frame where z > threshold" would emit 30 clicks/second — fine for the K-II
 * Geiger character but ruinous for the REM Pod warble or the motion chirp,
 * which are meant to fire once per discrete event. Each `playX()` helper here
 * does its own throttling:
 *
 *   - K-II Geiger:     poisson-style click stream, rate ∝ z-score
 *   - REM Pod warble:  one shot per rising-edge crossing of 2.5σ
 *
 * (Additional meters wire into this module in later commits.)
 *
 * State for the throttles lives on the FrameContext (see canvasCompositor.ts)
 * so each compositor instance keeps its own — no cross-talk between concurrent
 * recorder + WHIP compositors.
 *
 * # Honest-copy compliance
 *
 * - K-II clicks: represent z-score (NOT real radiation; the silkscreen text
 *   already calls this out).
 * - REM Pod warble: triggered by magnetometer z-score, not a real EM field
 *   threshold detector.
 *
 * # Volume / mix philosophy
 *
 * Meter cues live below the ITC tools in the mix (see DEFAULT_GAINS in
 * itcAudioMixer.ts). Operators care about spoken / phoneme content first;
 * the meter SFX are flavour that survives the noise floor of a session.
 */

import { getMixerAudioContext, getMixerChannel, type MeterChannelId } from "./itcAudioMixer";

// ─────────────────────────────────────────────────────────────────────────────
// K-II Geiger-counter clicks
//
// Each call emits ONE click. The compositor draws at 30 fps and decides how
// often to call this based on `clickRateHzFromZScore()` below + a per-frame
// schedule. The brighter timbre at higher LED counts is a tiny pitch lift
// on the bandpass — real Geiger detectors have a fixed click sound, but a
// slight upward shift reads as "more activity" to the operator without
// needing a separate sample bank.
// ─────────────────────────────────────────────────────────────────────────────

/** Map an absolute z-score to Geiger click rate (Hz). Silent below ~0.5σ;
 *  approaches ~12 Hz at z >= 3σ. The curve is gently superlinear so quiet
 *  rooms stay genuinely quiet and busy spikes feel like a Real Geiger crackle. */
export function clickRateHzFromZScore(zAbs: number): number {
  if (!Number.isFinite(zAbs) || zAbs < 0.5) return 0;
  const x = Math.max(0, zAbs - 0.5); // shift so 0.5σ = baseline silence
  // Quadratic-ish: 1σ ≈ 0.5 Hz, 2σ ≈ 4 Hz, 3σ ≈ 12 Hz, capped at 15 Hz.
  return Math.min(15, x * x * 1.5);
}

/**
 * Emit a single Geiger click. Schedule via Web Audio so adjacent clicks at
 * 12 Hz don't queue up on the JS event loop. Uses a short noise burst
 * shaped by a sharp bandpass — that's the canonical "metallic tick" sound,
 * not a sine pop.
 *
 * `intensity` (0..1) controls timbre brightness; passes through to the
 * bandpass centre frequency so 0σ feels muffled and 3σ feels crisp.
 */
export function playKiiClick(intensity = 0.5): void {
  const ctx = getMixerAudioContext();
  const dest = getMixerChannel("kii");
  if (!ctx || !dest) return;
  if (ctx.state === "suspended") void ctx.resume();

  // ~10-15 ms noise burst. We build the noise inline (one buffer per click)
  // because the burst is tiny — keeping a shared 400 ms buffer like the
  // Spirit Box does isn't worth the indirection for sub-frame audio.
  const dur = 0.012;
  let src: AudioBufferSourceNode;
  try {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    src = ctx.createBufferSource();
    src.buffer = buf;
  } catch {
    return;
  }

  // Bandpass centre 2.2-3.6 kHz — bright metallic tick range. Higher intensity
  // pulls the centre up, giving the "more activity = brighter click" feel
  // promised by the spec.
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2200 + intensity * 1400;
  bp.Q.value = 7;

  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.9, t0 + 0.001);  // 1 ms attack
  env.gain.linearRampToValueAtTime(0,   t0 + dur);    // exponential-ish decay

  src.connect(bp).connect(env).connect(dest);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
  src.onended = () => {
    try { src.disconnect(); } catch { /* ignore */ }
    try { bp.disconnect(); }  catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REM Pod warble (descending tone sweep)
//
// One shot per rising-edge crossing of 2.5σ — see drawRemPod's pulse trigger.
// Sweeps 600 Hz → 200 Hz over 300 ms with a soft sine envelope. Reads as a
// "uh-oh" tone — distinctly different from the Geiger clicks so an operator
// can tell which meter just fired without looking at the screen.
// ─────────────────────────────────────────────────────────────────────────────

export function playRemPodPulse(): void {
  const ctx = getMixerAudioContext();
  const dest = getMixerChannel("remPod");
  if (!ctx || !dest) return;
  if (ctx.state === "suspended") void ctx.resume();

  const dur = 0.30;
  const t0 = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, t0);
  osc.frequency.exponentialRampToValueAtTime(200, t0 + dur);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.7, t0 + 0.020);     // 20 ms attack
  env.gain.linearRampToValueAtTime(0.5, t0 + dur * 0.6);
  env.gain.linearRampToValueAtTime(0,   t0 + dur);

  osc.connect(env).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  osc.onended = () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

// Re-export the channel-id type so external callers (tests) can reference
// the same union the mixer uses. Avoids a second name for the same thing.
export type { MeterChannelId };
