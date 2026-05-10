/**
 * audio-worklet-recorder.js
 *
 * AudioWorkletProcessor for forensic-grade EVP capture. Runs OFF the main
 * thread on the Web Audio rendering thread, eliminating the main-thread
 * jank and console deprecation warnings produced by the legacy
 * ScriptProcessorNode.
 *
 * Loaded by `src/lib/audio/evpRecorder.ts` via:
 *   await audioCtx.audioWorklet.addModule("/audio-worklet-recorder.js")
 *
 * Vite serves /public verbatim — this file is plain ES module syntax with
 * no imports and no bundler involvement.
 *
 * Wire-up:
 *   - Receives mono input at audioCtx.sampleRate (typically 48 kHz).
 *   - On every render quantum (128 frames), copies the input channel into
 *     a fresh Float32Array and posts it back to the main thread via
 *     `this.port.postMessage(buffer, [buffer.buffer])` so the underlying
 *     ArrayBuffer is transferred (zero-copy).
 *   - Returns true to keep the processor alive for the lifetime of the
 *     AudioContext / source connection.
 *   - Output is intentionally left silent — the main thread reads chunks
 *     via the message port; the audio graph just needs a sink so the
 *     worklet runs.
 */

class AudioWorkletRecorderProcessor extends AudioWorkletProcessor {
  process(inputs /* outputs, parameters */) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      // No input channel connected this quantum — keep the worklet alive.
      return true;
    }
    const channel = input[0];
    if (!channel || channel.length === 0) {
      return true;
    }
    // Copy the render quantum into a fresh Float32Array so the underlying
    // ArrayBuffer can be transferred (the input buffer is reused by the
    // audio engine each quantum and must not be transferred directly).
    const buffer = new Float32Array(channel.length);
    buffer.set(channel);
    this.port.postMessage(buffer, [buffer.buffer]);
    return true;
  }
}

registerProcessor("audio-worklet-recorder", AudioWorkletRecorderProcessor);
