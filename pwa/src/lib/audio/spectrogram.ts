/**
 * Spectrogram computation and rendering.
 *
 * Uses the hand-rolled Cooley-Tukey FFT from fft.ts — pure stdlib, no deps.
 * 50% overlap Hann-windowed short-time Fourier transform → power spectrum in
 * dBFS → linear 0..1 normalization → hot-palette canvas rendering.
 *
 * Voice band (300–3400 Hz) and mains hum lines are overlaid after the
 * spectrogram pixels are painted, so they are always readable regardless
 * of the underlying signal level.
 */

import { spectrum, magnitudeSpectrum } from "./fft";

export interface SpectrogramOptions {
  sampleRate: number;
  fftSize?: number;       // default 1024
  hopFraction?: number;   // default 0.5 — 50% overlap
  voiceBand?: [number, number]; // default [300, 3400]
  mainsHumHz?: number;    // default 50
}

export interface SpectrogramFrame {
  /** Time offset in seconds from the start of the input samples. */
  t: number;
  /** Per-bin power normalized 0..1 (0 = -90 dBFS, 1 = 0 dBFS). */
  bins: Float32Array;
}

// dBFS floor/ceiling for the 0..1 normalization
const DB_MIN = -90;
const DB_MAX = 0;
const DB_RANGE = DB_MAX - DB_MIN; // 90

/**
 * Compute spectrogram frames from mono Float32 PCM samples.
 *
 * For each hop the function:
 *   1. Slices `fftSize` samples (zero-padded at the end if needed).
 *   2. Applies a Hann window (via `spectrum()` which calls `applyHann` then
 *      the radix-2 FFT).
 *   3. Computes power spectrum in dBFS: 20·log10(|X[k]| / (fftSize/2)).
 *   4. Clamps to [DB_MIN, DB_MAX] and normalizes to 0..1.
 *
 * Returns one `SpectrogramFrame` per hop (N/2 + 1 bins, DC through Nyquist).
 */
export function computeSpectrogram(
  samples: Float32Array,
  options: SpectrogramOptions,
): SpectrogramFrame[] {
  const {
    sampleRate,
    fftSize = 1024,
    hopFraction = 0.5,
  } = options;

  if (samples.length === 0) return [];

  const hopSize = Math.max(1, Math.round(fftSize * hopFraction));
  const numBins = (fftSize >> 1) + 1; // DC through Nyquist inclusive
  const refLevel = fftSize / 2; // normalisation reference for 0 dBFS

  const frames: SpectrogramFrame[] = [];
  const window = new Float32Array(fftSize);

  let offset = 0;
  while (offset < samples.length) {
    // Fill window buffer, zero-pad if we're near the end.
    for (let i = 0; i < fftSize; i++) {
      const si = offset + i;
      window[i] = si < samples.length ? samples[si] : 0;
    }

    // Hann window + FFT via the one-shot helper in fft.ts.
    const { real, imag } = spectrum(window);

    // Magnitude spectrum: |X[k]| for k = 0..N/2.
    const mag = magnitudeSpectrum(real, imag);

    // Convert to normalized 0..1 power.
    const bins = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const m = mag[k];
      // dBFS: 0 dBFS when magnitude == refLevel (full-scale sine).
      const dBFS = m > 0 ? 20 * Math.log10(m / refLevel) : DB_MIN;
      bins[k] = Math.max(0, Math.min(1, (dBFS - DB_MIN) / DB_RANGE));
    }

    frames.push({ t: offset / sampleRate, bins });
    offset += hopSize;
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Color ramp: navy → cyan → yellow → red  ("hot" spectrogram palette)
// Each stop is [r, g, b] at value 0..1.
// ---------------------------------------------------------------------------
const RAMP: Array<{ v: number; r: number; g: number; b: number }> = [
  { v: 0.00, r: 0,   g: 0,   b: 80  }, // deep navy
  { v: 0.20, r: 0,   g: 60,  b: 160 }, // blue
  { v: 0.40, r: 0,   g: 180, b: 200 }, // cyan
  { v: 0.60, r: 80,  g: 220, b: 80  }, // green-yellow
  { v: 0.75, r: 255, g: 220, b: 0   }, // yellow
  { v: 0.88, r: 255, g: 100, b: 0   }, // orange
  { v: 1.00, r: 255, g: 0,   b: 0   }, // red
];

function hotRgb(value: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, value));
  for (let i = 1; i < RAMP.length; i++) {
    const lo = RAMP[i - 1];
    const hi = RAMP[i];
    if (v <= hi.v) {
      const t = (v - lo.v) / (hi.v - lo.v);
      return [
        Math.round(lo.r + t * (hi.r - lo.r)),
        Math.round(lo.g + t * (hi.g - lo.g)),
        Math.round(lo.b + t * (hi.b - lo.b)),
      ];
    }
  }
  return [255, 0, 0];
}

/**
 * Render spectrogram frames onto a 2D canvas context.
 *
 * X axis: time (left → right).
 * Y axis: frequency (bottom = 0 Hz, top = Nyquist).
 *
 * After drawing the heat-map pixels the function overlays:
 *   - Voice band fill + dashed border lines + "VOICE" label.
 *   - Mains hum lines at fundamental and 2nd/3rd harmonics.
 *   - Time tick marks every 1 s at the bottom.
 *   - Frequency labels every 1 kHz on the left.
 */
