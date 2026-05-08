from __future__ import annotations

import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from app.analysis.waveform import (
    _decode_samples,
    generate_waveform_png,
    render_waveform_png_bytes,
    write_minimal_png,
)


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _read_ihdr_dimensions(data: bytes) -> tuple[int, int]:
    width = struct.unpack(">I", data[16:20])[0]
    height = struct.unpack(">I", data[20:24])[0]
    return width, height


class WaveformPngTests(unittest.TestCase):
    def test_render_bytes_signature_and_iend(self):
        samples = [int(32767 * math.sin(2 * math.pi * i / 64)) for i in range(2048)]
        data = render_waveform_png_bytes(samples, width=200, height=40)

        self.assertTrue(data.startswith(PNG_SIGNATURE))
        # IEND is the final chunk: last 12 bytes are length(4) + 'IEND' + crc(4).
        self.assertEqual(data[-8:-4], b"IEND")
        self.assertEqual(data[-12:-8], b"\x00\x00\x00\x00")  # zero-length IEND data

    def test_render_bytes_dimensions_via_ihdr(self):
        samples = [10000, -10000, 5000, -5000] * 100
        data = render_waveform_png_bytes(samples, width=320, height=60)

        self.assertTrue(data.startswith(PNG_SIGNATURE))
        width, height = _read_ihdr_dimensions(data)
        self.assertEqual(width, 320)
        self.assertEqual(height, 60)

    def test_generate_from_real_wav_mono_16bit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            wav_path = Path(temp_dir) / "tone.wav"
            sample_rate = 8000
            duration = 1
            frames = bytearray()
            for i in range(sample_rate * duration):
                value = int(20000 * math.sin(2 * math.pi * 220 * i / sample_rate))
                frames.extend(struct.pack("<h", value))
            with wave.open(str(wav_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                wav.writeframes(bytes(frames))

            output = generate_waveform_png(wav_path, width=240, height=48)

            self.assertTrue(output.exists())
            data = output.read_bytes()
            self.assertGreater(len(data), 0)
            self.assertTrue(data.startswith(PNG_SIGNATURE))
            self.assertEqual(_read_ihdr_dimensions(data), (240, 48))
            # Default suffix swap.
            self.assertEqual(output, wav_path.with_suffix(".png"))

    def test_generate_from_real_wav_stereo_16bit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            wav_path = Path(temp_dir) / "stereo.wav"
            sample_rate = 8000
            duration = 1
            frames = bytearray()
            for i in range(sample_rate * duration):
                left = int(15000 * math.sin(2 * math.pi * 200 * i / sample_rate))
                right = int(15000 * math.sin(2 * math.pi * 400 * i / sample_rate))
                frames.extend(struct.pack("<hh", left, right))
            with wave.open(str(wav_path), "wb") as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                wav.writeframes(bytes(frames))

            out_path = Path(temp_dir) / "stereo.png"
            output = generate_waveform_png(wav_path, out_path, width=300, height=50)

            self.assertEqual(output, out_path)
            self.assertTrue(output.exists())
            data = output.read_bytes()
            self.assertTrue(data.startswith(PNG_SIGNATURE))
            self.assertEqual(_read_ihdr_dimensions(data), (300, 50))

    def test_generate_from_zero_frame_wav(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            wav_path = Path(temp_dir) / "empty.wav"
            with wave.open(str(wav_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"")

            output = generate_waveform_png(wav_path, width=120, height=24)

            self.assertTrue(output.exists())
            data = output.read_bytes()
            self.assertTrue(data.startswith(PNG_SIGNATURE))
            self.assertEqual(_read_ihdr_dimensions(data), (120, 24))

    def test_unsupported_sample_width_raises_value_error(self):
        # The wave module won't easily produce a non-1/2/3/4 sampwidth, so call
        # the internal decoder directly with a contrived width.
        with self.assertRaises(ValueError):
            _decode_samples(b"\x00" * 16, sampwidth=5, nchannels=1, nframes=4)

    def test_write_minimal_png_round_trip_size(self):
        width, height = 8, 4
        pixels = bytes(range(width * height))
        data = write_minimal_png(pixels, width, height)
        self.assertTrue(data.startswith(PNG_SIGNATURE))
        self.assertEqual(_read_ihdr_dimensions(data), (width, height))
        self.assertEqual(data[-8:-4], b"IEND")


if __name__ == "__main__":
    unittest.main()
