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
 *   - VU overload:     one shot per rising-edge crossing of -3 dBFS
 *   - Motion chirp:    one shot per accel-magnitude delta trigger
 *   - EMF galvo tick:  fired on noticeable needle-velocity threshold
 *   - Spirit Box hiss: continuous loop while the cycle is active
 *
 * Ovilus blips are emitted by `useOvilus.ts` itself via the existing
 * `emitOvilusTone` helper in itcAudioMixer (not added here) — they're
 * already aligned with the per-word cycle, no draw-loop wiring needed.
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
 * - Motion chirp: triggered by accelerometer-magnitude delta, NOT a real
 *   PIR sensor — same caveat the silkscreen carries.
 * - EMF galvanometer tick: the same magnetometer z-score the K-II reads,
 *   just visualised differently. The tick is a soft thunk that reads as
 *   the analog meter's needle deflecting; lower timbre than the K-II so
 *   the two meters reading the same signal don't sound like a single
 *   doubled click.
 * - VU overload chirp: a real audio-level cue (the mic IS reading audio);
 *   no claim of "anomaly", just "you're clipping".
 * - Spirit Box scan hiss: synthesised pink-ish noise, NOT a real radio
 *   tuner audio. Honest copy in the silkscreen calls the device a
 *   "phoneme bank" so the hiss is just an auditory cue that the cycle is
 *   running, not a claim of radio reception.
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

// ─────────────────────────────────────────────────────────────────────────────
// Motion detector chirp (rising sweep)
//
// Fires once per accelerometer-magnitude trigger crossing (drawMotionDetector
// already detects this and latches its trigger LED for 1s). The sweep goes
// 200 Hz → 800 Hz over 100 ms — opposite direction from the REM Pod's
// descending sweep, so the two are audibly distinguishable.
// ─────────────────────────────────────────────────────────────────────────────

export function playMotionChirp(): void {
  const ctx = getMixerAudioContext();
  const dest = getMixerChannel("motion");
  if (!ctx || !dest) return;
  if (ctx.state === "suspended") void ctx.resume();

  const dur = 0.10;
  const t0 = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(200, t0);
  osc.frequency.exponentialRampToValueAtTime(800, t0 + dur);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.7, t0 + 0.005);
  env.gain.linearRampToValueAtTime(0,   t0 + dur);

  osc.connect(env).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  osc.onended = () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMF galvanometer needle tick (analog soft thunk)
//
// Real galvanometers produce a faint mechanical sound as the needle deflects
// — a soft low-pitched thunk. We emit one per noticeable needle-velocity
// step. Lower timbre than the K-II clicks (so the two meters reading the
// same magnetometer signal don't sound like a single doubled click).
// ─────────────────────────────────────────────────────────────────────────────

export function playGalvoTick(): void {
  const ctx = getMixerAudioContext();
  const dest = getMixerChannel("emfGalvo");
  if (!ctx || !dest) return;
  if (ctx.state === "suspended") void ctx.resume();

  const dur = 0.04;
  const t0 = ctx.currentTime;

  // Triangle wave at 80 Hz gives the soft analog thunk. Higher harmonics are
  // attenuated by the envelope so it doesn't compete with the Geiger clicks.
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 80;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.6, t0 + 0.003);
  env.gain.linearRampToValueAtTime(0,   t0 + dur);

  osc.connect(env).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  osc.onended = () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VU overload chirp (brief peak indicator)
//
// One shot per rising-edge crossing of -3 dBFS (the VU red-zone boundary).
// A short ~80 ms 1.2 kHz blip — the same kind of cue a hardware audio rec
// would make. Distinct from the K-II clicks (which sit in the metallic
// 2.5-3.5 kHz range).
// ─────────────────────────────────────────────────────────────────────────────

export function playVuOverloadChirp(): void {
  const ctx = getMixerAudioContext();
  const dest = getMixerChannel("vuOverload");
  if (!ctx || !dest) return;
  if (ctx.state === "suspended") void ctx.resume();

  const dur = 0.08;
  const t0 = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 1200;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.5, t0 + 0.004);
  env.gain.linearRampToValueAtTime(0,   t0 + dur);

  osc.connect(env).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  osc.onended = () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spirit Box scan hiss (continuous low-volume background)
//
// While the Spirit Box is sweeping, a quiet pink-ish noise hiss runs under
// the phoneme bursts — the auditory cue of a radio in scan mode. Kicks off
// on call with `true`, can be torn down with `false`. Routed through the
// spiritBox channel so push-to-talk ducks the hiss along with the phonemes.
//
// Honest copy: the silkscreen still calls the device a "phoneme bank" —
// the hiss is just an auditory cue that the cycle is running, NOT a claim
// of real radio tuner audio.
// ─────────────────────────────────────────────────────────────────────────────

let scanHissNode: { src: AudioBufferSourceNode; env: GainNode } | null = null;

/** Toggle the Spirit Box scan-hiss background. Cheap to call repeatedly with
 *  the same value — idempotent. */
export function setSpiritBoxScanHiss(active: boolean): void {
  if (active) {
    if (scanHissNode) return; // already running
    const ctx = getMixerAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    // Spirit Box bank lives on the spiritBox channel — share so push-to-talk
    // ducks the hiss + bursts together.
    const dest = getMixerChannel("spiritBox");
    if (!dest) return;

    // ~2 s noise loop. Bandpass at 1.5 kHz gives the AM-radio-static feel.
    let buf: AudioBuffer;
    let src: AudioBufferSourceNode;
    try {
      const sr = ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * 2.0));
      buf = ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
      src = ctx.createBufferSource();
      src.buffer = buf;
    } catch {
      return;
    }
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.6;

    const env = ctx.createGain();
    const t0 = ctx.currentTime;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.08, t0 + 0.15); // very quiet — sits under the bursts

    src.connect(bp).connect(env).connect(dest);
    src.start(t0);
    scanHissNode = { src, env };
  } else {
    if (!scanHissNode) return;
    const ctx = getMixerAudioContext();
    const { src, env } = scanHissNode;
    if (ctx) {
      const t0 = ctx.currentTime;
      env.gain.cancelScheduledValues(t0);
      env.gain.setValueAtTime(env.gain.value, t0);
      env.gain.linearRampToValueAtTime(0, t0 + 0.15);
      try { src.stop(t0 + 0.16); } catch { /* already stopped */ }
    } else {
      try { src.stop(); } catch { /* ignore */ }
    }
    src.onended = () => {
      try { src.disconnect(); } catch { /* ignore */ }
      try { env.disconnect(); } catch { /* ignore */ }
    };
    scanHissNode = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic test-only reset — lets unit tests start each case with a clean
// throttle / hiss state.
// ─────────────────────────────────────────────────────────────────────────────

export function __resetMeterSonificationForTests(): void {
  scanHissNode = null;
}

// Re-export the channel-id type so external callers (tests) can reference
// the same union the mixer uses. Avoids a second name for the same thing.
export type { MeterChannelId };
