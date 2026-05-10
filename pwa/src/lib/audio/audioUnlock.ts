/**
 * audioUnlock — gesture-time AudioContext creation + resume helper.
 *
 * # Why this exists
 *
 * Web Audio's autoplay policy requires that an AudioContext be either
 * (a) constructed inside a user-gesture handler or (b) explicitly
 * `resume()`d from one. If neither happens, the context stays
 * `suspended` and every emit() is silent — no error, just no audio.
 *
 * The Spirit-Box / Radio-Sweep flow used to instantiate the synth in a
 * `useEffect` that runs AFTER the React commit phase, i.e. AFTER the
 * gesture handler has returned. iOS Safari + Facebook Messenger's
 * in-app browser are strict about this: by useEffect-time the gesture
 * is gone, the context starts suspended, and resume() rejects with no
 * way to recover (no further gesture is on the way).
 *
 * # Fix
 *
 * Call `unlockAudio()` from the toggle's `onChange` handler — that's
 * still inside the synchronous event handler / gesture window. It
 * lazily constructs ONE singleton AudioContext for the whole tab and
 * calls `resume()` on it immediately. Subsequent unlock() calls are
 * idempotent and free (they just kick `resume()` again if for some
 * reason the OS suspended it — e.g. iOS audio-session interruption).
 *
 * Other modules (PhonemeSynth, RadioSweep) accept this shared context
 * via constructor so they hang their GainNodes off it instead of each
 * creating their own (which would re-trigger the autoplay-policy
 * problem AND waste hardware audio paths).
 */

let sharedCtx: AudioContext | null = null;

/**
 * Get-or-create the singleton AudioContext. Must be called from a user
 * gesture the FIRST time per tab — subsequent calls are safe from any
 * context. Returns null if Web Audio is unavailable (very old browsers
 * or strict private-mode restrictions).
 */
export function unlockAudio(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      // Fire-and-forget. If we're inside a gesture this resolves; if
      // we're not, it rejects silently and the next gesture will get
      // another chance.
      void sharedCtx.resume();
    }
    return sharedCtx;
  }
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!AC) return null;
    sharedCtx = new AC();
    // First resume — usually a no-op on Chromium desktop (context is
    // already running), critical on iOS Safari + in-app browsers
    // (context starts suspended even when constructed from a gesture).
    void sharedCtx.resume();
    return sharedCtx;
  } catch {
    sharedCtx = null;
    return null;
  }
}

/** Read the shared context without forcing creation. Returns null if
 *  unlockAudio() hasn't been called yet. */
export function peekAudioContext(): AudioContext | null {
  return sharedCtx && sharedCtx.state !== "closed" ? sharedCtx : null;
}

/** Tear down the shared context. Only useful from session-end
 *  cleanups — for V1 we keep one context for the lifetime of the tab
 *  since re-creating is expensive and the autoplay window can't be
 *  re-opened without another gesture. */
export function closeAudioContext(): void {
  try { sharedCtx?.close(); } catch { /* ignore */ }
  sharedCtx = null;
}
