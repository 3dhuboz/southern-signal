/**
 * useOvilus — word cycle for the dock-tier Ovilus.
 *
 * Each tick picks a dictionary word, burns the text into the ITC overlay
 * channel, and triggers an audible tone burst through the shared ITC mixer.
 * The tone is longer / lower than the Spirit Box's so the two are audibly
 * distinguishable on monitoring headphones.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextOvilusWord } from "./ovilusDictionary";
import { setOvilusEmission } from "./itcChannels";
import { useSessionEdge } from "./useSessionEdge";
import { emitOvilusTone } from "../audio/itcAudioMixer";

const INTERVAL_MS = 8000;

export function useOvilus(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  useSessionEdge(sessionRunning, autoStart, setActive);

  const emitWord = useCallback(() => {
    const { word, nextSeed } = nextOvilusWord(seedRef.current, entropyRef.current);
    seedRef.current = nextSeed;
    setCurrent(word);
    setOvilusEmission(word);
    emitOvilusTone(word);
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
