/**
 * phonemeSynth — formant-shaped noise burst synthesiser for the Estes-style
 * Spirit Box panel.
 *
 * Honest framing: real spirit boxes produce audio that sounds like chopped
 * fragments of human speech — bursts of voice-band noise with rough formant
 * structure. The brain pareidolias recognisable words out of that texture.
 *
 * The previous implementation used `speechSynthesis.speak("yes")`, which
 * reads each phoneme *clearly* in a TTS voice — sounds like a vocabulary
 * trainer, not a paranormal investigation tool. It also undercuts the
 * forensic story: any reported phrase could be objected to as "the receiver
 * just heard the word and parroted it."
 *
 * This synth replaces that with: a short white-noise burst, bandpass-
 * filtered at two formant frequencies derived from the phoneme's leading
 * vowel, shaped by a brief attack/decay envelope. The audio is voice-band
 * texture without being a recognisable word — what the receiver pareidolias
 * into is genuinely their own perception, not a parroted prompt.
 *
 * Determinism: the audit chain still gets the exact phoneme string from
 * `nextPhoneme()`. The synth is just the audible analog; the textual
 * receipt is what evidence rests on.
 */

const VOWEL_FORMANTS: Record<string, [number, number]> = {
  // First two formants in Hz — drawn from standard phonetics tables
  // (Peterson & Barney 1952, averaged adult-male values).
  a: [730, 1090],
  e: [530, 1840],
  i: [270, 2290],
  o: [570, 840],
  u: [300, 870],
  // Diphthong / cluster fall-backs
  ah: [730, 1090],
  oh: [570, 840],
  uh: [490, 1350],
  eh: [530, 1840],
  ee: [270, 2290],
  oo: [300, 870],
  ai: [660, 1700],
  ei: [530, 1840],
  ou: [490, 1100],
  ie: [400, 2000],
};

/**
 * Pick a formant pair for an arbitrary phoneme string. Strategy:
 *   1. Exact match against the diphthong table.
 *   2. First vowel in the string → vowel table.
 *   3. Fallback: neutral schwa-ish [500, 1500] (sounds like "uh").
 */
function pickFormants(phoneme: string): [number, number] {
  const lower = phoneme.toLowerCase();
  if (VOWEL_FORMANTS[lower]) return VOWEL_FORMANTS[lower];
  for (const ch of lower) {
    if (VOWEL_FORMANTS[ch]) return VOWEL_FORMANTS[ch];
  }
  return [500, 1500];
}

export class PhonemeSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  /**
   * Lazy-initialise the AudioContext. Must be called from a user gesture
   * (a button tap) to satisfy autoplay policy — the existing receiver UI
   * already enables the spirit-box via a checkbox tap, which counts.
   */
  ensure(): boolean {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return true;
    }
    try {
      const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.18; // overall headroom — receiver phone tends to be loud
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoiseBuffer(this.ctx, 0.4);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /** One short voice-band noise burst. Returns the duration so the UI
   *  can drive an amplitude indicator that stays in sync. */
  emit(phoneme: string, opts: { durationMs?: number; gain?: number } = {}): number {
    if (!this.ensure() || !this.ctx || !this.master || !this.noiseBuffer) return 0;
    const ctx = this.ctx;
    const dur = (opts.durationMs ?? 150) / 1000;
    const [f1, f2] = pickFormants(phoneme);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp1 = ctx.createBiquadFilter();
    bp1.type = "bandpass";
    bp1.frequency.value = f1;
    bp1.Q.value = 6;

    const bp2 = ctx.createBiquadFilter();
    bp2.type = "bandpass";
    bp2.frequency.value = f2;
    bp2.Q.value = 6;

    const env = ctx.createGain();
    const t0 = ctx.currentTime;
    const peak = (opts.gain ?? 1) * 0.8;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.015);          // 15ms attack
    env.gain.linearRampToValueAtTime(peak * 0.7, t0 + dur * 0.55);
    env.gain.linearRampToValueAtTime(0, t0 + dur);                // soft tail

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    src.connect(bp1).connect(mix);
    src.connect(bp2).connect(mix);
    mix.connect(env).connect(this.master);

    src.start(t0);
    src.stop(t0 + dur + 0.02);
    return dur * 1000;
  }

  /** Tear down the AudioContext — call when the receiver leaves the
   *  Estes view or toggles the spirit box off, to free hardware. */
  close(): void {
    try {
      this.ctx?.close();
    } catch { /* ignore */ }
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }

  /** ~400ms of stationary white noise, sample-rate independent. We loop
   *  it inside each burst so we don't allocate per-phoneme.  */
  private makeNoiseBuffer(ctx: AudioContext, durationSeconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * durationSeconds));
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
