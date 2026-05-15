/**
 * chime — plays an 80ms 800Hz sine tone using the Web Audio API.
 *
 * Envelope: 2ms linear attack → 70ms sustain → 8ms linear release.
 * The oscillator and gain node are created fresh on each call and cleaned up
 * automatically after playback — no persistent state.
 *
 * If the caller provides an AudioContext it is used as-is (and is NOT closed
 * afterward). If none is provided, a transient AudioContext is created and
 * closed after the tone finishes. Either way, call this from a user-gesture
 * handler so mobile browsers permit audio playback.
 */
export function playChime(audioCtx?: AudioContext): void {
  const transient = audioCtx == null;
  let ctx: AudioContext;
  try {
    ctx = audioCtx ?? new AudioContext();
  } catch {
    // Web Audio not available — silent no-op.
    return;
  }

  const FREQ_HZ = 800;
  const TOTAL_S = 0.08;    // 80ms
  const ATTACK_S = 0.002;  // 2ms
  const SUSTAIN_S = 0.07;  // 70ms
  const RELEASE_S = 0.008; // 8ms (attack + sustain + release = 80ms)

  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.value = FREQ_HZ;

  // Envelope
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.8, now + ATTACK_S);
  gain.gain.setValueAtTime(0.8, now + ATTACK_S + SUSTAIN_S);
  gain.gain.linearRampToValueAtTime(0, now + ATTACK_S + SUSTAIN_S + RELEASE_S);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + TOTAL_S);

  // Clean up after playback. Give a small buffer so the release tail finishes.
  const cleanupMs = (TOTAL_S + 0.02) * 1000;
  osc.addEventListener("ended", () => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { gain.disconnect(); } catch { /* ignore */ }
    if (transient) {
      // Allow a brief settling period before closing so the gain release
      // isn't clipped by an immediate context suspend.
      window.setTimeout(() => {
        void ctx.close().catch(() => { /* ignore */ });
      }, 50);
    }
  });

  // Belt-and-suspenders: if the "ended" event never fires (some old WebKit
  // builds), schedule cleanup anyway.
  window.setTimeout(() => {
    try { osc.disconnect(); } catch { /* ignore */ }
    try { gain.disconnect(); } catch { /* ignore */ }
    if (transient) void ctx.close().catch(() => { /* ignore */ });
  }, cleanupMs + 100);
}
