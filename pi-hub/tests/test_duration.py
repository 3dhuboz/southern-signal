import json
import tempfile
import unittest
from pathlib import Path

from app.duration import (
    clear_duration_target,
    compute_target_end,
    elapsed_seconds,
    is_complete,
    load_duration_target,
    parse_duration_minutes,
    remaining_seconds,
    save_duration_target,
    status_for,
)


class ParseDurationMinutesTests(unittest.TestCase):
    def test_none_and_empty_string_return_none(self):
        self.assertIsNone(parse_duration_minutes(None))
        self.assertIsNone(parse_duration_minutes(""))
        self.assertIsNone(parse_duration_minutes("   "))

    def test_accepts_positive_int(self):
        self.assertEqual(parse_duration_minutes(20), 20)
        self.assertEqual(parse_duration_minutes(1), 1)
        self.assertEqual(parse_duration_minutes(1440), 1440)

    def test_accepts_positive_float_rounded_half_up(self):
        self.assertEqual(parse_duration_minutes(20.4), 20)
        self.assertEqual(parse_duration_minutes(20.5), 21)
        self.assertEqual(parse_duration_minutes(20.6), 21)
        self.assertEqual(parse_duration_minutes(0.5), 1)

    def test_accepts_numeric_strings(self):
        self.assertEqual(parse_duration_minutes("20"), 20)
        self.assertEqual(parse_duration_minutes("  30  "), 30)
        self.assertEqual(parse_duration_minutes("19.5"), 20)

    def test_rejects_zero_and_negative(self):
        with self.assertRaises(ValueError):
            parse_duration_minutes(0)
        with self.assertRaises(ValueError):
            parse_duration_minutes(-5)
        with self.assertRaises(ValueError):
            parse_duration_minutes("-3")
        with self.assertRaises(ValueError):
            parse_duration_minutes(0.4)  # rounds to 0

    def test_rejects_more_than_one_day(self):
        with self.assertRaises(ValueError):
            parse_duration_minutes(1441)
        with self.assertRaises(ValueError):
            parse_duration_minutes("2000")

    def test_rejects_non_numeric_strings(self):
        with self.assertRaises(ValueError):
            parse_duration_minutes("abc")
        with self.assertRaises(ValueError):
            parse_duration_minutes("20m")

    def test_rejects_booleans(self):
        with self.assertRaises(ValueError):
            parse_duration_minutes(True)


class ComputeTargetEndTests(unittest.TestCase):
    def test_known_timestamp_plus_twenty_minutes(self):
        result = compute_target_end("2026-05-08T12:00:00+00:00", 20)
        self.assertEqual(result, "2026-05-08T12:20:00+00:00")

    def test_one_minute_increment(self):
        result = compute_target_end("2026-05-08T23:59:30+00:00", 1)
        self.assertEqual(result, "2026-05-09T00:00:30+00:00")

    def test_naive_input_assumed_utc(self):
        result = compute_target_end("2026-05-08T12:00:00", 5)
        self.assertEqual(result, "2026-05-08T12:05:00+00:00")


class ElapsedSecondsTests(unittest.TestCase):
    def test_explicit_now_returns_floor_difference(self):
        elapsed = elapsed_seconds(
            "2026-05-08T12:00:00+00:00",
            now="2026-05-08T12:05:30+00:00",
        )
        self.assertEqual(elapsed, 330)

    def test_subsecond_is_floored(self):
        elapsed = elapsed_seconds(
            "2026-05-08T12:00:00+00:00",
            now="2026-05-08T12:00:01.900000+00:00",
        )
        self.assertEqual(elapsed, 1)

    def test_clamped_to_zero_when_now_before_start(self):
        elapsed = elapsed_seconds(
            "2026-05-08T12:00:00+00:00",
            now="2026-05-08T11:59:00+00:00",
        )
        self.assertEqual(elapsed, 0)


class RemainingSecondsTests(unittest.TestCase):
    def test_remaining_before_target_is_positive(self):
        remaining = remaining_seconds(
            "2026-05-08T12:20:00+00:00",
            now="2026-05-08T12:00:00+00:00",
        )
        self.assertEqual(remaining, 1200)

    def test_remaining_at_target_is_zero(self):
        remaining = remaining_seconds(
            "2026-05-08T12:20:00+00:00",
            now="2026-05-08T12:20:00+00:00",
        )
        self.assertEqual(remaining, 0)

    def test_remaining_past_target_clamps_to_zero(self):
        remaining = remaining_seconds(
            "2026-05-08T12:20:00+00:00",
            now="2026-05-08T13:00:00+00:00",
        )
        self.assertEqual(remaining, 0)


class IsCompleteTests(unittest.TestCase):
    def test_none_target_is_never_complete(self):
        self.assertFalse(is_complete(None))
        self.assertFalse(is_complete(None, now="2099-01-01T00:00:00+00:00"))

    def test_before_target_is_not_complete(self):
        self.assertFalse(
            is_complete(
                "2026-05-08T12:20:00+00:00",
                now="2026-05-08T12:19:59+00:00",
            )
        )

    def test_at_or_past_target_is_complete(self):
        self.assertTrue(
            is_complete(
                "2026-05-08T12:20:00+00:00",
                now="2026-05-08T12:20:00+00:00",
            )
        )
        self.assertTrue(
            is_complete(
                "2026-05-08T12:20:00+00:00",
                now="2026-05-08T13:00:00+00:00",
            )
        )


