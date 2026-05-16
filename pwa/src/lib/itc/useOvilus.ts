/**
 * useOvilus — minimal dock-tier Ovilus hook.
 *
 * Drives the word-generation cycle and publishes each word to the compositor
 * ITC overlay channel via setOvilusEmission(). The audible cue is a longer,
 * lower synthesised tone routed through the shared ITC audio mixer; the
 * visible cue is the word baked onto the overlay canvas.
 *
 * Synthesised tones replace speech because speechSynthesis routes through
 * device speakers and the mic re-captures it (feedback loop). The word
 * still burns into the overlay; the tone is the audible cue.
 *
 * Pitch / envelope differs from the Spirit Box so the operator can tell the
 * two apart by ear:
 *   • Longer (600ms vs 200ms) — Ovilus is a slow word generator, not a chop.
 *   • Lower pitch bands (110/165/220/275Hz vs 220/330/440/660Hz).
 *   • Slower attack (50ms vs 10ms) — soft fade-in feels word-like.
 *
 * Fixed parameters (no sliders in dock context):
 *   intervalMs  8 000 ms  — matches OvilusTool default
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextOvilusWord } from "./ovilusDictionary";
import { setOvilusEmission } from "./itcChannels";
import { getItcMixer } from "../audio/itcAudioMixer";

const INTERVAL_MS = 8000;

// Lower than the Spirit Box bands so the two are audibly distinguishable —
// Ovilus emits longer, slower, deeper. First-char of the word picks the bin.
const PITCH_BANDS_HZ = [110, 165, 220, 275] as const;

function pickPitch(word: string): number {
  if (!word) return PITCH_BANDS_HZ[0];
  const idx = word.charCodeAt(0) % PITCH_BANDS_HZ.length;
  return PITCH_BANDS_HZ[idx];
}

/**
 * Schedule a ~600ms tone on the shared ITC mixer's ovilus gain node. The
 * triangle waveform + slow attack gives a softer, word-shaped feel distinct
 * from the Spirit-Box's quick sine pop.
 */
function emitToneBurst(word: string): void {
  let mixer;
  try { mixer = getItcMixer(); }
  catch { return; }
  const ctx = mixer.context;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const gain = mixer.getGainNode("ovilus");

  const osc = ctx.createOscillator();
  osc.type = "triangle"; // softer harmonic content than the spirit-box sine
  osc.frequency.value = pickPitch(word);

  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  const total = 0.6;          // 600ms total
  const attack = 0.05;        // 50ms attack
  const sustainStart = attack;
  const sustainEnd = total * 0.75;
  const peak = 0.85;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  // Hold the peak for the middle of the envelope so the tone reads as a
  // sustained word, then gentle decay so the tail doesn't click.
  env.gain.linearRampToValueAtTime(peak * 0.9, t0 + sustainEnd);
  env.gain.linearRampToValueAtTime(0, t0 + total);

  osc.connect(env).connect(gain);
  osc.start(t0);
  osc.stop(t0 + total + 0.05);
  // sustainStart isn't read directly — kept as a named constant in case we
  // later want to tweak the hold portion without re-deriving the math.
  void sustainStart;
}

export function useOvilus(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  // Session-running edge handling — see useSpiritBox for full rationale.
  // Rising edge with autoStart=true kicks the cycle on (used by the Pro/Lab
  // scene); falling edge hard-stops so words don't continue after End.
  const prevSessionRunningRef = useRef(sessionRunning);
  useEffect(() => {
    const prev = prevSessionRunningRef.current;
    prevSessionRunningRef.current = sessionRunning;
    if (!sessionRunning) {
      setActive(false);
      return;
    }
    if (!prev && autoStart) setActive(true);
  }, [sessionRunning, autoStart]);

  // Emit one word — stable because it only reads refs and stable setters.
  const emitWord = useCallback(() => {
    const { word, nextSeed } = nextOvilusWord(seedRef.current, entropyRef.current);
    seedRef.current = nextSeed;
    setCurrent(word);
    setOvilusEmission(word);
    emitToneBurst(word);
  }, []);

  // Main word cycle. Emits one word immediately so the operator sees output
  // straight away rather than waiting up to 8 seconds for the first word.
  useEffect(() => {
    if (!active) return;
    emitWord();
    const handle = window.setInterval(emitWord, INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [active, emitWord]);

  const toggle = useCallback(() => setActive((v) => !v), []);

  return { active, toggle, current };
}
