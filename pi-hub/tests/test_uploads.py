import re
import tempfile
import unittest
from pathlib import Path

from app.store import InvestigationStore
from app.uploads import detect_media_kind, safe_upload_filename, save_upload


TIMESTAMP_PREFIX_RE = re.compile(r"^\d{8}T\d{6}Z_")


class DetectMediaKindTests(unittest.TestCase):
    def test_audio_extensions(self):
        for name in ["clip.wav", "clip.mp3", "clip.m4a", "clip.ogg", "clip.webm"]:
            self.assertEqual(detect_media_kind(name), "audio")

    def test_image_extensions(self):
        for name in ["photo.png", "photo.jpg", "photo.jpeg", "photo.webp", "photo.heic"]:
            self.assertEqual(detect_media_kind(name), "image")

    def test_extension_is_authoritative_over_content_type(self):
        self.assertEqual(detect_media_kind("photo.png", content_type="audio/mpeg"), "image")

    def test_unsupported_extension_raises_value_error(self):
        with self.assertRaises(ValueError):
            detect_media_kind("payload.exe")

    def test_falls_back_to_content_type_when_no_extension(self):
        self.assertEqual(detect_media_kind("noext", content_type="audio/mpeg"), "audio")
        self.assertEqual(detect_media_kind("noext", content_type="image/png"), "image")

    def test_unsupported_content_type_raises_value_error(self):
        with self.assertRaises(ValueError):
            detect_media_kind("noext", content_type="application/octet-stream")

    def test_no_extension_no_content_type_raises_value_error(self):
        with self.assertRaises(ValueError):
            detect_media_kind("noext")


class SafeUploadFilenameTests(unittest.TestCase):
    def test_strips_windows_path_traversal(self):
        result = safe_upload_filename("..\\..\\evil.wav")
        self.assertNotIn("..", result)
        self.assertNotIn("\\", result)
        self.assertTrue(result.endswith(".wav"))
        self.assertRegex(result, TIMESTAMP_PREFIX_RE)

    def test_strips_unix_path_traversal(self):
        result = safe_upload_filename("/etc/foo.png")
        self.assertNotIn("/", result)
        self.assertTrue(result.endswith(".png"))
        self.assertRegex(result, TIMESTAMP_PREFIX_RE)

    def test_strips_leading_dots(self):
        result = safe_upload_filename("...hidden.jpg")
        self.assertRegex(result, TIMESTAMP_PREFIX_RE)
        self.assertTrue(result.endswith(".jpg"))
        self.assertNotIn("/...", result)

    def test_preserves_extension(self):
        result = safe_upload_filename("clip.WAV")
        self.assertTrue(result.endswith(".wav"))

    def test_prefixes_utc_timestamp(self):
        result = safe_upload_filename("clip.wav")
        prefix = result.split("_")[0]
        self.assertEqual(len(prefix), 16)
        self.assertTrue(prefix.endswith("Z"))
        self.assertEqual(prefix[8], "T")

    def test_re_prefixes_timestamp_on_already_safe_names(self):
        first = safe_upload_filename("clip.wav")
        second = safe_upload_filename(first)
        self.assertRegex(second, TIMESTAMP_PREFIX_RE)
        self.assertTrue(second.endswith(".wav"))
        self.assertNotEqual(second, first)

    def test_empty_input_uses_fallback(self):
        result = safe_upload_filename("", fallback_kind="audio")
        self.assertTrue(result.endswith("audio.bin"))
        self.assertRegex(result, TIMESTAMP_PREFIX_RE)

    def test_sanitizes_unsafe_characters(self):
        result = safe_upload_filename("my crazy file!.png")
        self.assertNotIn(" ", result)
        self.assertNotIn("!", result)
        self.assertTrue(result.endswith(".png"))


class SaveUploadTests(unittest.TestCase):
    def _make_store(self, root: Path) -> InvestigationStore:
        return InvestigationStore(root / "southern_signal.db", root / "sessions")

    def test_save_upload_writes_audio_file_and_registers_asset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Upload test")

            payload = b"fake audio bytes"
            asset = save_upload(
                store=store,
                investigation_id=investigation["id"],
                content=payload,
                original_filename="evp_clip.wav",
                content_type="audio/wav",
                description="Recorded on phone in basement.",
                timestamp_start="2026-05-08T10:00:00+00:00",
            )

            self.assertEqual(asset["media_type"], "audio")
            file_path = Path(asset["file_path"])
            self.assertTrue(file_path.exists())
            self.assertEqual(file_path.read_bytes(), payload)
            self.assertIn("media", str(file_path))
            self.assertIn("uploads", str(file_path))

            assets = store.list_media_assets(investigation["id"])
            self.assertEqual(len(assets), 1)
            self.assertEqual(assets[0]["id"], asset["id"])

    def test_save_upload_for_image_extension_sets_image_media_type(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Image upload")

            asset = save_upload(
                store=store,
                investigation_id=investigation["id"],
                content=b"PNGDATA",
                original_filename="shadow.png",
            )

            self.assertEqual(asset["media_type"], "image")

    def test_save_upload_with_audio_extension_sets_audio_media_type(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Audio upload")

            asset = save_upload(
                store=store,
                investigation_id=investigation["id"],
                content=b"OGGDATA",
                original_filename="voice.ogg",
            )

            self.assertEqual(asset["media_type"], "audio")

    def test_save_upload_empty_bytes_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Empty payload")

            with self.assertRaises(ValueError):
                save_upload(
                    store=store,
                    investigation_id=investigation["id"],
                    content=b"",
                    original_filename="clip.wav",
                )

    def test_save_upload_unknown_investigation_raises_key_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)

            with self.assertRaises(KeyError):
                save_upload(
                    store=store,
                    investigation_id="not-a-real-id",
                    content=b"abc",
                    original_filename="clip.wav",
                )

    def test_save_upload_writes_under_session_uploads_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Path test")

            asset = save_upload(
                store=store,
                investigation_id=investigation["id"],
                content=b"abc",
                original_filename="clip.wav",
            )

            expected_dir = store.session_dir(investigation["id"]) / "media" / "uploads"
            self.assertTrue(expected_dir.exists())
            self.assertEqual(Path(asset["file_path"]).parent.resolve(), expected_dir.resolve())


if __name__ == "__main__":
    unittest.main()
