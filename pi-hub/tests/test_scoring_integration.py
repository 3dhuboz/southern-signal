from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.analysis.blind_review import submit_blind_review
from app.analysis.calibration import save_calibration
from app.analysis.report import build_evidence_report
from app.analysis.scoring import score_evidence
from app.interference import INTERFERENCE_ITEMS, save_interference_responses
from app.store import InvestigationStore


def _all_desired_interference_answers() -> dict[str, str]:
    return {item["id"]: item["desired_answer"] for item in INTERFERENCE_ITEMS}


def _all_opposite_interference_answers() -> dict[str, str]:
    return {
        item["id"]: ("no" if item["desired_answer"] == "yes" else "yes")
        for item in INTERFERENCE_ITEMS
    }


def _baseline_calibration() -> dict[str, object]:
    return {
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
    }


def _basic_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "audio_spike": True,
        "sensor_correlation_count": 2,
        "media_support": True,
        "unattended_room": True,
        "blind_reviewer_agreement_count": 1,
        "contamination_count": 0,
        "calibration_ok": True,
        "sync_confidence": 0.9,
    }
    payload.update(overrides)
    return payload


class ScoreEvidenceInterferenceTests(unittest.TestCase):
    def test_interference_ok_increases_score_and_appears_in_reasons(self):
        without = score_evidence(_basic_payload())
        passing = score_evidence(
            _basic_payload(interference_ok=True, interference_score=88)
        )
        failing = score_evidence(
            _basic_payload(interference_ok=False, interference_score=51)
        )

        self.assertGreater(passing["score"], failing["score"])
        self.assertGreater(passing["score"], without["score"])

        passing_reasons = " ".join(passing["reasons"]).lower()
        self.assertIn("interference", passing_reasons)
        self.assertIn("88", passing_reasons)

        failing_reasons = " ".join(failing["reasons"]).lower()
        self.assertIn("interference", failing_reasons)
        self.assertIn("51", failing_reasons)

    def test_interference_score_none_is_inert_and_backwards_compatible(self):
        baseline = score_evidence(_basic_payload())
        with_none = score_evidence(
            _basic_payload(interference_ok=False, interference_score=None)
        )

        self.assertEqual(with_none["score"], baseline["score"])
        self.assertEqual(with_none["label"], baseline["label"])
        self.assertEqual(with_none["reasons"], baseline["reasons"])

        for reason in with_none["reasons"]:
            self.assertNotIn("interference", reason.lower())


