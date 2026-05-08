from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import pydantic

from app.settings import AppSettings, SettingsStore


class SettingsStoreTests(unittest.TestCase):
    def test_load_on_empty_dir_returns_defaults_and_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            settings = store.load()

            self.assertEqual(settings, AppSettings())
            self.assertFalse(store.path.exists())
            self.assertEqual(list(data_dir.iterdir()), [])

    def test_save_writes_file_and_load_round_trips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            original = AppSettings(
                default_protocol_id="evp-1",
                auto_capture_still_seconds=30,
                theme="light",
                default_session_duration_minutes=45,
                evp_blind_review=True,
                notes="Quiet-room baseline",
            )
            store.save(original)

            self.assertTrue(store.path.exists())
            loaded = store.load()
            self.assertEqual(loaded, original)

    def test_update_persists_partial_change_and_preserves_other_defaults(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            updated = store.update({"theme": "light"})

            self.assertEqual(updated.theme, "light")
            self.assertIsNone(updated.default_protocol_id)
            self.assertFalse(updated.evp_blind_review)

            reloaded = store.load()
            self.assertEqual(reloaded.theme, "light")
            self.assertEqual(reloaded, AppSettings(theme="light"))

    def test_update_with_invalid_value_raises_validation_error_and_does_not_persist(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            with self.assertRaises(pydantic.ValidationError):
                store.update({"auto_capture_still_seconds": 0})

            self.assertFalse(store.path.exists())

    def test_update_with_invalid_value_after_existing_save_does_not_overwrite_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            original = AppSettings(theme="light", auto_capture_still_seconds=15)
            store.save(original)
            previous_bytes = store.path.read_bytes()

            with self.assertRaises(pydantic.ValidationError):
                store.update({"auto_capture_still_seconds": 0})

            self.assertEqual(store.path.read_bytes(), previous_bytes)
            self.assertEqual(store.load(), original)

    def test_extras_round_trip_preserves_free_form_dict(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            extras = {
                "experimental_feature_flag": True,
                "ui_density": "compact",
                "favourite_locations": ["Old Gaol", "Q-Station"],
                "thresholds": {"emf": 1.5, "audio": -38.0},
            }
            store.save(AppSettings(extras=extras))

            loaded = store.load()
            self.assertEqual(loaded.extras, extras)

    def test_atomic_save_leaves_no_tmp_files_in_data_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            store.save(AppSettings(theme="light"))
            store.save(AppSettings(theme="dark", notes="second pass"))

            leftover = [p.name for p in data_dir.iterdir() if p.name.endswith(".tmp")]
            self.assertEqual(leftover, [])
            self.assertEqual(
                [p.name for p in data_dir.iterdir()],
                ["settings.json"],
            )

    def test_malformed_json_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            store.path.write_text("{this is not valid json", encoding="utf-8")

            with self.assertRaises(ValueError):
                store.load()

    def test_reset_writes_defaults_and_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            store.save(AppSettings(theme="light", notes="will be wiped"))
            defaults = store.reset()

            self.assertEqual(defaults, AppSettings())
            self.assertEqual(store.load(), AppSettings())

    def test_save_creates_data_dir_if_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir) / "nested" / "settings_dir"
            self.assertFalse(data_dir.exists())
            store = SettingsStore(data_dir)

            store.save(AppSettings(theme="light"))

            self.assertTrue(store.path.exists())
            with store.path.open(encoding="utf-8") as handle:
                payload = json.load(handle)
            self.assertEqual(payload["theme"], "light")

    def test_unknown_keys_in_file_are_ignored_on_load(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            store = SettingsStore(data_dir)

            payload = {
                "theme": "light",
                "future_field_that_does_not_exist_yet": 123,
            }
            data_dir.mkdir(parents=True, exist_ok=True)
            store.path.write_text(json.dumps(payload), encoding="utf-8")

            loaded = store.load()

            self.assertEqual(loaded.theme, "light")
            self.assertFalse(hasattr(loaded, "future_field_that_does_not_exist_yet"))


if __name__ == "__main__":
    unittest.main()
