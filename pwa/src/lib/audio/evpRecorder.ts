/**
 * EVP recorder (Step 6 — scaffold).
 *
 * **Status: scaffold.** The pipeline shape is right; the Whisper.cpp WASM
 * + Silero VAD integration is pending. When wired:
 *
 *   - AudioWorklet streams raw 16 kHz mono PCM to the WAV writer (in OPFS).
 *   - Silero VAD WASM gates speech regions.
 *   - Whisper-base.en quantized (~57 MB, fetched + cached via modelCache.ts)
 *     transcribes the gated audio in 1-second windows.
 *   - Transcripts persist to the `transcripts` SQLite table linked to the
 *     parent media_asset row, with file-offset references for click-to-play.
 *
 * **Bring-up checklist** (when ready to ship step 6 fully):
 *   1. Add a worker file `src/workers/audioWriter.worker.ts` that uses
 *      `FileSystemSyncAccessHandle` to append PCM chunks to a rolling WAV file
 *      in `/cases/<inv>/media/audio/<session>.wav`.
 *   2. Fetch + cache Whisper model via `modelCache.ts` (URL + sha256 once
 *      a stable hosting decision lands; ggml.ai mirrors are not stable).
 *   3. Decide: whisper.cpp WASM (smaller, slower) vs whisper-onnx via
 *      Transformers.js (bigger, faster on WebGPU).
 *   4. Add Silero VAD WASM (~2 MB) for voice-activity gating.
 *   5. Wire Class A/B/C reviewer classification UI per Panel 3 #5.
 *
 * Privacy default: NEVER send audio to cloud unless user has set their
 * own Anthropic/Gemini key AND the case is NOT flagged
 * `culturallySensitive`. The router in cloudAi.ts enforces this.
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
