/**
 * WAV (RIFF/WAVE) header generation and PCM helpers.
 *
 * Used by the EVP recorder to write 16-bit signed PCM mono WAV files
 * to OPFS. No external deps — RIFF spec is small.
 */

export interface WavHeaderOptions {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  numFrames: number;
}

export function buildWavHeader({ sampleRate, numChannels, bitsPerSample, numFrames }: WavHeaderOptions): ArrayBuffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  let offset = 0;

  const writeAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    offset += s.length;
  };
  const writeU32 = (v: number) => { view.setUint32(offset, v, true); offset += 4; };
  const writeU16 = (v: number) => { view.setUint16(offset, v, true); offset += 2; };

  writeAscii("RIFF");
  writeU32(36 + dataSize);
  writeAscii("WAVE");
  writeAscii("fmt ");
  writeU32(16);                 // PCM fmt chunk size
  writeU16(1);                  // PCM format
  writeU16(numChannels);
  writeU32(sampleRate);
  writeU32(byteRate);
  writeU16(blockAlign);
  writeU16(bitsPerSample);
  writeAscii("data");
  writeU32(dataSize);

  return buffer;
}

/** Convert a Float32 PCM array (-1..1) to 16-bit signed PCM little-endian bytes. */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Build a complete WAV file in memory from a single Float32 buffer. */
export function encodeWavFromFloat32(samples: Float32Array, sampleRate: number, numChannels = 1): Uint8Array {
  const pcm = float32ToInt16(samples);
  const numFrames = Math.floor(pcm.length / numChannels);
  const header = new Uint8Array(buildWavHeader({
    sampleRate, numChannels, bitsPerSample: 16, numFrames,
  }));
  const out = new Uint8Array(header.length + pcm.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(pcm.buffer), header.length);
  return out;
}

/**
 * Downsample a mono Float32 PCM buffer from `fromRate` to `toRate`.
 *
 * Intended for preparing audio for downstream consumers that require a
 * specific rate (e.g. a future Whisper.cpp WASM integration that expects
 * exactly 16 kHz mono PCM). The native AudioContext sample rate on iOS
 * Safari is typically 44.1 kHz even when 48 kHz is requested, so both the
 * integer-ratio (48k → 16k) and non-integer (44.1k → 16k) paths matter.
 *
 * Algorithmic notes:
 *   - When fromRate === toRate, the input is returned unchanged (no copy).
 *     Callers that need to mutate the result should clone explicitly.
 *   - When fromRate / toRate is an integer ratio, every Nth sample is
 *     taken (naive decimation). Proper downsampling would apply a
 *     low-pass anti-alias filter before decimation, but speech energy is
 *     mostly band-limited under 8 kHz so the aliasing penalty is small in
 *     practice. If high-frequency content matters for a caller, swap in a
 *     filtered resampler (e.g. polyphase / sinc).
 *   - For non-integer ratios, linear interpolation is used. Linear is
 *     adequate for speech recognition; sinc would be higher fidelity but
 *     is overkill here and has higher CPU cost on the main thread.
 *
 * Throws on upsample requests (toRate > fromRate) — this util does not
 * implement the band-limiting needed for upsampling.
 */
export function downsampleFloat32(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error(`downsampleFloat32: invalid rates fromRate=${fromRate} toRate=${toRate}`);
  }
  if (toRate > fromRate) {
    throw new Error(
      `downsampleFloat32: upsampling not supported (fromRate=${fromRate}, toRate=${toRate}); use a band-limited resampler`,
    );
  }
  if (fromRate === toRate) {
    // Documented contract: returned reference may alias `samples`. The
    // caller is responsible for cloning if mutability is a concern.
    return samples;
  }
  const n = samples.length;
  if (n === 0) return new Float32Array(0);

  const ratio = fromRate / toRate;
  const outLength = Math.floor(n * (toRate / fromRate));
  if (outLength <= 0) return new Float32Array(0);

  const out = new Float32Array(outLength);

  // Integer ratio → decimate (take every Nth sample, no interpolation).
  if (Number.isInteger(ratio)) {
    const step = ratio;
    for (let i = 0; i < outLength; i++) {
      out[i] = samples[i * step];
    }
    return out;
  }

  // Non-integer ratio → linear interpolation between neighboring samples.
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const p0 = Math.floor(pos);
    const p1 = Math.min(p0 + 1, n - 1);
    const frac = pos - p0;
    out[i] = samples[p0] * (1 - frac) + samples[p1] * frac;
  }
  return out;
}
