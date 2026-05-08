import json
import tempfile
import unittest
from pathlib import Path

from app.protocol_runner import (
    advance_protocol_step,
    annotate_protocol_step,
    cancel_protocol_run,
    get_protocol_run,
    is_run_complete,
    skip_protocol_step,
    start_protocol_run,
)
from app.protocols import get_protocol, list_protocols


def _first_protocol_id() -> str:
    protocols = list_protocols()
    return protocols[0]["id"]


class StartProtocolRunTests(unittest.TestCase):
    def test_start_persists_snapshot_and_marks_first_step_in_progress(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            protocol = get_protocol(protocol_id)
            expected_count = len(protocol["steps"])

            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )

            self.assertEqual(state["protocol_id"], protocol_id)
            self.assertEqual(state["step_count"], expected_count)
            self.assertEqual(state["current_step_index"], 0)
            self.assertIsNone(state["completed_at"])
            self.assertIsNotNone(state["started_at"])
            self.assertEqual(len(state["steps"]), expected_count)

            self.assertEqual(state["steps"][0]["status"], "in_progress")
            self.assertIsNotNone(state["steps"][0]["started_at"])
            self.assertIsNone(state["steps"][0]["completed_at"])
            self.assertEqual(state["steps"][0]["title"], protocol["steps"][0]["title"])

            for index, step in enumerate(state["steps"][1:], start=1):
                self.assertEqual(step["status"], "pending", msg=f"step {index}")
                self.assertIsNone(step["started_at"], msg=f"step {index}")
                self.assertIsNone(step["completed_at"], msg=f"step {index}")
                self.assertIsNone(step["note"], msg=f"step {index}")

            saved_path = sessions_dir / "inv-1" / "protocol_run.json"
            self.assertTrue(saved_path.exists())
            with saved_path.open("r", encoding="utf-8") as handle:
                self.assertEqual(json.load(handle), state)

    def test_unknown_protocol_id_raises_key_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            with self.assertRaises(KeyError):
                start_protocol_run(
                    sessions_dir,
                    "inv-1",
                    protocol_id="not-a-real-protocol",
                )

    def test_starting_second_run_while_one_in_progress_raises(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()

            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)

            with self.assertRaises(RuntimeError):
                start_protocol_run(
                    sessions_dir,
                    "inv-1",
                    protocol_id=protocol_id,
                )


class AdvanceProtocolStepTests(unittest.TestCase):
    def test_advance_completes_current_step_and_starts_next(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)

            state = advance_protocol_step(
                sessions_dir,
                "inv-1",
                note="step done",
            )

            self.assertEqual(state["current_step_index"], 1)
            first = state["steps"][0]
            self.assertEqual(first["status"], "complete")
            self.assertIsNotNone(first["completed_at"])
            self.assertIsNotNone(first["started_at"])
            self.assertEqual(first["note"], "step done")

            second = state["steps"][1]
            self.assertEqual(second["status"], "in_progress")
            self.assertIsNotNone(second["started_at"])
            self.assertIsNone(second["completed_at"])
            self.assertIsNone(state["completed_at"])

    def test_advancing_through_all_steps_completes_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )
            step_count = state["step_count"]

            for _ in range(step_count):
                state = advance_protocol_step(sessions_dir, "inv-1")

            self.assertEqual(state["current_step_index"], step_count)
            self.assertIsNotNone(state["completed_at"])
            for step in state["steps"]:
                self.assertEqual(step["status"], "complete")
                self.assertIsNotNone(step["completed_at"])

    def test_advancing_completed_run_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )
            for _ in range(state["step_count"]):
                state = advance_protocol_step(sessions_dir, "inv-1")

            with self.assertRaises(RuntimeError):
                advance_protocol_step(sessions_dir, "inv-1")

    def test_advance_without_run_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            with self.assertRaises(RuntimeError):
                advance_protocol_step(sessions_dir, "inv-1")


