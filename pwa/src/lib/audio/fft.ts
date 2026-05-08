/**
 * Hand-rolled radix-2 Cooley-Tukey FFT.
 *
 * Pure stdlib, no deps. Operates on Float32Array real + imag pairs in
 * place. Supports power-of-two sizes from 32 to 16384.
 *
 * Performance: ~2-4 ms per 1024-point FFT on iPhone 14 — acceptable for
 * 50% overlap @ 16 kHz mono (~32 frames/s). For stereo we run twice.
 *
 * Used by sector indicator (per-band cross-spectrum), spectrogram, and
 * the infrasound envelope analyzer.
 */

const BIT_REV_CACHE = new Map<number, Uint16Array>();

function bitReverseTable(n: number): Uint16Array {
  const cached = BIT_REV_CACHE.get(n);
  if (cached) return cached;
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) throw new Error(`FFT size ${n} is not a power of 2`);
  const table = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    let x = i;
    for (let j = 0; j < bits; j++) {
      rev = (rev << 1) | (x & 1);
      x >>>= 1;
    }
    table[i] = rev;
  }
  BIT_REV_CACHE.set(n, table);
  return table;
}

/**
 * Compute the Hann window of length `n`, cached. Window is symmetric
 * (matches scipy default and the matplotlib spectrogram convention).
 */
const HANN_CACHE = new Map<number, Float32Array>();
export function hannWindow(n: number): Float32Array {
  const cached = HANN_CACHE.get(n);
  if (cached) return cached;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  HANN_CACHE.set(n, w);
  return w;
}

/**
 * Multiply each sample by the Hann window in place.
 */
export function applyHann(samples: Float32Array): void {
  const w = hannWindow(samples.length);
  for (let i = 0; i < samples.length; i++) samples[i] *= w[i];
}

/**
 * In-place radix-2 FFT. real/imag must have the same power-of-two length.
 * Forward transform: X[k] = sum x[n] e^(-i 2π k n / N).
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n !== imag.length) throw new Error("FFT real/imag length mismatch");
  const rev = bitReverseTable(n);
  // Bit-reversal permutation
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
  }
  // Cooley-Tukey butterflies
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let off = 0; off < n; off += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const i1 = off + k;
        const i2 = i1 + half;
        const tr = wr * real[i2] - wi * imag[i2];
        const ti = wr * imag[i2] + wi * real[i2];
        real[i2] = real[i1] - tr;
        imag[i2] = imag[i1] - ti;
        real[i1] += tr;
        imag[i1] += ti;
      }
    }
  }
}

/**
 * One-shot helper: take real samples, apply Hann window, run forward FFT.
 * Returns separate real / imag Float32Arrays of length n.
 */
export function spectrum(samples: Float32Array): { real: Float32Array; imag: Float32Array } {
  const n = samples.length;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) real[i] = samples[i];
  applyHann(real);
  fft(real, imag);
  return { real, imag };
}

/**
 * Compute the per-band averages of cross-spectrum magnitude AND the
 * cross-spectrum (left × conj(right)) over an integer band range
 * [binLo, binHi].
 *
 * Returns:
 *   crossReal, crossImag — sum of L[k] * conj(R[k]) over k ∈ [binLo, binHi]
 *   leftPower            — sum of |L[k]|² over the same range
 *   rightPower           — sum of |R[k]|² over the same range
 */
export function bandCrossSpectrum(
  leftReal: Float32Array,
  leftImag: Float32Array,
  rightReal: Float32Array,
  rightImag: Float32Array,
  binLo: number,
  binHi: number,
): { real: number; imag: number; leftPower: number; rightPower: number } {
  let crossReal = 0;
  let crossImag = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let k = binLo; k <= binHi; k++) {
    const lr = leftReal[k], li = leftImag[k];
    const rr = rightReal[k], ri = rightImag[k];
    // L * conj(R) = (lr + i li) * (rr - i ri) = (lr*rr + li*ri) + i (li*rr - lr*ri)
    crossReal += lr * rr + li * ri;
    crossImag += li * rr - lr * ri;
    leftPower += lr * lr + li * li;
    rightPower += rr * rr + ri * ri;
  }
  return { real: crossReal, imag: crossImag, leftPower, rightPower };
}

/**
 * Convert a Hz frequency to nearest FFT bin given fftSize and sampleRate.
 */
export function hzToBin(hz: number, fftSize: number, sampleRate: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}

/**
 * Compute the magnitude spectrum |X[k]| for k = 0..n/2 (Nyquist).
 */
export function magnitudeSpectrum(real: Float32Array, imag: Float32Array): Float32Array {
  const half = real.length >> 1;
  const out = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    out[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
  }
  return out;
}
