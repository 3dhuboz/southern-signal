/**
 * useSpiritBox — phoneme cycle for the dock-tier Spirit Box.
 *
 * Each tick picks a phoneme, burns the text into the ITC overlay channel, and
 * triggers an audible tone burst through the shared ITC mixer (no speech
 * synthesis — that fed back through the camera mic).
 *
 * Phase C: the per-phoneme tone is now a formant-shaped voice-band noise
 * burst (see `emitSpiritBoxTone` in itcAudioMixer.ts) instead of the old
 * single sine pop — sounds like real chopped voice texture, not a chirp.
 * A quiet continuous radio-static hiss runs underneath the bursts while
 * the cycle is active so the operator gets the auditory "radio in scan
 * mode" feel that real Spirit Boxes have.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextPhoneme } from "./phonemes";
import { setSpiritBoxEmission } from "./itcChannels";
import { useSessionEdge } from "./useSessionEdge";
import { emitSpiritBoxTone } from "../audio/itcAudioMixer";
import { setSpiritBoxScanHiss } from "../audio/meterSonification";

const INTERVAL_MS = 280;

export function useSpiritBox(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  useSessionEdge(sessionRunning, autoStart, setActive);

  useEffect(() => {
    if (!active) {
      setSpiritBoxScanHiss(false);
      return;
    }
    setSpiritBoxScanHiss(true);
    const handle = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setSpiritBoxEmission(phoneme);
      emitSpiritBoxTone(phoneme);
    }, INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
      setSpiritBoxScanHiss(false);
    };
  }, [active]);

  const toggle = useCallback(() => setActive((v) => !v), []);
  return { active, toggle, current };
}