class BuildEvidenceReportIntegrationTests(unittest.TestCase):
    def _make_store(self, root: Path) -> InvestigationStore:
        return InvestigationStore(root / "southern_signal.db", root / "sessions")

    def _seed_basic_investigation(
        self, store: InvestigationStore
    ) -> dict[str, object]:
        investigation = store.create_investigation("Integration case")
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
        )
        return investigation

    def test_report_reads_real_calibration_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = self._seed_basic_investigation(store)

            no_calibration = build_evidence_report(store, investigation["id"])
            self.assertIsNone(no_calibration["calibration"])
            self.assertTrue(
                any(
                    "calibration was missing" in reason.lower()
                    for reason in no_calibration["confidence"]["reasons"]
                )
            )

            save_calibration(
                store.sessions_dir, investigation["id"], _baseline_calibration()
            )
            with_calibration = build_evidence_report(store, investigation["id"])

        self.assertIsNotNone(with_calibration["calibration"])
        self.assertTrue(with_calibration["calibration"]["calibration_ok"])
        self.assertTrue(
            any(
                "calibration checks passed" in reason.lower()
                for reason in with_calibration["confidence"]["reasons"]
            )
        )
        self.assertGreater(
            with_calibration["confidence"]["score"],
            no_calibration["confidence"]["score"],
        )

    def test_report_reads_real_interference_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = self._seed_basic_investigation(store)
            save_calibration(
                store.sessions_dir, investigation["id"], _baseline_calibration()
            )

            no_interference = build_evidence_report(store, investigation["id"])
            self.assertIsNone(no_interference["interference"])
            for reason in no_interference["confidence"]["reasons"]:
                self.assertNotIn("interference", reason.lower())

            save_interference_responses(
                store.sessions_dir,
                investigation["id"],
                answers=_all_desired_interference_answers(),
                notes="checklist passed",
            )
            with_interference = build_evidence_report(store, investigation["id"])

        self.assertIsNotNone(with_interference["interference"])
        record = with_interference["interference"]
        self.assertEqual(record["computed"]["score"], 100)
        self.assertEqual(record["notes"], "checklist passed")
        self.assertGreater(
            with_interference["confidence"]["score"],
            no_interference["confidence"]["score"],
        )
        self.assertTrue(
            any(
                "interference" in reason.lower() and "100" in reason
                for reason in with_interference["confidence"]["reasons"]
            )
        )

    def test_failing_interference_record_lowers_score(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = self._seed_basic_investigation(store)
            save_calibration(
                store.sessions_dir, investigation["id"], _baseline_calibration()
            )
            save_interference_responses(
                store.sessions_dir,
                investigation["id"],
                answers=_all_opposite_interference_answers(),
            )

            report = build_evidence_report(store, investigation["id"])

        self.assertIsNotNone(report["interference"])
        self.assertEqual(report["interference"]["computed"]["score"], 0)
        self.assertTrue(
            any(
                "below threshold" in reason.lower()
                for reason in report["confidence"]["reasons"]
            )
        )

    def test_report_reads_blind_reviewer_agreement(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Blind agreement case")
            save_calibration(
                store.sessions_dir, investigation["id"], _baseline_calibration()
            )

            marker_timestamps = [
                "2026-05-07T10:00:10+00:00",
                "2026-05-07T10:00:30+00:00",
                "2026-05-07T10:00:55+00:00",
            ]
            for index, timestamp in enumerate(marker_timestamps):
                store.add_event(
                    investigation_id=investigation["id"],
                    source="user",
                    event_type="marker" if index % 2 == 0 else "observation",
                    title=f"Marker {index}",
                    timestamp=timestamp,
                )

            no_reviews = build_evidence_report(store, investigation["id"])
            self.assertIsNotNone(no_reviews["blind_review_agreement"])
            self.assertEqual(
                no_reviews["blind_review_agreement"][
                    "blind_reviewer_agreement_count"
                ],
                0,
            )

            submit_blind_review(
                store,
                store.sessions_dir,
                investigation["id"],
                reviewer_id="alice",
                perceived_events=[{"timestamp": ts} for ts in marker_timestamps],
            )
            submit_blind_review(
                store,
                store.sessions_dir,
                investigation["id"],
                reviewer_id="bob",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:10+00:00"},
                    {"timestamp": "2026-05-07T10:00:30+00:00"},
                ],
            )

            with_reviews = build_evidence_report(store, investigation["id"])

        agreement = with_reviews["blind_review_agreement"]
        self.assertGreater(agreement["blind_reviewer_agreement_count"], 0)
        self.assertEqual(agreement["reviewer_count"], 2)
        self.assertGreater(
            with_reviews["confidence"]["score"],
            no_reviews["confidence"]["score"],
        )
        self.assertTrue(
            any(
                "blind reviewer" in reason.lower()
                for reason in with_reviews["confidence"]["reasons"]
            )
        )

    def test_backwards_compatible_when_no_calibration_no_interference_no_reviews(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = self._make_store(root)
            investigation = store.create_investigation("Bare case")
            store.add_sensor_sample(
                investigation_id=investigation["id"],
                sensor_type="mock_magnetometer",
                value=45.0,
                unit="uT",
                timestamp="2026-05-07T10:00:00+00:00",
            )

            report = build_evidence_report(store, investigation["id"])

        self.assertIsNone(report["calibration"])
        self.assertIsNone(report["interference"])
        agreement = report["blind_review_agreement"]
        self.assertIsNotNone(agreement)
        self.assertEqual(agreement["reviewer_count"], 0)
        self.assertEqual(agreement["blind_reviewer_agreement_count"], 0)

        confidence = report["confidence"]
        self.assertIsInstance(confidence["score"], int)
        self.assertGreaterEqual(confidence["score"], 0)
        self.assertLessEqual(confidence["score"], 100)
        self.assertIn(confidence["label"], ("weak", "moderate", "strong"))
        for reason in confidence["reasons"]:
            self.assertNotIn("interference", reason.lower())


if __name__ == "__main__":
    unittest.main()
