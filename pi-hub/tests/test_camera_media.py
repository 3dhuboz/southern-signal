import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.exporter import build_export_zip
from app.recorders.camera import PlaceholderCameraRecorder, create_camera_recorder
from app.store import InvestigationStore


class CameraMediaTests(unittest.TestCase):
    def test_camera_recorder_creates_image_and_media_asset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Camera test")
            recorder = PlaceholderCameraRecorder(store, width=320, height=180)

            asset = recorder.capture_still(investigation["id"])

            self.assertEqual(asset["media_type"], "image")
            image_path = root / "sessions" / investigation["id"] / asset["file_path"]
            self.assertTrue(image_path.exists())
            self.assertEqual(image_path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

            metadata = json.loads(asset["metadata_json"])
            self.assertEqual(metadata["recorder"], "placeholder_camera")
            self.assertEqual(metadata["dimensions"], {"width": 320, "height": 180})
            self.assertTrue(metadata["placeholder"])

    def test_factory_falls_back_when_picamera2_is_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")

            recorder = create_camera_recorder(store, prefer_pi=True, backend_loader=lambda: None)

            self.assertIsInstance(recorder, PlaceholderCameraRecorder)
            self.assertEqual(recorder.metadata["fallback_reason"], "picamera2_unavailable")
            self.assertEqual(recorder.metadata["intended_recorder"], "picamera2")

    def test_export_includes_camera_image_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Camera export")
            PlaceholderCameraRecorder(store).capture_still(investigation["id"])

            archive = build_export_zip(store, investigation["id"])

            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
            self.assertIn("media/camera/placeholder.png", names)


if __name__ == "__main__":
    unittest.main()
