/**
 * itcAudioMixer — single Web Audio mixer for ALL meter / tool output.
 *
 * # Why this exists
 *
 * The previous flow routed `speechSynthesis.speak(...)` straight to the device
 * speakers. With `echoCancellation: false` on the camera mic (required for
 * forensic EVP work), the speaker output was re-captured by the mic and baked
 * into the recording as a feedback loop. The mixer routes synthesised tones
 * through a `MediaStreamAudioDestinationNode` instead, so the audio reaches
 * MediaRecorder + WHIP but never the device speakers — no feedback.
 *
 *     [tool A gain] ─┐
 *     [tool B gain] ─┼─► [master gain] ─► [MediaStreamAudioDestinationNode]
 *     [meter X gain]─┘
 *
 * Master gain is exposed via `setMasterGain` for the push-to-talk hook to duck
 * tones while the operator narrates. The AudioContext itself is the shared
 * singleton from `audioUnlock.ts` — we don't construct a second one (each
 * extra context wastes a hardware audio path and risks re-tripping the
 * autoplay policy).
 *
 * # Phase C — meter sonification + recording-bus parity guarantee
 *
 * Originally the mixer only routed two ITC tool sources (Spirit Box + Ovilus).
 * Phase C widens it to every sonified meter — K-II, REM Pod, VU overload,
 * EMF galvanometer, motion detector — so they all hit the same recording bus
 * the operator hears on monitor headphones AND the audience hears on the WHIP
 * livestream. The signal path is unchanged; only the per-tool gain map grows.
 *
 * Each meter's draw function fires its own emit*() helper at the moment a
 * trigger event happens (LED count change, REM pulse, motion delta, VU
 * overload). Throttling lives in the draw functions (edge detect + minimum
 * interval) so the mixer just plays whatever gets handed to it.
 *
 * ## Parity guarantee
 *
 * The `MediaStream` returned by `getStream()` is added to the outgoing track
 * set inside `LiveStreamView`, which is then passed to BOTH:
 *
 *   1. `MediaRecorder` — produces the saved MP4/WebM file. Burned into the
 *      forensic chain (timestamp + case ID overlays); the audio it captures
 *      includes the mixer's mixed track. So every sonified meter cue lands
 *      in the recording.
 *   2. `startWhipSession({ stream })` — WebRTC WHIP ingest to YouTube /
 *      Twitch / Cloudflare Stream. Same outgoing MediaStream, so the WHIP
 *      audio track is the SAME composite. Every cue lands in the
 *      livestream too.
 *
 * That parity is structural — there's only one mixer destination and only
 * one outgoing stream. If a future change ever routes a meter cue to
 * `ctx.destination` directly (skipping the mixer), the cue would be heard
 * locally but NOT recorded NOT live-streamed. That's a regression. The
 * itcAudioMixer.test.ts parity test catches it by asserting every channel
 * id is reachable through `getMixerChannel()` and connected to the
 * MediaStreamAudioDestinationNode.
 */

import { peekAudioContext, unlockAudio } from "./audioUnlock";

/** Tool ids this mixer accepts. Originally ITC-only (spiritBox + ovilus);
 *  Phase C widened to cover every sonified meter so recording-bus parity is
 *  preserved across the meter family. EVP doesn't currently emit synthesised
 *  tones (it's user-recorded audio) so it's not routed here. */
type ToolId =
  | "spiritBox"   // chopped phoneme bank, ~280 ms intervals
  | "ovilus"      // word-of-the-moment, ~8 s intervals
  | "kii"         // Geiger-counter clicks (Phase C)
  | "remPod"      // pulse warble on z-score ≥ 2.5σ (Phase C)
  | "emfGalvo"    // subtle needle-deflection ticks (Phase C)
  | "vuOverload"  // peak chirp on red-zone hits (Phase C)
  | "motion";     // chirp on accelerometer trigger (Phase C)

export interface ItcMixer {
  /** Smoothly ramp the master gain. rampMs defaults to 50ms. */
  setMasterGain(value: number, rampMs?: number): void;
  /** The mixed MediaStream containing one synthetic audio track. */
  getStream(): MediaStream;
  /**
   * Toggle a parallel monitor tap that routes the mixed output to
   * `ctx.destination` (device default audio out — headphones if plugged
   * in, speakers otherwise). The recording/streaming path is unaffected.
   *
   * Operator should only enable this when monitoring through HEADPHONES,
   * otherwise the speaker output gets recaptured by the camera mic and we
   * lose the feedback-loop fix this mixer exists for. The UI guards this
   * with a Setup → Broadcast toggle that defaults to OFF.
   */
  setMonitor(enabled: boolean): void;
}

