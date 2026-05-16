/**
 * useOvilus — minimal dock-tier Ovilus hook.
 *
 * Drives the word-generation cycle + SpeechSynthesis at a fixed interval and
 * publishes each word to the compositor ITC overlay channel via
 * setOvilusEmission(). No UI — logic extracted from OvilusTool so
 * CameraScreen can run the Ovilus without mounting the full panel.
 *
 * Fixed parameters (no sliders in dock context):
 *   intervalMs  8 000 ms  — matches OvilusTool default
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextOvilusWord } from "./ovilusDictionary";
import { setOvilusEmission } from "./itcChannels";

const INTERVAL_MS = 8000;

export function useOvilus(entropy: number, sessionRunning: boolean) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  // Hard-stop when the session ends.
  useEffect(() => {
    if (!sessionRunning) setActive(false);
  }, [sessionRunning]);

  // Emit one word — stable because it only reads refs and stable setters.
  const emitWord = useCallback(() => {
    const { word, nextSeed } = nextOvilusWord(seedRef.current, entropyRef.current);
    seedRef.current = nextSeed;
    setCurrent(word);
    setOvilusEmission(word);
    try {
      if (typeof speechSynthesis !== "undefined") {
        const u = new SpeechSynthesisUtterance(word);
        u.rate = 0.95;
        speechSynthesis.speak(u);
      }
    } catch { /* requires user gesture on first speak — ignore */ }
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
