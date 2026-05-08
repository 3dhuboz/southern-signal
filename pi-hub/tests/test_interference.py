from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.interference import (
    INTERFERENCE_ITEMS,
    compute_interference_score,
    find_interference_item,
    has_acceptable_interference,
    list_interference_items,
    load_interference_responses,
    normalize_answer,
    save_interference_responses,
)


_VALID_CATEGORIES = {
    "acoustic",
    "electromagnetic",
    "environmental",
    "equipment",
    "procedure",
}


class InterferenceItemsCatalogTests(unittest.TestCase):
    def test_catalog_is_non_empty_with_unique_ids(self):
        items = list_interference_items()
        self.assertGreater(len(items), 0)
        ids = [item["id"] for item in items]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_item_has_required_keys_with_correct_types(self):
        for item in INTERFERENCE_ITEMS:
            self.assertIsInstance(item["id"], str)
            self.assertIsInstance(item["label"], str)
            self.assertIsInstance(item["description"], str)
            self.assertIn(item["category"], _VALID_CATEGORIES)
            self.assertIsInstance(item["weight"], int)
            self.assertGreaterEqual(item["weight"], 1)
            self.assertLessEqual(item["weight"], 3)
            self.assertIn(item["desired_answer"], ("yes", "no"))
            self.assertIn(item["default_answer"], ("yes", "no"))

    def test_list_interference_items_returns_a_deepcopy(self):
        items = list_interference_items()
        items[0]["label"] = "MUTATED"
        original = list_interference_items()
        self.assertNotEqual(original[0]["label"], "MUTATED")

    def test_required_ids_present(self):
        ids = {item["id"] for item in INTERFERENCE_ITEMS}
        for required in (
            "hvac_off",
            "traffic_audible",
            "voices_audible",
            "phones_airplane_mode",
            "wifi_disabled",
            "local_devices_minimised",
            "weather_severe",
            "temperature_stable",
            "location_sealed",
            "equipment_self_check",
            "baseline_captured",
            "time_logged",
        ):
            self.assertIn(required, ids)


class FindInterferenceItemTests(unittest.TestCase):
    def test_returns_item_for_known_id(self):
        item = find_interference_item("hvac_off")
        self.assertEqual(item["id"], "hvac_off")
        self.assertEqual(item["category"], "acoustic")

    def test_raises_key_error_for_unknown_id(self):
        with self.assertRaises(KeyError):
            find_interference_item("definitely_not_a_real_id")


class NormalizeAnswerTests(unittest.TestCase):
    def test_yes_inputs(self):
        for raw in ("yes", "Y", "TRUE", "true", True, 1, "1"):
            self.assertEqual(normalize_answer(raw), "yes", msg=raw)

    def test_no_inputs(self):
        for raw in ("no", "N", "FALSE", "false", False, 0, "0"):
            self.assertEqual(normalize_answer(raw), "no", msg=raw)

    def test_null_inputs(self):
        for raw in (None, "", "unsure", "u", "unknown", "skip", "  Unsure "):
            self.assertIsNone(normalize_answer(raw), msg=raw)

    def test_invalid_strings_raise(self):
        with self.assertRaises(ValueError):
            normalize_answer("banana")

    def test_invalid_list_raises(self):
        with self.assertRaises(ValueError):
            normalize_answer([])

    def test_invalid_int_raises(self):
        with self.assertRaises(ValueError):
            normalize_answer(2)


class ComputeInterferenceScoreTests(unittest.TestCase):
    def _all_desired(self) -> dict[str, str]:
        return {item["id"]: item["desired_answer"] for item in INTERFERENCE_ITEMS}

    def _all_opposite(self) -> dict[str, str]:
        return {
            item["id"]: ("no" if item["desired_answer"] == "yes" else "yes")
            for item in INTERFERENCE_ITEMS
        }

    def test_all_desired_answers_score_perfect(self):
        result = compute_interference_score(self._all_desired())
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["coverage"], 100)
        self.assertEqual(result["issue_count"], 0)
        self.assertEqual(result["unanswered_count"], 0)
        self.assertEqual(result["ok_count"], len(INTERFERENCE_ITEMS))
        self.assertEqual(len(result["items"]), len(INTERFERENCE_ITEMS))
        for entry in result["items"]:
            self.assertEqual(entry["status"], "ok")

    def test_all_opposite_answers_score_zero(self):
        result = compute_interference_score(self._all_opposite())
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["coverage"], 100)
        self.assertEqual(result["issue_count"], len(INTERFERENCE_ITEMS))
        self.assertEqual(result["ok_count"], 0)
        self.assertEqual(result["unanswered_count"], 0)
        for entry in result["items"]:
            self.assertEqual(entry["status"], "issue")

    def test_partial_answers_use_only_answered_for_score(self):
        # Answer only the highest-weight desired items correctly,
        # leave the rest unanswered. Score should be 100 (everything answered is ok)
        # but coverage should be partial.
        partial = {
            "hvac_off": "yes",
            "voices_audible": "no",
            "equipment_self_check": "yes",
        }
        result = compute_interference_score(partial)
        self.assertEqual(result["score"], 100)
        self.assertGreater(result["coverage"], 0)
        self.assertLess(result["coverage"], 100)
        self.assertEqual(result["issue_count"], 0)
        self.assertEqual(result["ok_count"], 3)
        self.assertEqual(
            result["unanswered_count"], len(INTERFERENCE_ITEMS) - 3
        )

        # Coverage equals answered_weight / total_weight, expressed as int.
        answered_weight = sum(
            item["weight"]
            for item in INTERFERENCE_ITEMS
            if item["id"] in partial
        )
        total_weight = sum(item["weight"] for item in INTERFERENCE_ITEMS)
        self.assertEqual(
            result["coverage"], round((answered_weight / total_weight) * 100)
        )

    def test_partial_answers_with_mixed_outcomes(self):
        # Two items answered: one ok, one issue.
        # hvac_off (weight 3, desired yes) -> "yes" => ok
        # traffic_audible (weight 2, desired no) -> "yes" => issue
        partial = {"hvac_off": "yes", "traffic_audible": "yes"}
        result = compute_interference_score(partial)
        # answered_weight = 3 + 2 = 5; ok_weight = 3 -> 60
        self.assertEqual(result["score"], 60)
        self.assertEqual(result["ok_count"], 1)
        self.assertEqual(result["issue_count"], 1)
        self.assertEqual(
            result["unanswered_count"], len(INTERFERENCE_ITEMS) - 2
        )

    def test_empty_answers_returns_zeroed_summary(self):
        result = compute_interference_score({})
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["coverage"], 0)
        self.assertEqual(result["issue_count"], 0)
        self.assertEqual(result["ok_count"], 0)
        self.assertEqual(result["unanswered_count"], len(INTERFERENCE_ITEMS))
        for entry in result["items"]:
            self.assertEqual(entry["status"], "unanswered")
            self.assertIsNone(entry["answer"])


