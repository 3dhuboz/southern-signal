/**
 * useSpiritBox — minimal dock-tier spirit-box hook.
 *
 * Drives the phoneme cycle + SpeechSynthesis at a fixed interval and
 * publishes each phoneme to the compositor ITC overlay channel via
 * setSpiritBoxEmission(). No UI — just the cycling logic extracted from
 * SpiritBoxTool so CameraScreen can run it without mounting the full panel.
 *
 * Fixed parameters (no sliders in dock context):
 *   intervalMs  280 ms  — matches SpiritBoxTool default
 *   volume      0.85    — matches SpiritBoxTool default
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { nextPhoneme } from "./phonemes";
import { setSpiritBoxEmission } from "./itcChannels";

const INTERVAL_MS = 280;
const VOLUME = 0.85;

export function useSpiritBox(entropy: number, sessionRunning: boolean, autoStart = false) {
  const [active, setActive] = useState(false);
  const [current, setCurrent] = useState("—");
  const seedRef    = useRef<number>(Date.now() & 0x7fffffff);
  const entropyRef = useRef<number>(entropy);
  useEffect(() => { entropyRef.current = entropy; }, [entropy]);

  // Cancel any in-flight utterance without throwing on browsers that error
  // before the first user gesture.
  const stopSpeech = useCallback(() => {
    try {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    } catch { /* swallow — some browsers throw before any speak() call */ }
  }, []);

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
      stopSpeech();
      setActive(false);
      return;
    }
    if (!prev && autoStart) setActive(true);
  }, [sessionRunning, autoStart, stopSpeech]);

  // Hard-stop when the tab goes background (avoids audio running while the
  // phone is in a pocket or another app is in front).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        stopSpeech();
        setActive(false);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [stopSpeech]);

  // Main phoneme cycle. Cleanup cancels both the interval and any queued
  // speech so stopping feels instantaneous.
  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => {
      const { phoneme, nextSeed } = nextPhoneme(seedRef.current, entropyRef.current);
      seedRef.current = nextSeed;
      setCurrent(phoneme);
      setSpiritBoxEmission(phoneme);
      try {
        if (typeof speechSynthesis !== "undefined") {
          speechSynthesis.cancel(); // keep cycle tight — never queue
          const u = new SpeechSynthesisUtterance(phoneme);
          u.rate   = 1.4;
          u.volume = VOLUME;
          speechSynthesis.speak(u);
        }
      } catch { /* requires user gesture on first speak — ignore */ }
    }, INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
      stopSpeech();
    };
  }, [active, stopSpeech]);

  // Final tear-down on unmount.
  useEffect(() => () => stopSpeech(), [stopSpeech]);

  const toggle = useCallback(() => setActive((v) => !v), []);

  return { active, toggle, current };
}
