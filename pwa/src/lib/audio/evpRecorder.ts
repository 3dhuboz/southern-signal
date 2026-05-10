/**
 * EVP recorder.
 *
 * **Status: working capture; on-device transcription pending.**
 *
 * What works today:
 *   - getUserMedia → AudioContext → AudioWorkletNode (with ScriptProcessor
 *     fallback) streams mono Float32 frames into `this.chunks`.
 *   - stop() concatenates, encodes a self-describing 16-bit WAV at the
 *     actual context rate (44.1 kHz on iOS, 48 kHz elsewhere), and writes
 *     it to OPFS via writeBytes().
 *   - Cloud transcription path (cloudTranscribe.ts → /api/ai/transcribe)
 *     accepts that WAV at its native rate — Whisper resamples internally.
 *     Gated by the cultural-sensitivity flag (per-case OR device-wide).
 *
 * What's pending — on-device Whisper.cpp WASM (so transcription works
 * offline / on culturally-sensitive sites):
 *   1. [DONE] Resample-to-16kHz utility — `downsampleFloat32` in wav.ts.
 *      Whisper.cpp expects 16 kHz mono; the pipeline is
 *      `downsampleFloat32(merged, this.sampleRate, 16000)` → feed to the
 *      Whisper worker (Whisper holds Float32 internally; no Int16 step
 *      needed for the WASM build, though `float32ToInt16` stays exported).
 *   2. Fetch + cache the Whisper model via `modelCache.ts` (URL + sha256
 *      once a stable hosting decision lands — ggml.ai mirrors aren't
 *      stable; consider self-hosting whisper-base.en-q5 ~57 MB on R2).
 *   3. Decide whisper.cpp WASM (smaller, CPU) vs whisper-onnx via
 *      Transformers.js (bigger, WebGPU). Lean whisper.cpp for the phone-
 *      first target — WebGPU support on mobile Safari is still spotty.
 *   4. Add Silero VAD WASM (~2 MB) to gate speech regions before
 *      transcription so we don't burn CPU on silence.
 *   5. Worker thread for the model run (main thread can't block on a
 *      multi-second transcription). Post Float32 windows in, get
 *      segment text + timestamps back.
 *   6. Persist transcripts to the `transcripts` SQLite table linked to
 *      the parent media_asset row, with file-offset refs for click-to-play.
 *   7. Wire Class A/B/C reviewer classification UI per Panel 3 #5.
 *
 * Privacy default: NEVER send audio to cloud unless the case is NOT
 * flagged `culturallySensitive` and the device-wide flag is off. The
 * router in cloudAi.ts / cloudTranscribe.ts enforces this; the on-device
 * Whisper path (when shipped) needs no such gate — it never leaves.
 */

import { encodeWavFromFloat32 } from "../wav";
import { writeBytes } from "../opfs";

export interface EvpRecorderState {
  status: "idle" | "starting" | "recording" | "stopping" | "error";
  startedAt: number | null;
  durationSeconds: number;
  error: string | null;
}

export type EvpRecorderListener = (state: EvpRecorderState) => void;

export class EvpRecorder {
  private state: EvpRecorderState = { status: "idle", startedAt: null, durationSeconds: 0, error: null };
  private listeners = new Set<EvpRecorderListener>();
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48000;
  private timerHandle: number | null = null;
  private outputPath: string | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private processingPath: "worklet" | "script-processor" | null = null;

