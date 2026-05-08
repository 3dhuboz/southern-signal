import { describe, expect, it } from "vitest";
import { applyHann, bandCrossSpectrum, fft, hannWindow, hzToBin, magnitudeSpectrum, spectrum } from "./fft";

describe("hannWindow", () => {
  it("starts and ends at zero", () => {
    const w = hannWindow(64);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[63]).toBeCloseTo(0, 6);
  });
  it("peaks near 1 in the middle", () => {
    const w = hannWindow(64);
    expect(w[32]).toBeGreaterThan(0.99);
  });
});

describe("fft on a known sinusoid", () => {
  it("produces a peak at the expected bin", () => {
    const N = 1024;
    const sampleRate = 48000;
    const targetHz = 1000;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      real[n] = Math.cos((2 * Math.PI * targetHz * n) / sampleRate);
    }
    fft(real, imag);
    const mag = magnitudeSpectrum(real, imag);
    let peakBin = 0;
    let peakMag = 0;
    for (let k = 0; k < mag.length; k++) {
      if (mag[k] > peakMag) { peakMag = mag[k]; peakBin = k; }
    }
    const expectedBin = hzToBin(targetHz, N, sampleRate);
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1);
  });

  it("Parseval's theorem: sum |x|^2 == sum |X|^2 / N (within tolerance)", () => {
    const N = 256;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 0; n < N; n++) real[n] = Math.sin((2 * Math.PI * 7 * n) / N);
    let timeSum = 0;
    for (let n = 0; n < N; n++) timeSum += real[n] * real[n];
    fft(real, imag);
    let freqSum = 0;
    for (let k = 0; k < N; k++) freqSum += real[k] * real[k] + imag[k] * imag[k];
    expect(freqSum / N).toBeCloseTo(timeSum, 4);
  });

  it("rejects non-power-of-2 sizes", () => {
    const real = new Float32Array(100);
    const imag = new Float32Array(100);
    expect(() => fft(real, imag)).toThrow();
  });
});

describe("spectrum helper", () => {
  it("returns same-length arrays", () => {
    const samples = new Float32Array(512);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10);
    const { real, imag } = spectrum(samples);
    expect(real.length).toBe(512);
    expect(imag.length).toBe(512);
  });
});

describe("bandCrossSpectrum", () => {
  it("yields real-positive cross when left == right", () => {
    const N = 64;
    const samples = new Float32Array(N);
    for (let n = 0; n < N; n++) samples[n] = Math.cos((2 * Math.PI * 4 * n) / N);
    const { real, imag } = spectrum(samples);
    // L === R: cross-spectrum = |X|^2 (real, positive).
    const cross = bandCrossSpectrum(real, imag, real, imag, 2, 6);
    expect(cross.imag).toBeCloseTo(0, 4);
    expect(cross.real).toBeGreaterThan(0);
    expect(cross.leftPower).toBeCloseTo(cross.rightPower, 6);
  });

  it("yields a phase consistent with a known time delay", () => {
    const N = 512;
    const sampleRate = 48000;
    const f = 1000; // 1 kHz tone
    const delayBins = 1; // L leads R by one sample
    const left = new Float32Array(N);
    const right = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      left[n] = Math.cos((2 * Math.PI * f * n) / sampleRate);
      right[n] = Math.cos((2 * Math.PI * f * (n - delayBins)) / sampleRate);
    }
    applyHann(left);
    applyHann(right);
    const lImag = new Float32Array(N);
    const rImag = new Float32Array(N);
    fft(left, lImag);
    fft(right, rImag);
    const targetBin = hzToBin(f, N, sampleRate);
    const c = bandCrossSpectrum(left, lImag, right, rImag, targetBin - 1, targetBin + 1);
    // Phase should map to delay = -phase / (2π f) ≈ +1 sample => ≈ 21 µs at 48 kHz.
    const phase = Math.atan2(c.imag, c.real);
    const delaySec = -phase / (2 * Math.PI * f);
    const expectedSec = delayBins / sampleRate;
    expect(Math.abs(delaySec - expectedSec)).toBeLessThan(2 / sampleRate);
  });
});

describe("magnitudeSpectrum", () => {
  it("returns N/2 + 1 bins", () => {
    const real = new Float32Array(128);
    const imag = new Float32Array(128);
    expect(magnitudeSpectrum(real, imag).length).toBe(65);
  });
});
