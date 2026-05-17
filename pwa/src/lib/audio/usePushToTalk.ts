/**
 * usePushToTalk — duck the ITC audio mixer's master gain while the operator
 * is talking, so their narration lands cleanly on the recording without the
 * synthesised Spirit-Box / Ovilus tones bleeding over it.
 *
 * Driven by a single boolean `active` flag the parent flips on a hold-to-talk
 * button (or any other "speaking now" signal — e.g. VAD). Ramps are
 * asymmetric: fast duck (50ms) so the first syllable isn't masked, slower
 * ramp-back (200ms) so re-entry doesn't sound like a glitch.
 *
 * Falsy AudioContexts (autoplay rejection, no Web Audio) are silently no-op'd
 * — the recording still works, the duck just doesn't happen.
 */

import { useEffect } from "react";
import { getItcMixer } from "./itcAudioMixer";

export function usePushToTalk(active: boolean, duckedGain = 0.15): void {
  useEffect(() => {
    let mixer;
    try {
      mixer = getItcMixer();
    } catch {
      return;
    }
    if (active) {
      mixer.setMasterGain(duckedGain, 50);
      // Restore on unmount if we left mid-duck — otherwise a route change
      // while held would leave the singleton mixer ducked forever.
      return () => { mixer?.setMasterGain(1.0, 200); };
    }
    mixer.setMasterGain(1.0, 200);
  }, [active, duckedGain]);
}
