/**
 * usePushToTalk — duck the ITC audio mixer's master gain while the operator
 * is talking, so their narration lands cleanly on the recording without the
 * synthesised Spirit-Box / Ovilus tones bleeding over it.
 *
 * Driven by a single boolean `active` flag that the parent flips on a hold-
 * to-talk button (or any other "speaking now" signal — e.g. VAD). Ramps are
 * asymmetric on purpose:
 *
 *   • Ducking down (active=true) is FAST (50ms) — the operator's voice can
 *     start before the duck completes; we want the tone out of the way
 *     immediately so their first syllable isn't masked.
 *   • Ramping back (active=false) is SLOWER (200ms) — avoids a sudden tone
 *     re-entry that would sound like a glitch in playback.
 *
 * The hook is render-cheap by design: it never mutates state, so the
 * component owning the boolean re-renders alone. Falsy AudioContexts
 * (autoplay rejection, no Web Audio) are silently no-op'd — the recording
 * still works, the duck just doesn't happen.
 */

import { useEffect } from "react";
import { getItcMixer } from "./itcAudioMixer";

export function usePushToTalk(active: boolean, duckedGain = 0.15): void {
  useEffect(() => {
    let mixer;
    try {
      mixer = getItcMixer();
    } catch {
      // Mixer unavailable (Web Audio off, autoplay rejected before any tool
      // was toggled on). Nothing to duck — exit silently so the recording
      // path keeps working without the duck nicety.
      return;
    }
    if (active) {
      // Clamp at the caller-supplied duck level so an operator who's never
      // pressed the talk button hears tones at full mixer volume.
      mixer.setMasterGain(duckedGain, 50);
    } else {
      mixer.setMasterGain(1.0, 200);
    }
    // No cleanup — the gain stays at its last commanded value until the
    // next active-state flip. If the parent unmounts mid-duck, the master
    // stays where it was; the next mount restores it on the rising edge.
  }, [active, duckedGain]);
}
