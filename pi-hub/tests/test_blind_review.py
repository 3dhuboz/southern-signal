import json
import tempfile
import time
import unittest
from pathlib import Path

from app.analysis.blind_review import (
    compute_blind_review_agreement,
    list_blind_reviews,
    start_blind_review,
    submit_blind_review,
)
from app.store import InvestigationStore


def _build_store(root: Path) -> InvestigationStore:
    return InvestigationStore(root / "southern_signal.db", root / "sessions")


class StartBlindReviewTests(unittest.TestCase):
    def test_returns_audio_assets_only_and_does_not_leak_marker_timestamps(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Blind seed")

            store.add_media_asset(
                investigation_id=investigation["id"],
                media_type="audio",
                file_path="media/audio/clip.wav",
                timestamp_start="2026-05-07T10:00:00+00:00",
                timestamp_end="2026-05-07T10:05:00+00:00",
            )
            store.add_media_asset(
                investigation_id=investigation["id"],
                media_type="image",
                file_path="media/camera/still.png",
                timestamp_start="2026-05-07T10:02:00+00:00",
            )
            store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="marker",
                title="Heard a voice",
                timestamp="2026-05-07T10:04:23+00:00",
            )
            store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="observation",
                title="Cold spot",
                timestamp="2026-05-07T10:04:45+00:00",
            )

            result = start_blind_review(store, investigation["id"])

        self.assertEqual(result["investigation_id"], investigation["id"])
        self.assertIn("reviewer_id", result)
        self.assertIn("started_at", result)
        self.assertEqual(len(result["audio_assets"]), 1)
        audio = result["audio_assets"][0]
        self.assertEqual(audio["media_type"], "audio")
        self.assertEqual(audio["file_path"], "media/audio/clip.wav")
        self.assertEqual(audio["duration_seconds"], 300.0)
        self.assertIsInstance(result["instructions"], str)
        self.assertGreater(len(result["instructions"]), 0)

        serialized = json.dumps(result)
        self.assertNotIn("2026-05-07T10:04:23+00:00", serialized)
        self.assertNotIn("2026-05-07T10:04:45+00:00", serialized)
        self.assertNotIn("Heard a voice", serialized)
        self.assertNotIn("Cold spot", serialized)

        # The audio assets list itself must contain only audio media; no event
        # markers or observation entries should appear there.
        for audio in result["audio_assets"]:
            self.assertEqual(audio["media_type"], "audio")
            self.assertNotIn("event_type", audio)
            self.assertNotIn("source", audio)

    def test_supplied_reviewer_id_is_preserved_otherwise_generated(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Reviewer ids")

            with_id = start_blind_review(
                store, investigation["id"], reviewer_id="reviewer-alice"
            )
            generated_a = start_blind_review(store, investigation["id"])
            generated_b = start_blind_review(store, investigation["id"])

        self.assertEqual(with_id["reviewer_id"], "reviewer-alice")
        self.assertNotEqual(generated_a["reviewer_id"], generated_b["reviewer_id"])
        self.assertTrue(generated_a["reviewer_id"])
        self.assertTrue(generated_b["reviewer_id"])

    def test_unknown_investigation_raises_key_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            with self.assertRaises(KeyError):
                start_blind_review(store, "no-such-investigation")

    def test_audio_asset_without_end_timestamp_returns_none_duration(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("No end timestamp")
            store.add_media_asset(
                investigation_id=investigation["id"],
                media_type="audio",
                file_path="media/audio/clip.wav",
                timestamp_start="2026-05-07T10:00:00+00:00",
            )

            result = start_blind_review(store, investigation["id"])

        self.assertEqual(len(result["audio_assets"]), 1)
        self.assertIsNone(result["audio_assets"][0]["duration_seconds"])


class SubmitBlindReviewTests(unittest.TestCase):
    def test_round_trip_persists_normalized_payload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Submit happy path")
            sessions_dir = root / "sessions"

            payload = submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="reviewer-bob",
                perceived_events=[
                    {
                        "timestamp": "2026-05-07T10:04:23+00:00",
                        "label": "voice?",
                        "confidence": 4,
                        "media_id": "asset-1",
                    },
                    {"timestamp": "2026-05-07T10:05:30+00:00"},
                ],
                notes="Listened on headphones.",
            )

            saved_path = (
                sessions_dir / investigation["id"] / "blind_reviews" / "reviewer-bob.json"
            )
            self.assertTrue(saved_path.exists())
            with saved_path.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)

        self.assertEqual(payload, loaded)
        self.assertEqual(loaded["reviewer_id"], "reviewer-bob")
        self.assertEqual(loaded["notes"], "Listened on headphones.")
        self.assertEqual(len(loaded["perceived_events"]), 2)
        self.assertEqual(loaded["perceived_events"][0]["label"], "voice?")
        self.assertEqual(loaded["perceived_events"][0]["confidence"], 4)
        self.assertEqual(loaded["perceived_events"][0]["media_id"], "asset-1")

    def test_malformed_timestamp_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Bad timestamp")
            sessions_dir = root / "sessions"

            with self.assertRaises(ValueError):
                submit_blind_review(
                    store,
                    sessions_dir,
                    investigation["id"],
                    reviewer_id="reviewer-c",
                    perceived_events=[{"timestamp": "not a real timestamp"}],
                )

    def test_confidence_out_of_range_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Bad confidence")
            sessions_dir = root / "sessions"

            with self.assertRaises(ValueError):
                submit_blind_review(
                    store,
                    sessions_dir,
                    investigation["id"],
                    reviewer_id="reviewer-d",
                    perceived_events=[
                        {
                            "timestamp": "2026-05-07T10:04:23+00:00",
                            "confidence": 6,
                        }
                    ],
                )

            with self.assertRaises(ValueError):
                submit_blind_review(
                    store,
                    sessions_dir,
                    investigation["id"],
                    reviewer_id="reviewer-d",
                    perceived_events=[
                        {
                            "timestamp": "2026-05-07T10:04:23+00:00",
                            "confidence": 0,
                        }
                    ],
                )

    def test_empty_perceived_events_is_allowed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Heard nothing")
            sessions_dir = root / "sessions"

            payload = submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="reviewer-quiet",
                perceived_events=[],
                notes="Nothing of note.",
            )

        self.assertEqual(payload["perceived_events"], [])
        self.assertEqual(payload["notes"], "Nothing of note.")

    def test_iso_timestamp_with_z_suffix_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Z suffix")
            sessions_dir = root / "sessions"

            payload = submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="reviewer-z",
                perceived_events=[{"timestamp": "2026-05-07T10:04:23Z"}],
            )

        self.assertEqual(payload["perceived_events"][0]["timestamp"], "2026-05-07T10:04:23Z")