export function renderSpectrogram(
  ctx: CanvasRenderingContext2D,
  frames: SpectrogramFrame[],
  options: SpectrogramOptions,
): void {
  const {
    sampleRate,
    fftSize = 1024,
    voiceBand = [300, 3400],
    mainsHumHz = 50,
  } = options;

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (!frames.length || W === 0 || H === 0) return;

  ctx.clearRect(0, 0, W, H);

  const numBins = (fftSize >> 1) + 1; // matches computeSpectrogram
  const nyquist = sampleRate / 2;
  const totalDuration = frames.length > 1
    ? frames[frames.length - 1].t + (frames[1].t - frames[0].t)
    : frames[0].t + 0.001;

  // --- Paint heat-map columns -------------------------------------------
  const colW = Math.max(1, W / frames.length);
  const imageData = ctx.createImageData(W, H);
  const d = imageData.data;

  for (let fi = 0; fi < frames.length; fi++) {
    const { bins } = frames[fi];
    const x0 = Math.floor(fi * colW);
    const x1 = Math.floor((fi + 1) * colW);

    for (let k = 0; k < numBins; k++) {
      // Map bin k to canvas row: bin 0 (DC) → bottom, bin numBins-1 (Nyquist) → top.
      const rowTop    = Math.floor(H - ((k + 1) / numBins) * H);
      const rowBottom = Math.floor(H - (k / numBins) * H);

      const [r, g, b] = hotRgb(bins[k]);

      for (let row = rowTop; row < rowBottom; row++) {
        for (let col = x0; col < x1; col++) {
          const idx = (row * W + col) * 4;
          d[idx]     = r;
          d[idx + 1] = g;
          d[idx + 2] = b;
          d[idx + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Helper: convert Hz to canvas Y (bottom = 0 Hz).
  const hzToY = (hz: number) => H - (hz / nyquist) * H;

  // --- Voice band overlay -----------------------------------------------
  const vbLoY = hzToY(voiceBand[0]);
  const vbHiY = hzToY(voiceBand[1]);
  const vbH   = vbLoY - vbHiY; // positive because Y is inverted

  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
  ctx.fillRect(0, vbHiY, W, vbH);

  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.beginPath();
  ctx.moveTo(0, vbHiY); ctx.lineTo(W, vbHiY); // upper edge (3400 Hz)
  ctx.moveTo(0, vbLoY); ctx.lineTo(W, vbLoY); // lower edge (300 Hz)
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = "bold 9px monospace";
  ctx.textBaseline = "middle";
  ctx.fillText("VOICE", 4, vbHiY + vbH / 2);
  ctx.restore();

  // --- Mains hum lines (fundamental + 2nd + 3rd harmonic) ---------------
  const humLabel = `${mainsHumHz}Hz`;
  const humHarmonics = [1, 2, 3];
  for (const mult of humHarmonics) {
    const hz = mainsHumHz * mult;
    if (hz >= nyquist) continue;
    const y = hzToY(hz);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 60, 60, ${mult === 1 ? 0.9 : 0.5})`;
    ctx.lineWidth = mult === 1 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
    if (mult === 1) {
      ctx.fillStyle = "rgba(255, 80, 80, 0.9)";
      ctx.font = "bold 9px monospace";
      ctx.textBaseline = "bottom";
      ctx.fillText(humLabel, 4, y - 1);
    }
    ctx.restore();
  }

  // --- Time tick marks every 1 s -----------------------------------------
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.font = "9px monospace";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "center";

  const firstTick = 1; // start at 1 s so the 0 s label doesn't clip
  for (let t = firstTick; t < totalDuration; t++) {
    const x = (t / totalDuration) * W;
    ctx.beginPath();
    ctx.moveTo(x, H - 16);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillText(`${t}s`, x, H - 1);
  }
  ctx.restore();

  // --- Frequency labels every 1 kHz on the left -------------------------
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = "9px monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const kHzStep = 1000;
  const maxKHz = Math.floor(nyquist / kHzStep);
  for (let k = 1; k <= maxKHz; k++) {
    const hz = k * kHzStep;
    if (hz >= nyquist) break;
    const y = hzToY(hz);
    ctx.fillText(`${k}k`, 4, y);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Noise floor estimation
// ---------------------------------------------------------------------------

/**
 * Compute p50 and p95 noise floor (in dBFS) from the first
 * `baselineDurationS` seconds of samples.
 *
 * Method: RMS is computed in non-overlapping 256-sample blocks, converted to
 * dBFS (20·log10(rms)), sorted ascending, and the 50th / 95th percentile
 * values are returned.
 *
 * Returns `null` when there are not enough samples for at least 2 blocks.
 */
export function computeNoiseFloor(
  samples: Float32Array,
  sampleRate: number,
  baselineDurationS = 10,
): { p50dBFS: number; p95dBFS: number } | null {
  const BLOCK = 256;
  const maxSamples = Math.floor(baselineDurationS * sampleRate);
  const len = Math.min(samples.length, maxSamples);

  if (len < BLOCK * 2) return null;

  const dBValues: number[] = [];

  for (let i = 0; i + BLOCK <= len; i += BLOCK) {
    let sumSq = 0;
    for (let j = i; j < i + BLOCK; j++) {
      sumSq += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sumSq / BLOCK);
    const dBFS = rms > 0 ? 20 * Math.log10(rms) : -160;
    dBValues.push(dBFS);
  }

  dBValues.sort((a, b) => a - b);

  const n = dBValues.length;
  const p50 = dBValues[Math.floor(n * 0.50)];
  const p95 = dBValues[Math.min(n - 1, Math.floor(n * 0.95))];

  return { p50dBFS: p50, p95dBFS: p95 };
}