class SkipProtocolStepTests(unittest.TestCase):
    def test_skip_records_skipped_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)

            state = skip_protocol_step(
                sessions_dir,
                "inv-1",
                note="not applicable",
            )

            first = state["steps"][0]
            self.assertEqual(first["status"], "skipped")
            self.assertNotEqual(first["status"], "complete")
            self.assertIsNotNone(first["completed_at"])
            self.assertEqual(first["note"], "not applicable")
            self.assertEqual(state["current_step_index"], 1)
            self.assertEqual(state["steps"][1]["status"], "in_progress")


class AnnotateProtocolStepTests(unittest.TestCase):
    def test_annotate_updates_note_without_changing_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)

            advance_protocol_step(sessions_dir, "inv-1")
            skip_protocol_step(sessions_dir, "inv-1")

            state = annotate_protocol_step(
                sessions_dir,
                "inv-1",
                step_index=0,
                note="retroactive note for first step",
            )
            self.assertEqual(state["steps"][0]["status"], "complete")
            self.assertEqual(
                state["steps"][0]["note"], "retroactive note for first step"
            )

            state = annotate_protocol_step(
                sessions_dir,
                "inv-1",
                step_index=1,
                note="why we skipped",
            )
            self.assertEqual(state["steps"][1]["status"], "skipped")
            self.assertEqual(state["steps"][1]["note"], "why we skipped")

            current_index = state["current_step_index"]
            state = annotate_protocol_step(
                sessions_dir,
                "inv-1",
                step_index=current_index,
                note="planning ahead",
            )
            self.assertEqual(state["steps"][current_index]["status"], "in_progress")
            self.assertEqual(state["steps"][current_index]["note"], "planning ahead")

    def test_annotate_bad_index_raises_index_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )
            with self.assertRaises(IndexError):
                annotate_protocol_step(
                    sessions_dir,
                    "inv-1",
                    step_index=state["step_count"],
                    note="oob",
                )
            with self.assertRaises(IndexError):
                annotate_protocol_step(
                    sessions_dir,
                    "inv-1",
                    step_index=-1,
                    note="negative",
                )

    def test_annotate_without_run_raises_runtime_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            with self.assertRaises(RuntimeError):
                annotate_protocol_step(
                    sessions_dir,
                    "inv-1",
                    step_index=0,
                    note="ghost",
                )


class CancelProtocolRunTests(unittest.TestCase):
    def test_cancel_deletes_state_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)
            path = sessions_dir / "inv-1" / "protocol_run.json"
            self.assertTrue(path.exists())

            cancel_protocol_run(sessions_dir, "inv-1")
            self.assertFalse(path.exists())
            self.assertIsNone(get_protocol_run(sessions_dir, "inv-1"))

            cancel_protocol_run(sessions_dir, "inv-1")
            cancel_protocol_run(sessions_dir, "never-existed")


class IsRunCompleteTests(unittest.TestCase):
    def test_none_state_is_not_complete(self):
        self.assertFalse(is_run_complete(None))

    def test_in_progress_state_is_not_complete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )
            self.assertFalse(is_run_complete(state))

    def test_completed_state_is_complete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()
            state = start_protocol_run(
                sessions_dir,
                "inv-1",
                protocol_id=protocol_id,
            )
            for _ in range(state["step_count"]):
                state = advance_protocol_step(sessions_dir, "inv-1")
            self.assertTrue(is_run_complete(state))


class AtomicWriteTests(unittest.TestCase):
    def test_no_tmp_files_left_behind_after_save(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            protocol_id = _first_protocol_id()

            start_protocol_run(sessions_dir, "inv-1", protocol_id=protocol_id)
            advance_protocol_step(sessions_dir, "inv-1", note="ok")
            skip_protocol_step(sessions_dir, "inv-1")
            annotate_protocol_step(
                sessions_dir,
                "inv-1",
                step_index=0,
                note="retro",
            )

            inv_dir = sessions_dir / "inv-1"
            leftover = [child for child in inv_dir.iterdir() if child.suffix == ".tmp"]
            self.assertEqual(leftover, [])
            self.assertTrue((inv_dir / "protocol_run.json").exists())


if __name__ == "__main__":
    unittest.main()
