/**
 * Minimal WAV (RIFF/WAVE) decoder for 16-bit and 32-bit-float PCM.
 *
 * The EVP recorder writes 16-bit signed PCM mono via `encodeWavFromFloat32`,
 * so that's the primary path. We also handle 32-bit float and stereo since
 * imported recordings (Dolby On, Voice Memos export, etc.) often use those.
 */

export interface DecodedWav {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  durationSeconds: number;
  samples: Float32Array;
}

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  if (buffer.byteLength < 44) throw new Error("WAV too short");
  const view = new DataView(buffer);

  if (readAscii(view, 0, 4) !== "RIFF") throw new Error("Not a RIFF file");
  if (readAscii(view, 8, 4) !== "WAVE") throw new Error("Not a WAVE container");

  let offset = 12;
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      const audioFormat = view.getUint16(offset + 8, true);
      const numChannels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const bitsPerSample = view.getUint16(offset + 22, true);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }

  if (!fmt) throw new Error("Missing fmt chunk");
  if (dataOffset < 0) throw new Error("Missing data chunk");

  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const framesPerChannel = Math.floor(totalSamples / numChannels);

  const out = new Float32Array(framesPerChannel);

  if (audioFormat === 1 && bitsPerSample === 16) {
    // PCM 16 — average channels to mono.
    for (let i = 0; i < framesPerChannel; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const sampleOffset = dataOffset + (i * numChannels + c) * 2;
        sum += view.getInt16(sampleOffset, true) / 0x8000;
      }
      out[i] = sum / numChannels;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    // IEEE float 32.
    for (let i = 0; i < framesPerChannel; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const sampleOffset = dataOffset + (i * numChannels + c) * 4;
        sum += view.getFloat32(sampleOffset, true);
      }
      out[i] = sum / numChannels;
    }
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    for (let i = 0; i < framesPerChannel; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const o = dataOffset + (i * numChannels + c) * 3;
        const lo = view.getUint8(o);
        const mid = view.getUint8(o + 1);
        const hi = view.getInt8(o + 2);
        const value = (hi << 16) | (mid << 8) | lo;
        sum += value / 0x800000;
      }
      out[i] = sum / numChannels;
    }
  } else {
    throw new Error(`Unsupported WAV format: format=${audioFormat} bits=${bitsPerSample}`);
  }

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    durationSeconds: framesPerChannel / sampleRate,
    samples: out,
  };
}

/**
 * Compute peak min/max pairs per output column. Used by the waveform
 * canvas: for each pixel column, draw a vertical bar from `min` to `max`.
 *
 * Returns Float32Array of length `width * 2`, interleaved [min0, max0, min1, max1, …].
 */
export function computeWaveformPeaks(samples: Float32Array, width: number): Float32Array {
  const out = new Float32Array(width * 2);
  if (samples.length === 0 || width <= 0) return out;
  const samplesPerColumn = samples.length / width;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * samplesPerColumn);
    const end = Math.min(samples.length, Math.floor((x + 1) * samplesPerColumn));
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    if (min === 1 && max === -1) { min = 0; max = 0; }
    out[x * 2] = min;
    out[x * 2 + 1] = max;
  }
  return out;
}

/** Compute RMS over a window — useful for displaying clip energy. */
export function computeRms(samples: Float32Array, start = 0, end = samples.length): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - start));
}
