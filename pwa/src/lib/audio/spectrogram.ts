/**
 * Spectrogram review (Step 8 — scaffold).
 *
 * **Status: scaffold.** Returns a Canvas-rendering function that plots a
 * mel-style spectrogram from PCM data using a hand-rolled FFT (Cooley-Tukey,
 * stdlib only). When the EVP recorder lands we pipe its WAV bytes through
 * here to produce voice-band-highlighted spectrograms for review.
 *
 * Bring-up checklist:
 *   - Implement Cooley-Tukey radix-2 FFT (<200 LOC). Hann window, 1024-point.
 *   - 50% overlap, 12.5 ms hop at 48 kHz → realtime-friendly.
 *   - Map magnitudes to log scale, color-ramp blue→yellow→red.
 *   - Overlay voice band (300–3400 Hz) and mains-hum lines (50/60 Hz).
 *   - Click-to-mark: pixel-x → time, pass to recordEvent for review marker.
 *
 * For now this exposes the type contract so consumers can be written
 * against it.
 */

export interface SpectrogramOptions {
  sampleRate: number;
  fftSize?: number;       // default 1024
  hopFraction?: number;   // default 0.5
  voiceBand?: [number, number]; // default [300, 3400]
  mainsHumHz?: number;    // default 50 in AU/EU, 60 in NA
}

export interface SpectrogramFrame {
  /** Time offset in seconds. */
  t: number;
  /** Magnitude bins, log-mapped 0..1. */
  bins: Float32Array;
}

/**
 * Compute spectrogram frames from PCM samples. NOT YET IMPLEMENTED.
 * See bring-up checklist above.
 */
export function computeSpectrogram(
  _samples: Float32Array,
  _options: SpectrogramOptions,
): SpectrogramFrame[] {
  throw new Error("spectrogram.computeSpectrogram() is a scaffold — Cooley-Tukey FFT lands in step 8 build.");
}

/**
 * Render frames onto a 2D Canvas context. NOT YET IMPLEMENTED.
 */
export function renderSpectrogram(
  _ctx: CanvasRenderingContext2D,
  _frames: SpectrogramFrame[],
  _options: SpectrogramOptions,
): void {
  throw new Error("spectrogram.renderSpectrogram() is a scaffold — paints in step 8 build.");
}
