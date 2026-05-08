from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.lifecycle import (
    archive_investigation,
    filter_investigations,
    hard_delete_investigation,
    lifecycle_state,
    restore_investigation,
    soft_delete_investigation,
)
from app.store import InvestigationStore


def _make_store(temp_dir: str) -> InvestigationStore:
    base = Path(temp_dir)
    db_path = base / "hub.db"
    sessions_dir = base / "sessions"
    return InvestigationStore(db_path, sessions_dir)


def _seed_investigation(
    store: InvestigationStore,
    title: str = "Test investigation",
) -> str:
    inv = store.create_investigation(title)
    investigation_id = inv["id"]
    store.add_event(investigation_id, "user", "marker", "first marker")
    store.add_event(investigation_id, "user", "marker", "second marker")
    store.add_sensor_sample(
        investigation_id, "emf", value=1.5, unit="mG"
    )
    store.add_media_asset(
        investigation_id,
        media_type="audio",
        file_path="dummy.wav",
        timestamp_start="2026-05-08T12:00:00+00:00",
    )
    return investigation_id


class LifecycleStateTests(unittest.TestCase):
    def test_fresh_investigation_has_default_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            state = lifecycle_state(store.sessions_dir, investigation_id)
            self.assertFalse(state["archived"])
            self.assertFalse(state["deleted"])
            self.assertIsNone(state["archived_at"])
            self.assertIsNone(state["deleted_at"])
            self.assertIsNone(state["deleted_reason"])

    def test_lifecycle_state_returns_default_for_missing_session_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            sessions_dir = Path(temp_dir) / "sessions"
            state = lifecycle_state(sessions_dir, "ghost")
            self.assertFalse(state["archived"])
            self.assertFalse(state["deleted"])


