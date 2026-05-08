from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SIDECAR_NAME = "lifecycle.json"


def _default_state() -> dict[str, Any]:
    return {
        "archived": False,
        "archived_at": None,
        "deleted": False,
        "deleted_at": None,
        "deleted_reason": None,
    }


def _sidecar_path(sessions_dir: Path, investigation_id: str) -> Path:
    return Path(sessions_dir) / investigation_id / _SIDECAR_NAME


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise(raw: Any) -> dict[str, Any]:
    state = _default_state()
    if not isinstance(raw, dict):
        return state
    archived = raw.get("archived")
    if isinstance(archived, bool):
        state["archived"] = archived
    archived_at = raw.get("archived_at")
    if isinstance(archived_at, str) and archived_at:
        state["archived_at"] = archived_at
    deleted = raw.get("deleted")
    if isinstance(deleted, bool):
        state["deleted"] = deleted
    deleted_at = raw.get("deleted_at")
    if isinstance(deleted_at, str) and deleted_at:
        state["deleted_at"] = deleted_at
    deleted_reason = raw.get("deleted_reason")
    if isinstance(deleted_reason, str):
        state["deleted_reason"] = deleted_reason
    return state


def lifecycle_state(sessions_dir: Path, investigation_id: str) -> dict[str, Any]:
    """Return the lifecycle state dict for an investigation, defaulting if absent."""
    path = _sidecar_path(sessions_dir, investigation_id)
    if not path.exists():
        return _default_state()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return _default_state()
    if not raw.strip():
        return _default_state()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return _default_state()
    return _normalise(data)


def archive_investigation(sessions_dir: Path, investigation_id: str) -> dict[str, Any]:
    """Mark an investigation as archived. Refuses if currently soft-deleted."""
    state = lifecycle_state(sessions_dir, investigation_id)
    if state["deleted"]:
        raise ValueError("Cannot archive a deleted investigation; restore it first")
    state["archived"] = True
    state["archived_at"] = _utc_now_iso()
    _save_state(sessions_dir, investigation_id, state)
    return state


def restore_investigation(sessions_dir: Path, investigation_id: str) -> dict[str, Any]:
    """Clear archived and deleted flags. Idempotent."""
    state = lifecycle_state(sessions_dir, investigation_id)
    state["archived"] = False
    state["archived_at"] = None
    state["deleted"] = False
    state["deleted_at"] = None
    state["deleted_reason"] = None
    _save_state(sessions_dir, investigation_id, state)
    return state


def soft_delete_investigation(
    sessions_dir: Path,
    investigation_id: str,
    *,
    reason: str | None = None,
) -> dict[str, Any]:
    """Mark an investigation as soft-deleted. Supersedes any prior archive flag."""
    state = lifecycle_state(sessions_dir, investigation_id)
    state["deleted"] = True
    state["deleted_at"] = _utc_now_iso()
    state["deleted_reason"] = reason
    state["archived"] = False
    state["archived_at"] = None
    _save_state(sessions_dir, investigation_id, state)
    return state


def hard_delete_investigation(
    store: Any,
    sessions_dir: Path,
    investigation_id: str,
    *,
    confirm: bool = False,
) -> dict[str, Any]:
    """Permanently remove an investigation from the store and disk.

    Requires ``confirm=True`` and a prior soft delete.
    """
    if not confirm:
        raise PermissionError("Hard delete requires confirm=True")
    state = lifecycle_state(sessions_dir, investigation_id)
    if not state["deleted"]:
        raise ValueError(
            "Cannot hard-delete an investigation that is not soft-deleted; "
            "soft delete it first"
        )

    with store.connect() as db:
        db.execute(
            "DELETE FROM sensor_samples WHERE investigation_id = ?",
            (investigation_id,),
        )
        db.execute(
            "DELETE FROM evidence_events WHERE investigation_id = ?",
            (investigation_id,),
        )
        db.execute(
            "DELETE FROM media_assets WHERE investigation_id = ?",
            (investigation_id,),
        )
        db.execute(
            "DELETE FROM investigations WHERE id = ?",
            (investigation_id,),
        )

    session_dir = Path(sessions_dir) / investigation_id
    removed_session_dir = False
    if session_dir.exists():
        shutil.rmtree(session_dir, ignore_errors=False)
        removed_session_dir = True

    return {
        "investigation_id": investigation_id,
        "hard_deleted_at": _utc_now_iso(),
        "removed_session_dir": removed_session_dir,
    }


def filter_investigations(
    investigations: list[dict[str, Any]],
    sessions_dir: Path,
    *,
    include_archived: bool = False,
    include_deleted: bool = False,
) -> list[dict[str, Any]]:
    """Filter investigations by lifecycle state and attach a ``lifecycle`` key."""
    result: list[dict[str, Any]] = []
    for entry in investigations:
        investigation_id = entry.get("id")
        if not isinstance(investigation_id, str) or not investigation_id:
            continue
        state = lifecycle_state(sessions_dir, investigation_id)
        if state["deleted"] and not include_deleted:
            continue
        if state["archived"] and not include_archived:
            continue
        decorated = dict(entry)
        decorated["lifecycle"] = state
        result.append(decorated)
    return result


def _save_state(
    sessions_dir: Path,
    investigation_id: str,
    state: dict[str, Any],
) -> None:
    path = _sidecar_path(sessions_dir, investigation_id)
    _atomic_write_json(path, state)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(handle.name, path)
    except Exception:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise
