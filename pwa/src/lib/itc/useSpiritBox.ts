/**
 * useSpiritBox — phoneme cycle for the dock-tier Spirit Box.
 *
 * Each tick picks a phoneme, burns the text into the ITC overlay channel, and
 * triggers an audible tone burst through the shared ITC mixer (no speech
 * synthesis — that fed back through the camera mic).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextPhoneme } from "./phonemes";
import { setSpiritBoxEmission } from "./itcChannels";
import { useSessionEdge } from "./useSessionEdge";
import { emitSpiritBoxTone } from "../audio/itcAudioMixer";

const INTERVAL_MS = 280;

export function useSpiritBox(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  useSessionEdge(sessionRunning, autoStart, setActive);

  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setSpiritBoxEmission(phoneme);
      emitSpiritBoxTone(phoneme);
    }, INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [active]);

  const toggle = useCallback(() => setActive((v) => !v), []);
  return { active, toggle, current };
}
