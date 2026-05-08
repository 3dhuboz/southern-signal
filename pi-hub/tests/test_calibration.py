import json
import math
import tempfile
import unittest
from pathlib import Path

from app.analysis.calibration import (
    assess_calibration,
    calibration_ok,
    compute_calibration,
    load_calibration,
    save_calibration,
)
from app.store import InvestigationStore


class ComputeCalibrationTests(unittest.TestCase):
    def test_computes_mean_stdev_min_max_for_known_dataset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = InvestigationStore(root / "southern_signal.db", root / "sessions")
            investigation = store.create_investigation("Compute calibration")

            magnetometer_values = [44.0, 46.0, 45.0, 45.0]
            for index, value in enumerate(magnetometer_values):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_magnetometer",
                    value=value,
                    unit="uT",
                    timestamp=f"2026-05-07T10:00:{index:02d}+00:00",
                )

            temperature_values = [20.0, 21.0]
            for index, value in enumerate(temperature_values):
                store.add_sensor_sample(
                    investigation_id=investigation["id"],
                    sensor_type="mock_thermometer",
                    value=value,
                    unit="C",
                    timestamp=f"2026-05-07T10:01:{index:02d}+00:00",
                )

            samples = store.list_sensor_samples(investigation["id"])
            calibration = compute_calibration(samples)

        self.assertEqual(calibration["sample_count"], 6)
        self.assertEqual(calibration["started_at"], "2026-05-07T10:00:00+00:00")
        self.assertEqual(calibration["ended_at"], "2026-05-07T10:01:01+00:00")
        self.assertGreater(calibration["duration_seconds"], 0.0)

        magnetometer = calibration["sensors"]["mock_magnetometer"]
        self.assertEqual(magnetometer["count"], 4)
        self.assertAlmostEqual(magnetometer["mean"], 45.0)
        # population stdev for [44, 46, 45, 45] = sqrt(0.5)
        self.assertAlmostEqual(magnetometer["stdev"], math.sqrt(0.5))
        self.assertEqual(magnetometer["min"], 44.0)
        self.assertEqual(magnetometer["max"], 46.0)
        self.assertEqual(magnetometer["unit"], "uT")

        thermometer = calibration["sensors"]["mock_thermometer"]
        self.assertEqual(thermometer["count"], 2)
        self.assertAlmostEqual(thermometer["mean"], 20.5)
        self.assertAlmostEqual(thermometer["stdev"], 0.5)
        self.assertEqual(thermometer["min"], 20.0)
        self.assertEqual(thermometer["max"], 21.0)
        self.assertEqual(thermometer["unit"], "C")

    def test_computes_magnitude_for_xyz_only_samples(self):
        samples = [
            {
                "sensor_type": "mock_imu",
                "x": 3.0,
                "y": 4.0,
                "z": 0.0,
                "value": None,
                "timestamp": "2026-05-07T10:00:00+00:00",
            },
            {
                "sensor_type": "mock_imu",
                "x": 0.0,
                "y": 0.0,
                "z": 5.0,
                "value": None,
                "timestamp": "2026-05-07T10:00:01+00:00",
            },
        ]
        calibration = compute_calibration(samples)
        imu = calibration["sensors"]["mock_imu"]
        self.assertEqual(imu["count"], 2)
        self.assertAlmostEqual(imu["min"], 5.0)
        self.assertAlmostEqual(imu["max"], 5.0)
        self.assertAlmostEqual(imu["mean"], 5.0)
        self.assertAlmostEqual(imu["stdev"], 0.0)

    def test_empty_input_returns_zeroed_summary_without_raising(self):
        calibration = compute_calibration([])
        self.assertEqual(calibration["sample_count"], 0)
        self.assertEqual(calibration["sensors"], {})
        self.assertIsNone(calibration["started_at"])
        self.assertIsNone(calibration["ended_at"])
        self.assertEqual(calibration["duration_seconds"], 0.0)


class AssessCalibrationTests(unittest.TestCase):
    def test_low_sample_count_fails_assessment(self):
        calibration = {
            "sample_count": 5,
            "sensors": {
                "mock_magnetometer": {
                    "count": 5,
                    "mean": 45.0,
                    "stdev": 0.1,
                    "min": 44.9,
                    "max": 45.1,
                }
            },
        }
        result = assess_calibration(calibration, min_samples=30)
        self.assertFalse(result["calibration_ok"])
        self.assertTrue(any("sample" in reason.lower() for reason in result["reasons"]))

    def test_well_behaved_baseline_passes_assessment(self):
        calibration = {
            "sample_count": 60,
            "sensors": {
                "mock_magnetometer": {
                    "count": 60,
                    "mean": 45.0,
                    "stdev": 0.1,
                    "min": 44.8,
                    "max": 45.2,
                },
                "mock_thermometer": {
                    "count": 60,
                    "mean": 20.0,
                    "stdev": 0.05,
                    "min": 19.9,
                    "max": 20.1,
                },
            },
        }
        result = assess_calibration(calibration)
        self.assertTrue(result["calibration_ok"])
        self.assertEqual(result["reasons"], [])


class CalibrationPersistenceTests(unittest.TestCase):
    def test_save_and_load_round_trip_preserves_data(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sessions_dir = root / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            investigation_id = "test-investigation"
            calibration = compute_calibration(
                [
                    {
                        "sensor_type": "mock_magnetometer",
                        "value": 45.0,
                        "unit": "uT",
                        "timestamp": "2026-05-07T10:00:00+00:00",
                    },
                    {
                        "sensor_type": "mock_magnetometer",
                        "value": 45.1,
                        "unit": "uT",
                        "timestamp": "2026-05-07T10:00:01+00:00",
                    },
                ]
            )
            path = save_calibration(sessions_dir, investigation_id, calibration)

            self.assertTrue(path.exists())
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            self.assertIn("calibration_ok", raw)
            self.assertIn("reasons", raw)
            self.assertEqual(raw["sample_count"], calibration["sample_count"])
            self.assertEqual(
                raw["sensors"]["mock_magnetometer"]["count"],
                calibration["sensors"]["mock_magnetometer"]["count"],
            )

            loaded = load_calibration(sessions_dir, investigation_id)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded["sample_count"], calibration["sample_count"])
            self.assertEqual(loaded["started_at"], calibration["started_at"])
            self.assertEqual(loaded["ended_at"], calibration["ended_at"])

    def test_calibration_ok_helper_reflects_saved_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sessions_dir = root / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            investigation_id = "calibration-helper"

            self.assertFalse(calibration_ok(sessions_dir, investigation_id))

            calibration = {
                "started_at": "2026-05-07T10:00:00+00:00",
                "ended_at": "2026-05-07T10:00:59+00:00",
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
            save_calibration(sessions_dir, investigation_id, calibration)
            self.assertTrue(calibration_ok(sessions_dir, investigation_id))


if __name__ == "__main__":
    unittest.main()
