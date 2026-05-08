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