class ArchiveTests(unittest.TestCase):
    def test_archive_then_state_reports_archived(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            archived = archive_investigation(store.sessions_dir, investigation_id)
            self.assertTrue(archived["archived"])
            self.assertIsNotNone(archived["archived_at"])
            self.assertFalse(archived["deleted"])

            reloaded = lifecycle_state(store.sessions_dir, investigation_id)
            self.assertTrue(reloaded["archived"])
            self.assertEqual(reloaded["archived_at"], archived["archived_at"])

    def test_archive_is_idempotent_and_refreshes_timestamp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            first = archive_investigation(store.sessions_dir, investigation_id)
            second = archive_investigation(store.sessions_dir, investigation_id)
            self.assertTrue(second["archived"])
            self.assertIsNotNone(second["archived_at"])
            # Timestamp may stay equal (sub-second resolution) or refresh.
            # Either way, archiving twice must not raise.
            self.assertGreaterEqual(second["archived_at"], first["archived_at"])

    def test_archive_refuses_when_soft_deleted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            soft_delete_investigation(store.sessions_dir, investigation_id)
            with self.assertRaises(ValueError):
                archive_investigation(store.sessions_dir, investigation_id)


class RestoreTests(unittest.TestCase):
    def test_restore_clears_archive_flag(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            archive_investigation(store.sessions_dir, investigation_id)
            restored = restore_investigation(store.sessions_dir, investigation_id)
            self.assertFalse(restored["archived"])
            self.assertIsNone(restored["archived_at"])
            self.assertFalse(restored["deleted"])
            self.assertIsNone(restored["deleted_at"])

    def test_restore_clears_deleted_flag(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            soft_delete_investigation(
                store.sessions_dir, investigation_id, reason="mistake"
            )
            restored = restore_investigation(store.sessions_dir, investigation_id)
            self.assertFalse(restored["deleted"])
            self.assertIsNone(restored["deleted_at"])
            self.assertIsNone(restored["deleted_reason"])

    def test_restore_is_idempotent_on_fresh_investigation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            first = restore_investigation(store.sessions_dir, investigation_id)
            second = restore_investigation(store.sessions_dir, investigation_id)
            self.assertEqual(first, second)
            self.assertFalse(second["archived"])
            self.assertFalse(second["deleted"])


class SoftDeleteTests(unittest.TestCase):
    def test_soft_delete_sets_flag_and_persists_reason(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            deleted = soft_delete_investigation(
                store.sessions_dir, investigation_id, reason="dupe"
            )
            self.assertTrue(deleted["deleted"])
            self.assertIsNotNone(deleted["deleted_at"])
            self.assertEqual(deleted["deleted_reason"], "dupe")
            self.assertFalse(deleted["archived"])

            reloaded = lifecycle_state(store.sessions_dir, investigation_id)
            self.assertEqual(reloaded["deleted_reason"], "dupe")

    def test_soft_delete_supersedes_archive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            archive_investigation(store.sessions_dir, investigation_id)
            deleted = soft_delete_investigation(
                store.sessions_dir, investigation_id
            )
            self.assertTrue(deleted["deleted"])
            self.assertFalse(deleted["archived"])
            self.assertIsNone(deleted["archived_at"])
            self.assertIsNone(deleted["deleted_reason"])


class HardDeleteTests(unittest.TestCase):
    def test_hard_delete_without_confirm_raises_permission_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            soft_delete_investigation(store.sessions_dir, investigation_id)
            with self.assertRaises(PermissionError):
                hard_delete_investigation(
                    store, store.sessions_dir, investigation_id, confirm=False
                )

    def test_hard_delete_when_not_soft_deleted_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            with self.assertRaises(ValueError):
                hard_delete_investigation(
                    store, store.sessions_dir, investigation_id, confirm=True
                )

    def test_hard_delete_removes_rows_and_session_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)

            # Sanity-check rows exist before deletion.
            self.assertTrue(
                any(inv["id"] == investigation_id for inv in store.list_investigations())
            )
            self.assertGreater(len(store.list_events(investigation_id)), 0)
            self.assertGreater(len(store.list_sensor_samples(investigation_id)), 0)
            self.assertGreater(len(store.list_media_assets(investigation_id)), 0)

            session_dir = store.sessions_dir / investigation_id
            self.assertTrue(session_dir.exists())

            soft_delete_investigation(store.sessions_dir, investigation_id)
            result = hard_delete_investigation(
                store, store.sessions_dir, investigation_id, confirm=True
            )

            self.assertEqual(result["investigation_id"], investigation_id)
            self.assertTrue(result["removed_session_dir"])
            self.assertIsInstance(result["hard_deleted_at"], str)

            self.assertFalse(
                any(inv["id"] == investigation_id for inv in store.list_investigations())
            )
            with store.connect() as db:
                events_count = db.execute(
                    "SELECT COUNT(*) FROM evidence_events WHERE investigation_id = ?",
                    (investigation_id,),
                ).fetchone()[0]
                samples_count = db.execute(
                    "SELECT COUNT(*) FROM sensor_samples WHERE investigation_id = ?",
                    (investigation_id,),
                ).fetchone()[0]
                media_count = db.execute(
                    "SELECT COUNT(*) FROM media_assets WHERE investigation_id = ?",
                    (investigation_id,),
                ).fetchone()[0]
            self.assertEqual(events_count, 0)
            self.assertEqual(samples_count, 0)
            self.assertEqual(media_count, 0)

            self.assertFalse(session_dir.exists())

    def test_hard_delete_handles_empty_session_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            soft_delete_investigation(store.sessions_dir, investigation_id)

            # Drop optional auxiliary contents but keep the lifecycle sidecar
            # so the deleted-check still passes through to the rmtree branch.
            session_dir = store.sessions_dir / investigation_id
            for child in session_dir.iterdir():
                if child.name == "lifecycle.json":
                    continue
                if child.is_dir():
                    import shutil as _shutil

                    _shutil.rmtree(child)
                else:
                    child.unlink()

            result = hard_delete_investigation(
                store, store.sessions_dir, investigation_id, confirm=True
            )
            self.assertTrue(result["removed_session_dir"])
            self.assertFalse(session_dir.exists())


class FilterInvestigationsTests(unittest.TestCase):
    def test_default_hides_archived_and_deleted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            active = _seed_investigation(store, "active")
            archived = _seed_investigation(store, "archived")
            deleted = _seed_investigation(store, "deleted")

            archive_investigation(store.sessions_dir, archived)
            soft_delete_investigation(store.sessions_dir, deleted)

            visible = filter_investigations(
                store.list_investigations(), store.sessions_dir
            )
            visible_ids = {entry["id"] for entry in visible}
            self.assertEqual(visible_ids, {active})

    def test_include_archived_shows_archived_but_hides_deleted(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            active = _seed_investigation(store, "active")
            archived = _seed_investigation(store, "archived")
            deleted = _seed_investigation(store, "deleted")

            archive_investigation(store.sessions_dir, archived)
            soft_delete_investigation(store.sessions_dir, deleted)

            visible = filter_investigations(
                store.list_investigations(),
                store.sessions_dir,
                include_archived=True,
            )
            visible_ids = {entry["id"] for entry in visible}
            self.assertEqual(visible_ids, {active, archived})

    def test_include_both_shows_everything(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            active = _seed_investigation(store, "active")
            archived = _seed_investigation(store, "archived")
            deleted = _seed_investigation(store, "deleted")

            archive_investigation(store.sessions_dir, archived)
            soft_delete_investigation(store.sessions_dir, deleted)

            visible = filter_investigations(
                store.list_investigations(),
                store.sessions_dir,
                include_archived=True,
                include_deleted=True,
            )
            visible_ids = {entry["id"] for entry in visible}
            self.assertEqual(visible_ids, {active, archived, deleted})

    def test_each_entry_carries_lifecycle_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            active = _seed_investigation(store, "active")
            archived = _seed_investigation(store, "archived")
            archive_investigation(store.sessions_dir, archived)

            visible = filter_investigations(
                store.list_investigations(),
                store.sessions_dir,
                include_archived=True,
            )
            self.assertTrue(visible)
            for entry in visible:
                self.assertIn("lifecycle", entry)
                lifecycle = entry["lifecycle"]
                self.assertIn("archived", lifecycle)
                self.assertIn("deleted", lifecycle)
                self.assertIn("archived_at", lifecycle)
                self.assertIn("deleted_at", lifecycle)
                self.assertIn("deleted_reason", lifecycle)
                if entry["id"] == archived:
                    self.assertTrue(lifecycle["archived"])
                if entry["id"] == active:
                    self.assertFalse(lifecycle["archived"])


class PersistenceTests(unittest.TestCase):
    def test_atomic_write_leaves_no_tmp_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            archive_investigation(store.sessions_dir, investigation_id)
            soft_delete_investigation(
                store.sessions_dir, investigation_id, reason="cleanup"
            )
            restore_investigation(store.sessions_dir, investigation_id)

            session_dir = store.sessions_dir / investigation_id
            leftovers = [
                child for child in session_dir.iterdir()
                if child.name.endswith(".tmp")
                or ".tmp" in child.name
            ]
            self.assertEqual(leftovers, [])

    def test_sidecar_file_is_valid_json_and_round_trips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            saved = archive_investigation(store.sessions_dir, investigation_id)

            sidecar = store.sessions_dir / investigation_id / "lifecycle.json"
            self.assertTrue(sidecar.exists())
            with sidecar.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            self.assertEqual(raw["archived"], True)
            self.assertEqual(raw["archived_at"], saved["archived_at"])

            reloaded = lifecycle_state(store.sessions_dir, investigation_id)
            self.assertEqual(reloaded["archived_at"], saved["archived_at"])
            self.assertTrue(reloaded["archived"])

    def test_soft_delete_timestamp_round_trips(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _make_store(temp_dir)
            investigation_id = _seed_investigation(store)
            saved = soft_delete_investigation(
                store.sessions_dir, investigation_id, reason="duplicate"
            )
            reloaded = lifecycle_state(store.sessions_dir, investigation_id)
            self.assertEqual(reloaded["deleted_at"], saved["deleted_at"])
            self.assertEqual(reloaded["deleted_reason"], "duplicate")
            self.assertTrue(reloaded["deleted"])


if __name__ == "__main__":
    unittest.main()