  subscribe(listener: EvpRecorderListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private update(patch: Partial<EvpRecorderState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * Tear down any audio resources currently held WITHOUT touching public
   * state. Used by both stop() (after a successful capture) and the start()
   * error path (so a failed start doesn't leak mic tracks or AudioContexts
   * into the next attempt). Idempotent — safe to call when nothing is
   * allocated.
   */
  private tearDownAudio(): void {
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; } catch { /* swallow */ }
      try { this.workletNode.disconnect(); } catch { /* swallow */ }
    }
    if (this.scriptProcessor) {
      try { this.scriptProcessor.onaudioprocess = null; } catch { /* swallow */ }
      try { this.scriptProcessor.disconnect(); } catch { /* swallow */ }
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* swallow */ }
    }
    this.mediaStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* swallow */ } });
    this.audioCtx?.close().catch(() => { /* swallow */ });

    this.workletNode = null;
    this.scriptProcessor = null;
    this.sourceNode = null;
    this.mediaStream = null;
    this.audioCtx = null;
    this.processingPath = null;
  }

  async start(opfsPath: string): Promise<void> {
    if (this.state.status !== "idle") return;
    this.update({ status: "starting", error: null });
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
        },
        video: false,
      });
      this.audioCtx = new AudioContext({ sampleRate: 48000 });
      this.sampleRate = this.audioCtx.sampleRate;
      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.sourceNode = source;

      // Feature-detect AudioWorklet (Safari 14.5+, Chrome 66+, Firefox 76+)
      // and fall back to the deprecated ScriptProcessorNode on older browsers
      // or if module loading fails (e.g. PWA offline cache miss).
      let useWorklet = false;
      if (this.audioCtx.audioWorklet && typeof this.audioCtx.audioWorklet.addModule === "function") {
        try {
          await this.audioCtx.audioWorklet.addModule("/audio-worklet-recorder.js");
          useWorklet = true;
        } catch {
          useWorklet = false;
        }
      }

      if (useWorklet) {
        const node = new AudioWorkletNode(this.audioCtx, "audio-worklet-recorder");
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          // Buffer was transferred from the worklet — already a fresh copy.
          if (event.data instanceof Float32Array) {
            this.chunks.push(event.data);
          }
        };
        source.connect(node);
        // Connecting to destination keeps the graph alive in some browsers;
        // the processor never writes to outputs[0], so output is silent.
        node.connect(this.audioCtx.destination);
        this.workletNode = node;
        this.processingPath = "worklet";
      } else {
        const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          const channel = event.inputBuffer.getChannelData(0);
          // Copy because the underlying buffer is reused.
          this.chunks.push(new Float32Array(channel));
        };
        source.connect(processor);
        processor.connect(this.audioCtx.destination);
        this.scriptProcessor = processor;
        this.processingPath = "script-processor";
      }

      this.outputPath = opfsPath;
      // Reference processingPath here so TS doesn't warn about an unused
      // private field — the value is genuinely useful when debugging which
      // pipeline ran (worklet vs script-processor) but we keep it internal.
      void this.processingPath;

      // iOS Safari quirk: AudioContext created in `suspended` state even
      // when getUserMedia provided a gesture chain, especially when the
      // recorder is invoked from an awaited handler several layers deep.
      // An explicit resume() is harmless on contexts that already started
      // and prevents silent zero-byte captures on iOS. Failure here isn't
      // fatal — capture may still work; the user gesture has been granted.
      if (this.audioCtx.state === "suspended") {
        try { await this.audioCtx.resume(); } catch { /* swallow */ }
      }

      this.update({ status: "recording", startedAt: Date.now(), durationSeconds: 0 });
      this.timerHandle = window.setInterval(() => {
        if (this.state.startedAt) {
          this.update({ durationSeconds: (Date.now() - this.state.startedAt) / 1000 });
        }
      }, 1000);
    } catch (err) {
      // Release any partially-allocated audio resources so a retry doesn't
      // accumulate orphaned mic tracks / AudioContexts on the device.
      this.tearDownAudio();
      this.outputPath = null;
      this.update({ status: "error", error: (err as Error).message });
      throw err;
    }
  }

  async stop(): Promise<{ path: string; sizeBytes: number; sampleRate: number; durationSeconds: number } | null> {
    if (this.state.status !== "recording") return null;
    this.update({ status: "stopping" });
    if (this.timerHandle != null) { window.clearInterval(this.timerHandle); this.timerHandle = null; }

    // Snapshot the WAV-relevant state BEFORE teardown nullifies it.
    const sampleRate = this.sampleRate;
    const path = this.outputPath ?? "cases/_unfiled/recording.wav";
    const durationSeconds = this.state.durationSeconds;

    this.tearDownAudio();

    // Concatenate all Float32 chunks.
    const totalSamples = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalSamples);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }

    const wav = encodeWavFromFloat32(merged, sampleRate, 1);
    await writeBytes(path, wav);

    const result = {
      path,
      sizeBytes: wav.byteLength,
      sampleRate,
      durationSeconds,
    };

    this.chunks = [];
    this.outputPath = null;
    this.update({ status: "idle", startedAt: null });

    return result;
  }
}