class ListBlindReviewsTests(unittest.TestCase):
    def test_empty_when_no_reviews_have_been_submitted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Empty list")
            sessions_dir = root / "sessions"

            self.assertEqual(list_blind_reviews(sessions_dir, investigation["id"]), [])

    def test_results_are_sorted_by_submitted_at(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Sorted reviews")
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="alice",
                perceived_events=[],
            )
            time.sleep(0.01)
            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="bob",
                perceived_events=[],
            )
            time.sleep(0.01)
            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="carol",
                perceived_events=[],
            )

            reviews = list_blind_reviews(sessions_dir, investigation["id"])

        self.assertEqual([review["reviewer_id"] for review in reviews], ["alice", "bob", "carol"])
        for earlier, later in zip(reviews, reviews[1:]):
            self.assertLessEqual(earlier["submitted_at"], later["submitted_at"])


class ComputeBlindReviewAgreementTests(unittest.TestCase):
    def _store_with_markers(self, root: Path, marker_timestamps: list[str]):
        store = _build_store(root)
        investigation = store.create_investigation("Agreement")
        for index, timestamp in enumerate(marker_timestamps):
            store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="marker" if index % 2 == 0 else "observation",
                title=f"Marker {index}",
                timestamp=timestamp,
            )
        return store, investigation

    def test_perfect_reviewer_matches_all_markers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            marker_timestamps = [
                "2026-05-07T10:00:10+00:00",
                "2026-05-07T10:00:30+00:00",
                "2026-05-07T10:00:55+00:00",
            ]
            store, investigation = self._store_with_markers(root, marker_timestamps)
            sessions_dir = root / "sessions"
            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="perfect",
                perceived_events=[{"timestamp": ts} for ts in marker_timestamps],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )

        self.assertEqual(result["marker_count"], 3)
        self.assertEqual(result["reviewer_count"], 1)
        review_summary = result["reviews"][0]
        self.assertEqual(review_summary["matched_count"], 3)
        self.assertEqual(review_summary["false_positive_count"], 0)
        self.assertEqual(review_summary["missed_marker_count"], 0)
        self.assertEqual(review_summary["agreement_percent"], 100)
        self.assertEqual(result["blind_reviewer_agreement_count"], 3)
        self.assertEqual(result["consensus_marker_ids"], [])

    def test_off_by_tolerance_boundary(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store, investigation = self._store_with_markers(
                root,
                [
                    "2026-05-07T10:00:10+00:00",
                    "2026-05-07T10:01:00+00:00",
                ],
            )
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="four-second",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:14+00:00"},
                    {"timestamp": "2026-05-07T10:01:06+00:00"},
                ],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"], tolerance_seconds=5
            )

        review_summary = result["reviews"][0]
        self.assertEqual(review_summary["matched_count"], 1)
        self.assertEqual(review_summary["false_positive_count"], 1)
        self.assertEqual(review_summary["missed_marker_count"], 1)

    def test_greedy_matching_avoids_double_counting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store, investigation = self._store_with_markers(
                root,
                [
                    "2026-05-07T10:00:10+00:00",
                    "2026-05-07T10:00:12+00:00",
                ],
            )
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="single",
                perceived_events=[{"timestamp": "2026-05-07T10:00:11+00:00"}],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"], tolerance_seconds=2
            )

        review_summary = result["reviews"][0]
        self.assertEqual(review_summary["matched_count"], 1)
        self.assertEqual(review_summary["perceived_count"], 1)
        self.assertEqual(review_summary["missed_marker_count"], 1)
        self.assertEqual(result["blind_reviewer_agreement_count"], 1)

    def test_consensus_marker_ids_requires_two_or_more_reviewers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("Consensus")
            marker_a = store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="marker",
                title="A",
                timestamp="2026-05-07T10:00:10+00:00",
            )
            marker_b = store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="observation",
                title="B",
                timestamp="2026-05-07T10:00:30+00:00",
            )
            store.add_event(
                investigation_id=investigation["id"],
                source="user",
                event_type="marker",
                title="C",
                timestamp="2026-05-07T10:01:00+00:00",
            )
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="alice",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:10+00:00"},
                    {"timestamp": "2026-05-07T10:00:30+00:00"},
                ],
            )
            single = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )
            self.assertEqual(single["consensus_marker_ids"], [])

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="bob",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:30+00:00"},
                    {"timestamp": "2026-05-07T10:01:00+00:00"},
                ],
            )

            multi = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )

        self.assertEqual(multi["reviewer_count"], 2)
        self.assertEqual(multi["consensus_marker_ids"], [marker_b["id"]])
        self.assertNotIn(marker_a["id"], multi["consensus_marker_ids"])

    def test_zero_markers_with_zero_perceptions_is_full_agreement(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("No markers, no perceptions")
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="silent",
                perceived_events=[],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )

        review_summary = result["reviews"][0]
        self.assertEqual(result["marker_count"], 0)
        self.assertEqual(review_summary["agreement_percent"], 100)
        self.assertEqual(review_summary["matched_count"], 0)
        self.assertEqual(review_summary["false_positive_count"], 0)

    def test_zero_markers_with_perceptions_is_zero_agreement(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = _build_store(root)
            investigation = store.create_investigation("No markers, some perceptions")
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="overactive",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:10+00:00"},
                    {"timestamp": "2026-05-07T10:00:20+00:00"},
                ],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )

        review_summary = result["reviews"][0]
        self.assertEqual(review_summary["agreement_percent"], 0)
        self.assertEqual(review_summary["false_positive_count"], 2)
        self.assertEqual(review_summary["matched_count"], 0)
        self.assertEqual(result["blind_reviewer_agreement_count"], 0)

    def test_blind_reviewer_agreement_count_sums_across_reviewers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            marker_timestamps = [
                "2026-05-07T10:00:10+00:00",
                "2026-05-07T10:00:20+00:00",
                "2026-05-07T10:00:30+00:00",
            ]
            store, investigation = self._store_with_markers(root, marker_timestamps)
            sessions_dir = root / "sessions"

            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="alice",
                perceived_events=[{"timestamp": ts} for ts in marker_timestamps],
            )
            submit_blind_review(
                store,
                sessions_dir,
                investigation["id"],
                reviewer_id="bob",
                perceived_events=[
                    {"timestamp": "2026-05-07T10:00:10+00:00"},
                    {"timestamp": "2026-05-07T10:00:20+00:00"},
                    {"timestamp": "2026-05-07T10:00:55+00:00"},
                ],
            )

            result = compute_blind_review_agreement(
                store, sessions_dir, investigation["id"]
            )

        matched_total = sum(review["matched_count"] for review in result["reviews"])
        self.assertEqual(result["blind_reviewer_agreement_count"], matched_total)
        self.assertEqual(result["blind_reviewer_agreement_count"], 5)


if __name__ == "__main__":
    unittest.main()
