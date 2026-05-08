from __future__ import annotations

import struct
import wave
import zlib
from pathlib import Path

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def write_minimal_png(pixels: bytes, width: int, height: int) -> bytes:
    """Encode raw 8-bit grayscale pixel bytes as a minimal valid PNG."""
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")
    if len(pixels) != width * height:
        raise ValueError(
            f"pixels length {len(pixels)} does not match width*height {width*height}"
        )

    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    ihdr_chunk = _build_chunk(b"IHDR", ihdr_data)

    raw_scanlines = bytearray()
    for row in range(height):
        raw_scanlines.append(0)  # filter type 0 (None)
        start = row * width
        raw_scanlines.extend(pixels[start : start + width])
    idat_data = zlib.compress(bytes(raw_scanlines), 9)
    idat_chunk = _build_chunk(b"IDAT", idat_data)

    iend_chunk = _build_chunk(b"IEND", b"")

    return _PNG_SIGNATURE + ihdr_chunk + idat_chunk + iend_chunk


def render_waveform_png_bytes(samples: list[int], width: int = 480, height: int = 80) -> bytes:
    """Render a list of mono integer samples to a grayscale waveform PNG."""
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")

    pixels = bytearray(b"\x00" * (width * height))

    if not samples:
        return write_minimal_png(bytes(pixels), width, height)

    peak = _column_peaks(samples, width)

    max_amp = max(peak) if peak else 0
    if max_amp <= 0:
        return write_minimal_png(bytes(pixels), width, height)

    usable = max(1, int(height * 0.9))
    half = usable // 2
    mid = height // 2

    for col, amplitude in enumerate(peak):
        normalized = amplitude / max_amp
        bar_half = max(0, int(round(normalized * half)))
        if bar_half == 0 and amplitude > 0:
            bar_half = 1
        top = max(0, mid - bar_half)
        bottom = min(height, mid + bar_half + 1)
        for row in range(top, bottom):
            pixels[row * width + col] = 255

    return write_minimal_png(bytes(pixels), width, height)


def generate_waveform_png(
    wav_path: Path,
    output_path: Path | None = None,
    *,
    width: int = 480,
    height: int = 80,
) -> Path:
    """Read a WAV file and write a grayscale waveform PNG next to it (or to output_path)."""
    wav_path = Path(wav_path)
    if output_path is None:
        output_path = wav_path.with_suffix(".png")
    else:
        output_path = Path(output_path)

    with wave.open(str(wav_path), "rb") as wav:
        nchannels = wav.getnchannels()
        sampwidth = wav.getsampwidth()
        nframes = wav.getnframes()
        raw = wav.readframes(nframes)

    samples = _decode_samples(raw, sampwidth, nchannels, nframes)
    png_bytes = render_waveform_png_bytes(samples, width=width, height=height)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(png_bytes)
    return output_path


def _build_chunk(chunk_type: bytes, data: bytes) -> bytes:
    length = struct.pack(">I", len(data))
    crc = struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    return length + chunk_type + data + crc


def _decode_samples(
    raw: bytes,
    sampwidth: int,
    nchannels: int,
    nframes: int,
) -> list[int]:
    """Decode raw PCM bytes into a flat list of mono integer samples."""
    if nframes == 0 or not raw:
        return []
    if nchannels < 1:
        raise ValueError(f"invalid channel count: {nchannels}")
    if sampwidth not in (1, 2, 3, 4):
        raise ValueError(f"unsupported sample width: {sampwidth} bytes")

    total_samples = nframes * nchannels
    interleaved: list[int]

    if sampwidth == 1:
        # 8-bit PCM is stored unsigned [0, 255]; center to signed range.
        interleaved = [b - 128 for b in raw[:total_samples]]
    elif sampwidth == 2:
        interleaved = list(struct.unpack(f"<{total_samples}h", raw[: total_samples * 2]))
    elif sampwidth == 3:
        interleaved = []
        for i in range(total_samples):
            offset = i * 3
            b0, b1, b2 = raw[offset], raw[offset + 1], raw[offset + 2]
            value = b0 | (b1 << 8) | (b2 << 16)
            if value & 0x800000:
                value -= 0x1000000
            interleaved.append(value)
    else:  # sampwidth == 4
        interleaved = list(struct.unpack(f"<{total_samples}i", raw[: total_samples * 4]))

    if nchannels == 1:
        return interleaved

    mono: list[int] = []
    for frame_start in range(0, total_samples, nchannels):
        frame = interleaved[frame_start : frame_start + nchannels]
        mono.append(sum(frame) // nchannels)
    return mono


def _column_peaks(samples: list[int], width: int) -> list[int]:
    """Compute peak absolute amplitude per column for `width` columns."""
    n = len(samples)
    peaks = [0] * width
    if n == 0:
        return peaks

    if n <= width:
        for i, sample in enumerate(samples):
            col = min(width - 1, (i * width) // max(1, n))
            amp = -sample if sample < 0 else sample
            if amp > peaks[col]:
                peaks[col] = amp
        return peaks

    for col in range(width):
        start = (col * n) // width
        end = ((col + 1) * n) // width
        if end <= start:
            end = start + 1
        max_amp = 0
        for sample in samples[start:end]:
            amp = -sample if sample < 0 else sample
            if amp > max_amp:
                max_amp = amp
        peaks[col] = max_amp
    return peaks
