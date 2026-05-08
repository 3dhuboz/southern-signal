/**
 * Live audio analyzer — orchestrates stereo capture → FFT → cross-spectrum →
 * sector inference + envelope-based transient detection.
 *
 * Wired into the AudioWorklet defined in /public/sector-worklet.js. The
 * worklet streams 1024-sample stereo frames with 50% overlap; this module
 * runs the FFT, derives per-band MSC + ITD via processFrame, and emits
 * SectorReading + envelope spikes to subscribers.
 *
 * Privacy: all processing is on-device. No audio leaves the device.
 */

import { ASI_CONSTANTS, aggregateSector, processFrame, type SectorReading } from "./sectorIndicator";
import { applyHann, bandCrossSpectrum, fft, hzToBin } from "./fft";
import { InfrasoundDetector, type InfrasoundDetection } from "./infrasound";

const PHONE_MIC_SPACING_MM = 146; // iPhone 14 default; Pixel 8 ~10 mm — caller can override.

export interface LiveAnalyzerOptions {
  /** Mic spacing in mm (defaults to 146 for iPhone 14). */
  micSpacingMm?: number;
  /** RMS threshold (0..1) above which a transient is reported as a candidate event. */
  transientThreshold?: number;
}

export interface AnalyzerEvents {
  onSectorReading: (reading: SectorReading) => void;
  /** Fires when a stereo RMS transient exceeds threshold and a SectorReading exists. */
  onAcousticTransient: (reading: SectorReading, rms: number, frameTs: number) => void;
  /** Fires every frame with rolling RMS for the EvidenceLedger. */
  onLevel: (rms: number) => void;
  /** Fires when the AGC-envelope infrasound detector finds a sustained 7-19 Hz peak. */
  onInfrasound: (detection: InfrasoundDetection) => void;
  /** Surface fatal errors (worklet load, getUserMedia, etc.) */
  onError: (err: Error) => void;
}

interface AnalyzerInternals {
  audioCtx: AudioContext;
  workletNode: AudioWorkletNode;
  mediaStream: MediaStream;
  source: MediaStreamAudioSourceNode;
}

export class LiveAnalyzer {
  private options: Required<LiveAnalyzerOptions>;
  private events: AnalyzerEvents;
  private internals: AnalyzerInternals | null = null;
  private rollingRms = 0;
  private rmsAlpha = 0.05; // ~ first-order smoother
  private infrasound: InfrasoundDetector;

  constructor(events: AnalyzerEvents, options: LiveAnalyzerOptions = {}) {
    this.events = events;
    this.options = {
      micSpacingMm: options.micSpacingMm ?? PHONE_MIC_SPACING_MM,
      transientThreshold: options.transientThreshold ?? 0.18,
    };
    this.infrasound = new InfrasoundDetector();
  }

  async start(): Promise<void> {
    if (this.internals) return;
    let mediaStream: MediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
        },
        video: false,
      });
    } catch (err) {
      this.events.onError(err as Error);
      throw err;
    }
    const audioCtx = new AudioContext({ sampleRate: 48000 });
    try {
      await audioCtx.audioWorklet.addModule("/sector-worklet.js");
    } catch (err) {
      this.events.onError(err as Error);
      throw err;
    }
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioCtx, "sector-worklet", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: "explicit",
    });
    workletNode.port.onmessage = (event) => this.handleFrame(event.data);
    source.connect(workletNode);

    this.internals = { audioCtx, workletNode, mediaStream, source };
  }

  async stop(): Promise<void> {
    if (!this.internals) return;
    const { audioCtx, mediaStream, source, workletNode } = this.internals;
    try { source.disconnect(); } catch { /* ignore */ }
    try { workletNode.disconnect(); } catch { /* ignore */ }
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { await audioCtx.close(); } catch { /* ignore */ }
    this.internals = null;
  }

  private handleFrame(data: { left: Float32Array; right: Float32Array; sampleRate: number; frameTs: number }) {
    const { left, right, sampleRate, frameTs } = data;
    // Compute RMS over both channels (level meter for the EvidenceLedger).
    let sumSq = 0;
    for (let i = 0; i < left.length; i++) {
      const l = left[i], r = right[i];
      sumSq += (l * l + r * r) * 0.5;
    }
    const rms = Math.sqrt(sumSq / left.length);
    this.rollingRms = this.rollingRms + this.rmsAlpha * (rms - this.rollingRms);
    this.events.onLevel(rms);

    // Infrasound detector (AGC envelope reconstruction).
    const detection = this.infrasound.pushFrameRms(rms, frameTs);
    if (detection) this.events.onInfrasound(detection);

    // Run FFT on both channels.
    const lImag = new Float32Array(left.length);
    const rImag = new Float32Array(right.length);
    // Apply Hann (in place) and FFT.
    const lReal = new Float32Array(left);
    const rReal = new Float32Array(right);
    applyHann(lReal);
    applyHann(rReal);
    fft(lReal, lImag);
    fft(rReal, rImag);

    // Per-band cross-spectrum.
    const perBandCross = ASI_CONSTANTS.DEFAULT_BANDS.map((b) => {
      const binLo = hzToBin(b.low, left.length, sampleRate);
      const binHi = hzToBin(b.high, left.length, sampleRate);
      return bandCrossSpectrum(lReal, lImag, rReal, rImag, binLo, binHi);
    });

    const frame = processFrame({
      perBandCross: perBandCross.map((b) => ({ real: b.real, imag: b.imag })),
      perBandLeftPower: perBandCross.map((b) => b.leftPower),
      perBandRightPower: perBandCross.map((b) => b.rightPower),
      sampleRate,
    });

    const reading = aggregateSector({
      frame,
      micSpacingMm: this.options.micSpacingMm,
      frontProbability: 0.5,
    });
    this.events.onSectorReading(reading);

    // Transient detection: rolling RMS exceeds floor by configured threshold.
    if (rms - this.rollingRms > this.options.transientThreshold && reading.trustworthy) {
      this.events.onAcousticTransient(reading, rms, frameTs);
    }
  }
}
