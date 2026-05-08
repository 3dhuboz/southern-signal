import json
import tempfile
import unittest
import wave
import zipfile
from pathlib import Path

from app.exporter import build_export_zip
from app.recorders.audio import SilentWavRecorder, UsbMicrophoneWavRecorder, create_audio_recorder
from app.store import InvestigationStore


class AudioMediaTests(unittest.TestCase):
    def test_audio_recorder_creates_wav_and_media_asset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Audio test")
            recorder = SilentWavRecorder(store)

            asset = recorder.record_placeholder(investigation["id"], duration_seconds=1)

            self.assertEqual(asset["media_type"], "audio")
            wav_path = root / "sessions" / investigation["id"] / asset["file_path"]
            self.assertTrue(wav_path.exists())
            with wave.open(str(wav_path), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getframerate(), 16000)

            assets = store.list_media_assets(investigation["id"])
            self.assertEqual(len(assets), 1)
            self.assertEqual(assets[0]["media_type"], "audio")

    def test_export_includes_recorded_audio_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Audio export")
            SilentWavRecorder(store).record_placeholder(investigation["id"], duration_seconds=1)

            archive = build_export_zip(store, investigation["id"])

            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
            self.assertIn("media/audio.wav", names)

    def test_factory_falls_back_to_silent_recorder_when_real_backend_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")

            recorder = create_audio_recorder(store, prefer_real=True, backend_loader=lambda: None)

            self.assertIsInstance(recorder, SilentWavRecorder)
            self.assertEqual(recorder.metadata["recorder"], "silent_placeholder")
            self.assertEqual(recorder.metadata["fallback_reason"], "microphone_backend_unavailable")
            self.assertEqual(recorder.metadata["intended_recorder"], "usb_microphone")

    def test_fallback_media_metadata_identifies_intended_recorder(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Audio fallback")
            recorder = create_audio_recorder(store, prefer_real=True, backend_loader=lambda: None)

            asset = recorder.record_placeholder(investigation["id"], duration_seconds=1)
            metadata = json.loads(asset["metadata_json"])

            self.assertEqual(metadata["recorder"], "silent_placeholder")
            self.assertEqual(metadata["fallback_reason"], "microphone_backend_unavailable")
            self.assertEqual(metadata["intended_recorder"], "usb_microphone")

    def test_factory_selects_usb_recorder_when_backend_is_available(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            backend = object()

            recorder = create_audio_recorder(store, prefer_real=True, backend_loader=lambda: backend)

            self.assertIsInstance(recorder, UsbMicrophoneWavRecorder)
            self.assertEqual(recorder.metadata["recorder"], "usb_microphone")
            self.assertEqual(recorder.metadata["backend"], "sounddevice")


if __name__ == "__main__":
    unittest.main()
