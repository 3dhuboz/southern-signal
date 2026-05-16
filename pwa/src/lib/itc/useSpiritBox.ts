/**
 * useSpiritBox — minimal dock-tier spirit-box hook.
 *
 * Drives the phoneme cycle and publishes each phoneme to the compositor ITC
 * overlay channel via setSpiritBoxEmission(). The audible cue is a short
 * synthesised tone burst routed through the shared ITC audio mixer; the
 * visible cue is the phoneme text baked onto the overlay canvas.
 *
 * Synthesised tones replace speech because speechSynthesis routes through
 * device speakers and the mic re-captures it (feedback loop). The phoneme
 * text still burns into the overlay; the tone is the audible cue.
 *
 * Fixed parameters (no sliders in dock context):
 *   intervalMs  280 ms  — matches SpiritBoxTool default
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextPhoneme } from "./phonemes";
import { setSpiritBoxEmission } from "./itcChannels";
import { getItcMixer } from "../audio/itcAudioMixer";

const INTERVAL_MS = 280;

// Four pitch bands keyed off the first character of the phoneme. Higher
// pitches map onto front vowels / sharp consonants so the audible texture
// still tracks loosely with the phoneme bucket — useful for an operator
// monitoring headphones without watching the overlay.
const PITCH_BANDS_HZ = [220, 330, 440, 660] as const;

function pickPitch(phoneme: string): number {
  if (!phoneme) return PITCH_BANDS_HZ[0];
  // Modulo into the band table — phonemes from `nextPhoneme()` are short
  // ASCII strings, so charCodeAt(0) is plenty of entropy for a 4-bucket bin.
  const idx = phoneme.charCodeAt(0) % PITCH_BANDS_HZ.length;
  return PITCH_BANDS_HZ[idx];
}

/**
 * Schedule a ~200ms tone burst on the shared ITC mixer's spirit-box gain
 * node. Failure is silent — autoplay rejection just means no audible cue.
 */
function emitToneBurst(phoneme: string): void {
  let mixer;
  try { mixer = getItcMixer(); }
  catch { return; }
  const ctx = mixer.context;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const gain = mixer.getGainNode("spiritBox");

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = pickPitch(phoneme);

  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  const total = 0.2;          // 200ms total
  const attack = 0.01;        // 10ms attack
  const peak = 0.9;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  // 190ms decay → silence. Use linearRamp; exponentialRamp can't approach 0.
  env.gain.linearRampToValueAtTime(0, t0 + total);

  osc.connect(env).connect(gain);
  osc.start(t0);
  osc.stop(t0 + total + 0.02);
}

export function useSpiritBox(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  // Session-running edge handling:
  //   • false → true with autoStart=true: scene-driven kick-on (e.g. Spirit
  //     Box Session scene). Fires on the rising edge only, so if the operator
  //     manually toggles off mid-session it stays off.
  //   • → false: hard-stop so the spirit box doesn't cycle silently after
  //     End is pressed.
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

  // Hard-stop when the tab goes background (avoids audio running while the
  // phone is in a pocket or another app is in front).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        setActive(false);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  // Main phoneme cycle. Tone bursts are scheduled on the AudioContext so
  // there's nothing further to cancel on cleanup — the interval shutdown
  // alone halts the audible output.
  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setSpiritBoxEmission(phoneme);
      emitToneBurst(phoneme);
    }, INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [active]);

  const toggle = useCallback(() => setActive((v) => !v), []);

  return { active, toggle, current };
}