class SaveLoadInterferenceTests(unittest.TestCase):
    def test_save_then_load_round_trips_payload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            investigation_id = "case-001"
            answers = {
                "hvac_off": "yes",
                "voices_audible": "no",
                "equipment_self_check": True,
                "wifi_disabled": "unsure",
            }
            saved = save_interference_responses(
                sessions_dir,
                investigation_id,
                answers=answers,
                notes="initial walk-through",
            )

            self.assertIn("answers", saved)
            self.assertIn("computed", saved)
            self.assertIn("saved_at", saved)
            self.assertEqual(saved["notes"], "initial walk-through")
            # Wifi answered "unsure" should normalize to None.
            self.assertIsNone(saved["answers"]["wifi_disabled"])

            path = sessions_dir / investigation_id / "interference.json"
            self.assertTrue(path.exists())
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            self.assertEqual(raw["notes"], "initial walk-through")
            self.assertEqual(raw["answers"]["hvac_off"], "yes")

            loaded = load_interference_responses(sessions_dir, investigation_id)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded["notes"], "initial walk-through")
            self.assertEqual(loaded["answers"], saved["answers"])

    def test_load_returns_none_when_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            self.assertIsNone(
                load_interference_responses(sessions_dir, "no-such-case")
            )

    def test_atomic_write_leaves_no_temp_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            investigation_id = "case-atomic"
            save_interference_responses(
                sessions_dir,
                investigation_id,
                answers={"hvac_off": "yes"},
            )
            target_dir = sessions_dir / investigation_id
            entries = list(target_dir.iterdir())
            self.assertEqual([entry.name for entry in entries], ["interference.json"])
            for entry in entries:
                self.assertFalse(entry.name.endswith(".tmp"))

    def test_save_overwrites_existing_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            investigation_id = "case-overwrite"
            save_interference_responses(
                sessions_dir,
                investigation_id,
                answers={"hvac_off": "no"},
                notes="first pass",
            )
            second = save_interference_responses(
                sessions_dir,
                investigation_id,
                answers={"hvac_off": "yes"},
                notes="second pass",
            )
            self.assertEqual(second["notes"], "second pass")
            loaded = load_interference_responses(sessions_dir, investigation_id)
            assert loaded is not None
            self.assertEqual(loaded["notes"], "second pass")
            self.assertEqual(loaded["answers"]["hvac_off"], "yes")


class HasAcceptableInterferenceTests(unittest.TestCase):
    def _all_desired(self) -> dict[str, str]:
        return {item["id"]: item["desired_answer"] for item in INTERFERENCE_ITEMS}

    def _all_opposite(self) -> dict[str, str]:
        return {
            item["id"]: ("no" if item["desired_answer"] == "yes" else "yes")
            for item in INTERFERENCE_ITEMS
        }

    def test_returns_false_when_no_record_saved(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            self.assertFalse(
                has_acceptable_interference(sessions_dir, "missing")
            )

    def test_returns_true_when_score_and_coverage_above_thresholds(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            save_interference_responses(
                sessions_dir,
                "good-case",
                answers=self._all_desired(),
            )
            self.assertTrue(
                has_acceptable_interference(sessions_dir, "good-case")
            )

    def test_returns_false_when_score_below_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            save_interference_responses(
                sessions_dir,
                "bad-case",
                answers=self._all_opposite(),
            )
            self.assertFalse(
                has_acceptable_interference(sessions_dir, "bad-case")
            )

    def test_returns_false_when_coverage_below_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            sessions_dir.mkdir(parents=True, exist_ok=True)
            # Answer just one item correctly: score is 100 but coverage is tiny.
            save_interference_responses(
                sessions_dir,
                "thin-case",
                answers={"time_logged": "yes"},
            )
            self.assertFalse(
                has_acceptable_interference(sessions_dir, "thin-case")
            )


if __name__ == "__main__":
    unittest.main()