interface InternalMixer extends ItcMixer {
  context: AudioContext;
  gainFor: (toolId: ToolId) => GainNode;
}

let cached: InternalMixer | null = null;

function buildMixer(ctx: AudioContext): InternalMixer {
  const destination = ctx.createMediaStreamDestination();

  const master = ctx.createGain();
  master.gain.value = 1.0;
  master.connect(destination);

  // Optional monitor tap — disconnected by default so nothing reaches
  // ctx.destination (and therefore the device speakers). Operator opts in
  // via Setup when they have headphones in.
  let monitorConnected = false;

  const gains = new Map<ToolId, GainNode>();
  // Per-tool starting volumes. Spirit Box sits a touch lower (chopped phonemes
  // are noisier). Meter cues are quieter than the ITC tools so they don't
  // mask the spoken / phoneme content — operators care about hearing the
  // ITC text first, the meter SFX second.
  const DEFAULT_GAINS: Record<ToolId, number> = {
    spiritBox:   0.60,
    ovilus:      0.80,
    kii:         0.30,
    remPod:      0.45,
    emfGalvo:    0.20,
    vuOverload:  0.55,
    motion:      0.50,
  };

  const gainFor = (toolId: ToolId): GainNode => {
    const existing = gains.get(toolId);
    if (existing) return existing;
    const node = ctx.createGain();
    node.gain.value = DEFAULT_GAINS[toolId];
    node.connect(master);
    gains.set(toolId, node);
    return node;
  };

  return {
    context: ctx,
    gainFor,
    setMasterGain(value, rampMs = 50) {
      const now = ctx.currentTime;
      const target = Math.max(0, Math.min(1, value));
      const seconds = Math.max(0, rampMs) / 1000;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(target, now + seconds);
      } catch {
        // Some browsers throw on cancelScheduledValues for unusual states.
        master.gain.value = target;
      }
    },
    getStream() {
      return destination.stream;
    },
    setMonitor(enabled) {
      if (enabled === monitorConnected) return;
      try {
        if (enabled) {
          master.connect(ctx.destination);
          monitorConnected = true;
        } else {
          master.disconnect(ctx.destination);
          monitorConnected = false;
        }
      } catch {
        // disconnect() throws when the node isn't connected to that
        // destination — treat as idempotent.
        monitorConnected = enabled;
      }
    },
  };
}

/**
 * Lazy-init the singleton mixer. Throws if Web Audio is unavailable; callers
 * (tool hooks) wrap in try/catch and silently skip the audible cue.
 */
export function getItcMixer(): ItcMixer {
  if (cached) return cached;
  const ctx = unlockAudio();
  if (!ctx) throw new Error("Web Audio unavailable");
  cached = buildMixer(ctx);
  return cached;
}

/** Internal — used by the tone-burst helpers below to skip work when no
 *  AudioContext has been unlocked yet (the mixer can't synthesise without a
 *  gesture). Public callers should use getItcMixer(). */
function peekMixer(): InternalMixer | null {
  if (cached) return cached;
  const ctx = peekAudioContext();
  if (!ctx) return null;
  cached = buildMixer(ctx);
  return cached;
}

/**
 * Public peek — for callers that legitimately can't be guaranteed to run from
 * a gesture (e.g. meter sonification helpers fired from the canvas
 * compositor's draw loop). Returns null when Web Audio hasn't been unlocked
 * yet; callers should silently skip the audible cue in that case rather than
 * trying to force creation, which would re-trip the autoplay policy.
 *
 * Exposed as `getAudioContext()` so the meter sonification module can read
 * `currentTime` for sample-accurate scheduling without going through the
 * narrower per-tool `emit*` helpers — those are envelope-fixed and don't fit
 * every meter trigger shape.
 */
export function getMixerAudioContext(): AudioContext | null {
  const mixer = peekMixer();
  return mixer ? mixer.context : null;
}

/**
 * Public per-tool gain getter — meter sonification helpers connect their
 * envelope nodes here so the mixer's master-gain duck (push-to-talk) still
 * applies. The narrow union is intentional: forces callers to pick a
 * canonical channel and not invent ad-hoc ones.
 *
 * Naming retained as `MeterChannelId` for backwards-compat with the meter
 * sonification module; in practice the type covers BOTH meter cues (kii /
 * remPod / vuOverload / emfGalvo / motion) and the legacy ITC tools
 * (spiritBox / ovilus). The scan-hiss helper, for example, routes through
 * the spiritBox channel so push-to-talk ducks the hiss and the phoneme
 * bursts together.
 */
