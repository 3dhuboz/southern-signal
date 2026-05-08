import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.exporter import build_export_zip
from app.store import InvestigationStore


class InvestigationStoreTests(unittest.TestCase):
    def test_investigation_lifecycle_records_markers_and_sensor_samples(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")

            investigation = store.create_investigation(
                title="Cell block baseline",
                location_name="Old gaol",
                notes="Quiet-room test",
            )
            store.start_investigation(investigation["id"])
            store.add_sensor_sample(
                investigation_id=investigation["id"],
                sensor_type="mock_magnetometer",
                value=42.5,
                unit="uT",
                x=1.0,
                y=2.0,
                z=3.0,
                metadata={"source": "test"},
            )
            store.add_marker(
                investigation_id=investigation["id"],
                title="Knock heard",
                description="Single knock from hallway",
            )
            stopped = store.stop_investigation(investigation["id"])

            self.assertEqual(stopped["status"], "stopped")

            detail = store.get_investigation(investigation["id"])
            self.assertEqual(detail["title"], "Cell block baseline")
            self.assertIsNotNone(detail["started_at"])
            self.assertIsNotNone(detail["ended_at"])

            samples = store.list_sensor_samples(investigation["id"])
            self.assertEqual(len(samples), 1)
            self.assertEqual(samples[0]["sensor_type"], "mock_magnetometer")
            self.assertEqual(json.loads(samples[0]["metadata_json"])["source"], "test")

            events = store.list_events(investigation["id"])
            self.assertEqual([event["event_type"] for event in events], ["session_started", "marker", "session_stopped"])

    def test_export_zip_contains_session_json_csvs_and_readme(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Export test")
            store.start_investigation(investigation["id"])
            store.add_sensor_sample(investigation["id"], "temperature", value=21.2, unit="C")
            store.add_marker(investigation["id"], "Question asked", "Who is here?")
            store.stop_investigation(investigation["id"])

            archive = build_export_zip(store, investigation["id"])

            self.assertTrue(archive.exists())
            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
                self.assertIn("session.json", names)
                self.assertIn("sensor_samples.csv", names)
                self.assertIn("events.csv", names)
                self.assertIn("README.txt", names)

                session = json.loads(zipped.read("session.json"))
                self.assertEqual(session["title"], "Export test")
                self.assertIn("environmental data", zipped.read("README.txt").decode("utf-8"))

    def test_export_zip_contains_anomaly_cards_json(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Anomaly export")
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )

            archive = build_export_zip(store, investigation["id"])

            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
                self.assertIn("anomaly_cards.json", names)
                anomalies = json.loads(zipped.read("anomaly_cards.json"))
            self.assertEqual(len(anomalies), 1)
            self.assertEqual(anomalies[0]["sensor_type"], "mock_magnetometer")


if __name__ == "__main__":
    unittest.main()
