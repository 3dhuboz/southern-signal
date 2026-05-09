/**
 * Sub-audible bait-tone generator. Drives a Web Audio oscillator at a
 * specified frequency through the phone's speaker, optionally sweeping
 * between two end-points to keep an entity (or a draft, or a HVAC
 * resonance) from "settling" into the steady tone.
 *
 * IMPORTANT honest framing:
 *   • Phone speakers are physically incapable of reproducing the
 *     air-pressure effects associated with infrasound exposure
 *     experiments (Tandy 19 Hz, NASA chair, etc.). Those experiments
 *     used multi-kilowatt subwoofers in sealed rooms.
 *   • This tool exposes the *carrier* frequency only. Treat the output
 *     as a marker / metronome, not as causally sufficient stimulation.
 *   • The audit chain logs every start/stop with the configured
 *     frequency and gain so the timeline shows exactly when the
 *     environment was being driven.
 */

export interface BaitToneOptions {
  frequencyHz: number;
  gain: number;          // 0..1
  sweepRangeHz?: number; // total sweep span; 0 = steady tone
  sweepPeriodSec?: number;
}

const HARD_GAIN_CAP = 0.35; // safety: don't drive cheap phone speakers to clipping

export class BaitToneEngine {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gainNode: GainNode | null = null;
  private opts: BaitToneOptions;
  private sweepTimer: number | null = null;
  private startedAt: number = 0;

  constructor(opts: BaitToneOptions) {
    this.opts = { ...opts };
  }

  isRunning(): boolean {
    return this.osc != null;
  }

  getOptions(): BaitToneOptions {
    return { ...this.opts };
  }

  setOptions(patch: Partial<BaitToneOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (this.osc) {
      const now = this.ctx?.currentTime ?? 0;
      this.osc.frequency.setTargetAtTime(this.opts.frequencyHz, now, 0.05);
    }
    if (this.gainNode && typeof patch.gain === "number") {
      const safeGain = Math.max(0, Math.min(HARD_GAIN_CAP, patch.gain));
      this.gainNode.gain.setTargetAtTime(safeGain, this.ctx?.currentTime ?? 0, 0.05);
    }
  }

  start(): void {
    if (this.osc) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = this.opts.frequencyHz;
    gain.gain.value = Math.max(0, Math.min(HARD_GAIN_CAP, this.opts.gain));
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    this.ctx = ctx;
    this.osc = osc;
    this.gainNode = gain;
    this.startedAt = Date.now();

    if ((this.opts.sweepRangeHz ?? 0) > 0 && (this.opts.sweepPeriodSec ?? 0) > 0) {
      const range = this.opts.sweepRangeHz!;
      const period = this.opts.sweepPeriodSec!;
      const center = this.opts.frequencyHz;
      this.sweepTimer = window.setInterval(() => {
        if (!this.osc || !this.ctx) return;
        const phase = ((Date.now() - this.startedAt) / 1000) % period;
        const ratio = (Math.sin((phase / period) * Math.PI * 2) + 1) / 2;
        const f = center - range / 2 + range * ratio;
        this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.1);
      }, 100);
    }
  }

  stop(): { durationMs: number } {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    if (this.sweepTimer != null) {
      window.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    try { this.osc?.stop(); } catch { /* ignore */ }
    this.osc?.disconnect();
    this.gainNode?.disconnect();
    this.osc = null;
    this.gainNode = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
    this.startedAt = 0;
    return { durationMs };
  }
}