export type MeterChannelId = ToolId;

export function getMixerChannel(channel: MeterChannelId): GainNode | null {
  const mixer = peekMixer();
  return mixer ? mixer.gainFor(channel) : null;
}

// ── Tone-burst synthesis ───────────────────────────────────────────────────
// Spirit Box and Ovilus both schedule short oscillator bursts on their own
// gain stage. Consolidating here so the two hooks don't drift in their
// envelope/pitch logic.
//
// Phase C: Spirit Box upgraded to formant-shaped voice-band noise (see
// emitFormantBurst below). The `SPIRIT_BOX_BANDS_HZ` table is gone with it
// — that was the old per-phoneme sine-pop pitch picker. Ovilus retains its
// original pure-tone "blip" because (a) Ovilus is meant to read as a digital
// dictionary device, not a chopped-voice radio, and (b) one tone per ~8 s is
// already low enough not to fatigue the ear.

const OVILUS_BANDS_HZ     = [110, 165, 220, 275] as const;

function pickPitch(text: string, bands: readonly number[]): number {
  if (!text) return bands[0];
  return bands[text.charCodeAt(0) % bands.length];
}

interface ToneSpec {
  toolId: ToolId;
  frequency: number;
  waveform: OscillatorType;
  /** Total burst duration in seconds. */
  totalSec: number;
  /** Attack ramp 0→peak, in seconds. */
  attackSec: number;
  /** Peak envelope gain, 0-1. */
  peak: number;
  /** Optional sustain plateau — { atSec, level } applied between attack and
   *  the final decay-to-zero. Omitted for a simple attack/decay envelope. */
  sustain?: { atSec: number; level: number };
}

function emit(spec: ToneSpec): void {
  const mixer = peekMixer();
  if (!mixer) return;
  const ctx = mixer.context;
  // iOS audio sessions can suspend the context behind our back (incoming call,
  // backgrounding). Cheap to nudge each tick.
  if (ctx.state === "suspended") void ctx.resume();

  const osc = ctx.createOscillator();
  osc.type = spec.waveform;
  osc.frequency.value = spec.frequency;

  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(spec.peak, t0 + spec.attackSec);
  if (spec.sustain) {
    env.gain.linearRampToValueAtTime(spec.sustain.level, t0 + spec.sustain.atSec);
  }
  env.gain.linearRampToValueAtTime(0, t0 + spec.totalSec);

  osc.connect(env).connect(mixer.gainFor(spec.toolId));
  osc.start(t0);
  osc.stop(t0 + spec.totalSec + 0.05);
  // Explicit disconnect on natural end — defensive against iOS Safari's
  // historic tendency to hold onto stopped-but-still-connected nodes.
  osc.onended = () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

/**
 * Spirit Box — formant-shaped voice-band noise burst (~180 ms).
 *
 * Phase C upgrade: was a single sine "pop" — clean tone, sounded like a
 * synthesiser. Now we route a short white-noise buffer through two parallel
 * bandpass filters tuned to the first two vocal formants for the phoneme's
 * leading vowel. That gives the chopped-voice texture a real radio-sweep
 * Spirit Box produces, without the receiver hearing a clearly-spoken word
 * (which would undercut the "the brain pareidolias the meaning" forensic
 * story — see phonemeSynth.ts for the same approach in the Estes tool).
 *
 * Formant table is a Peterson & Barney 1952 adult-male average; matches the
 * one PhonemeSynth uses so the dock-tier Spirit Box now sounds the same as
 * the dedicated Estes panel. Honest copy unchanged — the silkscreen still
 * says "curated phoneme bank" because that's what this is.
 */
export function emitSpiritBoxTone(phoneme: string): void {
  emitFormantBurst(phoneme);
}

// ── Voice-band phoneme synthesis (Spirit Box) ─────────────────────────────
// Inlined here rather than imported from phonemeSynth.ts because:
//   1. PhonemeSynth manages its own master gain + dedicated context lifetime —
//      the dock-tier Spirit Box wants to route through the shared mixer.
//   2. The dock cycle is faster (280 ms intervals vs Estes's 800 ms+), so a
//      shorter / sharper envelope fits better.
// The formant table is duplicated (~20 lines) but stays adjacent to its
// consumer — drift between the two is acceptable; both are "voice-band noise
// suggesting phoneme X". License-clean: vowel-formant frequencies are well-
// known phonetic measurements (Peterson & Barney 1952), no copyright.

/** First-two-formant Hz table, indexed by lowercase phoneme / digraph. */
const VOWEL_FORMANTS: Record<string, [number, number]> = {
  a:  [730, 1090], e:  [530, 1840], i:  [270, 2290], o:  [570, 840], u:  [300, 870],
  ah: [730, 1090], oh: [570, 840],  uh: [490, 1350], eh: [530, 1840],
  ee: [270, 2290], oo: [300, 870],  ai: [660, 1700], ei: [530, 1840],
  ou: [490, 1100], ie: [400, 2000],
};

/** Pick first two formants for a phoneme. Tries the exact digraph table
 *  first, then falls back to the first vowel letter, finally to schwa. */
function pickFormants(phoneme: string): [number, number] {
  const lower = phoneme.toLowerCase();
  if (VOWEL_FORMANTS[lower]) return VOWEL_FORMANTS[lower];
  for (const ch of lower) {
    if (VOWEL_FORMANTS[ch]) return VOWEL_FORMANTS[ch];
  }
  return [500, 1500];
}

/** Shared noise buffer — ~400 ms of stationary white noise, looped per burst.
 *  Per-mixer (one buffer per AudioContext) so it survives sample-rate flips
 *  and gets GC'd when the mixer resets in tests. Built lazily on first emit. */
let noiseBuffer: { ctx: AudioContext; buf: AudioBuffer } | null = null;

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.ctx === ctx) return noiseBuffer.buf;
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * 0.4));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = { ctx, buf };
  return buf;
}

