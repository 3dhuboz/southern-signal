/**
 * itcAudioMixer — single Web Audio mixer for all ITC tool output (Spirit Box,
 * Ovilus, future EVP-style synths).
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
 *
 * Master gain is exposed via `setMasterGain` for the push-to-talk hook to duck
 * tones while the operator narrates. The AudioContext itself is the shared
 * singleton from `audioUnlock.ts` — we don't construct a second one (each
 * extra context wastes a hardware audio path and risks re-tripping the
 * autoplay policy).
 */

import { peekAudioContext, unlockAudio } from "./audioUnlock";

/** Tool ids this mixer accepts. Subset of `ItcSource` from itcChannels.ts;
 *  EVP doesn't currently emit tones (it's user-recorded audio) so it's not
 *  routed here. Widen if EVP ever needs its own synth channel. */
type ToolId = "spiritBox" | "ovilus";

export interface ItcMixer {
  /** Smoothly ramp the master gain. rampMs defaults to 50ms. */
  setMasterGain(value: number, rampMs?: number): void;
  /** The mixed MediaStream containing one synthetic audio track. */
  getStream(): MediaStream;
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

  const gains = new Map<ToolId, GainNode>();
  // Per-tool starting volumes — spirit box is the noisier of the two, so it
  // sits a touch lower in the mix by default.
  const DEFAULT_GAINS: Record<ToolId, number> = { spiritBox: 0.6, ovilus: 0.8 };

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

// ── Tone-burst synthesis ───────────────────────────────────────────────────
// Spirit Box and Ovilus both schedule short oscillator bursts on their own
// gain stage. Consolidating here so the two hooks don't drift in their
// envelope/pitch logic.

const SPIRIT_BOX_BANDS_HZ = [220, 330, 440, 660] as const;
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

/** Spirit Box — short (200ms) sine pop. Quick attack so the cycle feels chop-y. */
export function emitSpiritBoxTone(phoneme: string): void {
  emit({
    toolId: "spiritBox",
    frequency: pickPitch(phoneme, SPIRIT_BOX_BANDS_HZ),
    waveform: "sine",
    totalSec: 0.20,
    attackSec: 0.01,
    peak: 0.9,
  });
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
 *  should use closeAudioContext() from audioUnlock.ts. */
export function __resetItcMixerForTests(): void {
  cached = null;
}
