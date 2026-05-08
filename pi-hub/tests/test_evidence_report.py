import tempfile
import unittest
from pathlib import Path

from app.analysis.calibration import save_calibration
from app.analysis.report import build_evidence_report
from app.store import InvestigationStore


class EvidenceReportTests(unittest.TestCase):
    def test_report_summarizes_session_counts_anomalies_and_score(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Report test")
            store.add_marker(investigation["id"], "Calibration passed", "Compass and room baseline checked.")
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )
            store.add_media_asset(
                investigation_id=investigation["id"],
                media_type="image",
                file_path="media/camera/placeholder.png",
                timestamp_start="2026-05-07T10:00:04+00:00",
                metadata={"recorder": "placeholder_camera"},
            )

            report = build_evidence_report(store, investigation["id"])

        self.assertEqual(report["investigation"]["id"], investigation["id"])
        self.assertEqual(report["counts"]["samples"], 6)
        self.assertEqual(report["counts"]["media"], 1)
        self.assertEqual(report["counts"]["anomalies"], 1)
        self.assertEqual(report["confidence"]["label"], "weak")
        self.assertTrue(report["review_next_steps"])
        self.assertEqual(len(report["review_windows"]), 1)

    def test_contamination_events_reduce_report_confidence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Contamination report")
            for index, value in enumerate([45.0, 45.1, 44.9, 45.2, 68.0, 45.0]):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )
            save_calibration(
                store.sessions_dir,
                investigation["id"],
                {
                    "started_at": "2026-05-07T09:00:00+00:00",
                    "ended_at": "2026-05-07T09:00:59+00:00",
                    "duration_seconds": 59.0,
                    "sample_count": 60,
                    "sensors": {
                        "mock_magnetometer": {
                            "count": 60,
                            "mean": 45.0,
                            "stdev": 0.1,
                            "min": 44.8,
                            "max": 45.2,
                            "unit": "uT",
                        }
                    },
                },
            )
            before = build_evidence_report(store, investigation["id"])
            store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="contamination",
                title="Footsteps contamination",
                description="Investigator crossed the room.",
                metadata={"contamination_type": "footsteps"},
            )

            after = build_evidence_report(store, investigation["id"])

        self.assertLess(after["confidence"]["score"], before["confidence"]["score"])


if __name__ == "__main__":
    unittest.main()