function emitFormantBurst(phoneme: string): void {
  const mixer = peekMixer();
  if (!mixer) return;
  const ctx = mixer.context;
  if (ctx.state === "suspended") void ctx.resume();

  const dur = 0.18; // 180 ms — a touch shorter than the 280 ms phoneme cycle
                    //          so adjacent bursts don't overlap into mush.
  const [f1, f2] = pickFormants(phoneme);

  let src: AudioBufferSourceNode;
  try {
    src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
  } catch {
    // happy-dom / older JSDOM may not implement createBuffer — skip silently.
    return;
  }
  src.loop = true;

  const bp1 = ctx.createBiquadFilter();
  bp1.type = "bandpass"; bp1.frequency.value = f1; bp1.Q.value = 6;
  const bp2 = ctx.createBiquadFilter();
  bp2.type = "bandpass"; bp2.frequency.value = f2; bp2.Q.value = 6;

  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  const peak = 0.85;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak,        t0 + 0.012);   // 12 ms attack
  env.gain.linearRampToValueAtTime(peak * 0.65, t0 + dur * 0.55);
  env.gain.linearRampToValueAtTime(0,           t0 + dur);     // soft tail

  const mix = ctx.createGain();
  mix.gain.value = 0.5;

  src.connect(bp1).connect(mix);
  src.connect(bp2).connect(mix);
  mix.connect(env).connect(mixer.gainFor("spiritBox"));

  src.start(t0);
  src.stop(t0 + dur + 0.02);
  src.onended = () => {
    try { src.disconnect(); } catch { /* ignore */ }
    try { bp1.disconnect(); } catch { /* ignore */ }
    try { bp2.disconnect(); } catch { /* ignore */ }
    try { mix.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
}

/** Ovilus — longer (600ms) triangle burst with a near-flat sustain that
 *  reads as a word rather than a chop. Lower pitch bands keep it audibly
 *  distinct from the Spirit Box. */
export function emitOvilusTone(word: string): void {
  const total = 0.6;
  emit({
    toolId: "ovilus",
    frequency: pickPitch(word, OVILUS_BANDS_HZ),
    waveform: "triangle",
    totalSec: total,
    attackSec: 0.05,
    peak: 0.85,
    sustain: { atSec: total * 0.75, level: 0.85 * 0.9 },
  });
}

/** Test-only helper. Drops the cached singleton so a fresh getItcMixer() call
 *  rebuilds with a different AudioContext (e.g. when JSDOM re-stubs it). The
 *  shared audioUnlock context is left alone — callers that want to reset it
 *  should use closeAudioContext() from audioUnlock.ts.
 *
 *  Also clears the formant-noise buffer cache so the next emit() allocates
 *  fresh against the new context (or whatever fake the next test installs). */
export function __resetItcMixerForTests(): void {
  cached = null;
  noiseBuffer = null;
}
