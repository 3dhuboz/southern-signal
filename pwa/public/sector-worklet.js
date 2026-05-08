/**
 * Stereo PCM AudioWorklet — Southern Signal Acoustic Sector Indicator.
 *
 * Buffers the incoming stereo stream into 1024-sample windows with 50%
 * overlap, posts each frame to the main thread via port.postMessage.
 * Plain JS (no TS / no imports) so Cloudflare Pages serves it directly
 * with the right MIME type for the AudioWorklet loader.
 *
 * Frame schema posted to main thread:
 *   { left: Float32Array(1024), right: Float32Array(1024),
 *     sampleRate: number, frameTs: number }
 */

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

class SectorWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufLeft = new Float32Array(FRAME_SIZE);
    this.bufRight = new Float32Array(FRAME_SIZE);
    this.write = 0;
    this.samplesSinceLastEmit = 0;
  }

  /** Process called every 128 samples. We accumulate until a frame is ready. */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input.length > 1 ? input[1] : input[0]; // duplicate mono → R if no R channel
    if (!left) return true;
    const n = left.length;
    for (let i = 0; i < n; i++) {
      this.bufLeft[this.write] = left[i];
      this.bufRight[this.write] = right[i];
      this.write = (this.write + 1) % FRAME_SIZE;
      this.samplesSinceLastEmit += 1;
      if (this.samplesSinceLastEmit >= HOP_SIZE) {
        this.emitFrame();
        this.samplesSinceLastEmit = 0;
      }
    }
    return true;
  }

  emitFrame() {
    // Copy out of the ring buffer in chronological order starting from write.
    const left = new Float32Array(FRAME_SIZE);
    const right = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const idx = (this.write + i) % FRAME_SIZE;
      left[i] = this.bufLeft[idx];
      right[i] = this.bufRight[idx];
    }
    this.port.postMessage({
      left,
      right,
      sampleRate,
      frameTs: currentTime,
    }, [left.buffer, right.buffer]);
  }
}

registerProcessor("sector-worklet", SectorWorklet);