class DurationPersistenceTests(unittest.TestCase):
    def test_save_then_load_round_trip_with_started_at(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            saved = save_duration_target(
                sessions_dir,
                "inv-1",
                target_minutes=20,
                started_at="2026-05-08T12:00:00+00:00",
            )
            self.assertEqual(saved["target_minutes"], 20)
            self.assertEqual(saved["started_at"], "2026-05-08T12:00:00+00:00")
            self.assertEqual(saved["target_end"], "2026-05-08T12:20:00+00:00")

            path = sessions_dir / "inv-1" / "duration.json"
            self.assertTrue(path.exists())
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            self.assertEqual(raw, saved)

            loaded = load_duration_target(sessions_dir, "inv-1")
            self.assertEqual(loaded, saved)

    def test_save_without_started_at_leaves_target_end_none(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            saved = save_duration_target(
                sessions_dir,
                "inv-2",
                target_minutes=15,
            )
            self.assertEqual(saved["target_minutes"], 15)
            self.assertIsNone(saved["target_end"])
            self.assertIsNone(saved["started_at"])
            loaded = load_duration_target(sessions_dir, "inv-2")
            self.assertEqual(loaded, saved)

    def test_save_with_target_minutes_none_deletes_existing_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            save_duration_target(
                sessions_dir,
                "inv-3",
                target_minutes=20,
                started_at="2026-05-08T12:00:00+00:00",
            )
            path = sessions_dir / "inv-3" / "duration.json"
            self.assertTrue(path.exists())

            cleared = save_duration_target(
                sessions_dir,
                "inv-3",
                target_minutes=None,
                started_at="2026-05-08T12:00:00+00:00",
            )
            self.assertEqual(
                cleared,
                {
                    "target_minutes": None,
                    "target_end": None,
                    "started_at": "2026-05-08T12:00:00+00:00",
                },
            )
            self.assertFalse(path.exists())
            self.assertIsNone(load_duration_target(sessions_dir, "inv-3"))

    def test_clear_duration_target_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            clear_duration_target(sessions_dir, "missing")  # no file yet
            save_duration_target(
                sessions_dir,
                "inv-4",
                target_minutes=10,
                started_at="2026-05-08T12:00:00+00:00",
            )
            clear_duration_target(sessions_dir, "inv-4")
            clear_duration_target(sessions_dir, "inv-4")  # second call must not raise
            self.assertIsNone(load_duration_target(sessions_dir, "inv-4"))

    def test_load_returns_none_when_file_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            self.assertIsNone(load_duration_target(sessions_dir, "ghost"))


class StatusForTests(unittest.TestCase):
    def test_none_target_yields_all_none_and_not_complete(self):
        status = status_for(None)
        self.assertEqual(
            status,
            {
                "target_minutes": None,
                "started_at": None,
                "target_end": None,
                "elapsed_seconds": None,
                "remaining_seconds": None,
                "complete": False,
            },
        )

    def test_target_without_started_at_reports_no_elapsed_or_remaining(self):
        target = {
            "target_minutes": 20,
            "target_end": None,
            "started_at": None,
        }
        status = status_for(target, now="2026-05-08T12:10:00+00:00")
        self.assertEqual(status["target_minutes"], 20)
        self.assertIsNone(status["started_at"])
        self.assertIsNone(status["target_end"])
        self.assertIsNone(status["elapsed_seconds"])
        self.assertIsNone(status["remaining_seconds"])
        self.assertFalse(status["complete"])

    def test_target_in_progress(self):
        target = {
            "target_minutes": 20,
            "target_end": "2026-05-08T12:20:00+00:00",
            "started_at": "2026-05-08T12:00:00+00:00",
        }
        status = status_for(target, now="2026-05-08T12:05:00+00:00")
        self.assertEqual(status["target_minutes"], 20)
        self.assertEqual(status["started_at"], "2026-05-08T12:00:00+00:00")
        self.assertEqual(status["target_end"], "2026-05-08T12:20:00+00:00")
        self.assertEqual(status["elapsed_seconds"], 300)
        self.assertEqual(status["remaining_seconds"], 900)
        self.assertFalse(status["complete"])

    def test_target_past_end_is_complete_with_zero_remaining(self):
        target = {
            "target_minutes": 20,
            "target_end": "2026-05-08T12:20:00+00:00",
            "started_at": "2026-05-08T12:00:00+00:00",
        }
        status = status_for(target, now="2026-05-08T13:00:00+00:00")
        self.assertEqual(status["remaining_seconds"], 0)
        self.assertTrue(status["complete"])
        self.assertEqual(status["elapsed_seconds"], 3600)

    def test_target_with_started_at_but_missing_target_end_is_resolved(self):
        target = {
            "target_minutes": 20,
            "target_end": None,
            "started_at": "2026-05-08T12:00:00+00:00",
        }
        status = status_for(target, now="2026-05-08T12:05:00+00:00")
        self.assertEqual(status["target_end"], "2026-05-08T12:20:00+00:00")
        self.assertEqual(status["remaining_seconds"], 900)
        self.assertEqual(status["elapsed_seconds"], 300)
        self.assertFalse(status["complete"])


if __name__ == "__main__":
    unittest.main()
