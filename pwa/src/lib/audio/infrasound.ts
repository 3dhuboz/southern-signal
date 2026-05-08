/**
 * Infrasound detector — recovers sub-codec low-frequency content from the
 * AGC envelope of the audio stream.
 *
 * Theory: phone mic codecs high-pass everything below ~80 Hz. But the AGC
 * gain envelope tracks slow pressure changes that can be reconstructed
 * from the RMS envelope of the captured audio. We resample the per-frame
 * RMS to ~100 Hz, bandpass-filter in 0.5–18 Hz, and look for sustained
 * narrowband peaks 7–19 Hz (the "Tandy/NASA fear-frequency" band).
 *
 * Honest framing: this is RELATIVE dB, never absolute SPL. Phone mics are
 * uncalibrated below their spec floor.
 */

import { fft, hannWindow } from "./fft";

const ENVELOPE_RATE_HZ = 100;

/** A simple second-order Butterworth bandpass biquad cascade. */
class BiquadBandpass {
  private z1 = 0;
  private z2 = 0;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  /** Direct-form II transposed. */
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  static designBandpass(centerHz: number, bandwidthHz: number, sampleRate: number): BiquadBandpass {
    // RBJ Audio EQ Cookbook bandpass (constant 0 dB peak gain)
    const w0 = (2 * Math.PI * centerHz) / sampleRate;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const Q = centerHz / bandwidthHz;
    const alpha = sinw0 / (2 * Q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const b1 = 0;
    const b2 = -alpha / a0;
    const a1 = (-2 * cosw0) / a0;
    const a2 = (1 - alpha) / a0;
    return new BiquadBandpass(b0, b1, b2, a1, a2);
  }
}

export interface InfrasoundDetection {
  ts: number;
  peakHz: number;
  durationSeconds: number;
  envelopeDb: number;
  baselineEnvelopeDb: number;
}

export class InfrasoundDetector {
  private envelopeBuffer: Float32Array;
  private writeIdx = 0;
  private envelopeFilled = false;
  private bandpass: BiquadBandpass;
  private samplesSinceFft = 0;
  private baselineDb = -90;
  private baselineFilled = false;
  private peakTrackerHz = 0;
  private peakStartMs: number | null = null;
  private lastFireMs = 0;

  /** Window length in envelope samples — 4 s at 100 Hz = 400 samples. */
  private readonly fftSize = 512; // power of 2 ≥ 400

  /** Frames to accumulate before re-running the FFT (every 200 ms ~ 20 envelope samples). */
  private readonly fftStrideEnvelope = 20;

  constructor() {
    // 8th-order is overkill — single bandpass centred at 9 Hz / 17 Hz BW (covers 0.5–18 Hz).
    this.bandpass = BiquadBandpass.designBandpass(9, 17, ENVELOPE_RATE_HZ);
    this.envelopeBuffer = new Float32Array(this.fftSize);
  }

  /**
   * Push an audio-frame RMS sample. Returns an InfrasoundDetection if a
   * sustained peak in 7–19 Hz exceeds +6 dB above baseline for ≥10 s, else null.
   */
  pushFrameRms(rms: number, frameTsMs: number): InfrasoundDetection | null {
    // Convert RMS → dB. -90 dB floor for silent frames so we don't blow up log.
    const db = 20 * Math.log10(Math.max(1e-6, rms));
    const filtered = this.bandpass.process(db);
    this.envelopeBuffer[this.writeIdx] = filtered;
    this.writeIdx = (this.writeIdx + 1) % this.fftSize;
    if (this.writeIdx === 0) this.envelopeFilled = true;

    // Update baseline (slow EWMA).
    const baselineAlpha = 1 / (ENVELOPE_RATE_HZ * 30); // ~30 s window
    this.baselineDb = (1 - baselineAlpha) * this.baselineDb + baselineAlpha * db;
    if (!this.baselineFilled && this.writeIdx > ENVELOPE_RATE_HZ * 5) this.baselineFilled = true;

    this.samplesSinceFft += 1;
    if (this.samplesSinceFft < this.fftStrideEnvelope) return null;
    this.samplesSinceFft = 0;
    if (!this.envelopeFilled) return null;

    // Spectral analysis on the envelope.
    const buf = this.linearizeBuffer();
    const window = hannWindow(this.fftSize);
    const real = new Float32Array(this.fftSize);
    const imag = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) real[i] = buf[i] * window[i];
    fft(real, imag);

    // Find peak in 7–19 Hz band.
    const binLo = Math.round((7 * this.fftSize) / ENVELOPE_RATE_HZ);
    const binHi = Math.round((19 * this.fftSize) / ENVELOPE_RATE_HZ);
    let peakBin = binLo;
    let peakMag2 = 0;
    let totalMag2 = 0;
    for (let k = binLo; k <= binHi; k++) {
      const m2 = real[k] * real[k] + imag[k] * imag[k];
      totalMag2 += m2;
      if (m2 > peakMag2) {
        peakMag2 = m2;
        peakBin = k;
      }
    }
    const peakHz = (peakBin * ENVELOPE_RATE_HZ) / this.fftSize;
    const peakDb = 10 * Math.log10(Math.max(1e-12, peakMag2));
    const totalDb = 10 * Math.log10(Math.max(1e-12, totalMag2));
    void totalDb;
    const aboveBaseline = peakDb - this.baselineDb * 2; // crude — peak is in dB-of-dB scale, not absolute SPL

    // Sustained-peak tracking.
    const minDelta = 6;
    if (aboveBaseline >= minDelta && peakHz >= 7 && peakHz <= 19) {
      if (this.peakStartMs == null) {
        this.peakStartMs = frameTsMs;
        this.peakTrackerHz = peakHz;
      } else if (Math.abs(peakHz - this.peakTrackerHz) > 4) {
        // Peak migrated — reset.
        this.peakStartMs = frameTsMs;
        this.peakTrackerHz = peakHz;
      }
      const heldSeconds = (frameTsMs - this.peakStartMs) / 1000;
      // Fire once per 30s when peak has held ≥10s and we haven't recently fired.
      if (heldSeconds >= 10 && frameTsMs - this.lastFireMs > 30_000) {
        this.lastFireMs = frameTsMs;
        return {
          ts: frameTsMs,
          peakHz,
          durationSeconds: heldSeconds,
          envelopeDb: peakDb,
          baselineEnvelopeDb: this.baselineDb * 2,
        };
      }
    } else {
      this.peakStartMs = null;
    }
    return null;
  }

  private linearizeBuffer(): Float32Array {
    if (!this.envelopeFilled) return this.envelopeBuffer;
    const out = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      out[i] = this.envelopeBuffer[(this.writeIdx + i) % this.fftSize];
    }
    return out;
  }
}
