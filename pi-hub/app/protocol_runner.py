from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .protocols import get_protocol


def start_protocol_run(
    sessions_dir: Path,
    investigation_id: str,
    *,
    protocol_id: str,
) -> dict[str, Any]:
    """Begin a new protocol run for ``investigation_id``.

    The first step is marked ``in_progress`` immediately. Raises
    ``RuntimeError`` if a run already exists for this investigation.
    """
    path = _state_path(sessions_dir, investigation_id)
    if path.exists():
        raise RuntimeError(
            "A protocol run is already in progress for this investigation; "
            "finish or cancel it first"
        )

    protocol = get_protocol(protocol_id)
    raw_steps = protocol.get("steps") or []
    started_at = _now()

    steps: list[dict[str, Any]] = []
    for index, raw_step in enumerate(raw_steps):
        title = str(raw_step.get("title", ""))
        description = raw_step.get("description")
        if description is None:
            description = raw_step.get("instructions")
        step_entry: dict[str, Any] = {
            "title": title,
            "description": description if description is None else str(description),
            "status": "in_progress" if index == 0 else "pending",
            "started_at": started_at if index == 0 else None,
            "completed_at": None,
            "note": None,
        }
        steps.append(step_entry)

    state: dict[str, Any] = {
        "protocol_id": protocol_id,
        "started_at": started_at,
        "completed_at": None,
        "current_step_index": 0,
        "step_count": len(steps),
        "steps": steps,
    }

    if not steps:
        state["completed_at"] = started_at

    _atomic_write_json(path, state)
    return state


def get_protocol_run(
    sessions_dir: Path,
    investigation_id: str,
) -> dict[str, Any] | None:
    """Return the saved run state, or ``None`` if no run exists."""
    path = _state_path(sessions_dir, investigation_id)
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def advance_protocol_step(
    sessions_dir: Path,
    investigation_id: str,
    *,
    note: str | None = None,
) -> dict[str, Any]:
    """Mark the current step complete and move on to the next."""
    return _bump_current_step(
        sessions_dir,
        investigation_id,
        terminal_status="complete",
        note=note,
    )


def skip_protocol_step(
    sessions_dir: Path,
    investigation_id: str,
    *,
    note: str | None = None,
) -> dict[str, Any]:
    """Mark the current step skipped and move on to the next."""
    return _bump_current_step(
        sessions_dir,
        investigation_id,
        terminal_status="skipped",
        note=note,
    )


def annotate_protocol_step(
    sessions_dir: Path,
    investigation_id: str,
    *,
    step_index: int,
    note: str,
) -> dict[str, Any]:
    """Replace the ``note`` on a specific step without changing its status."""
    state = get_protocol_run(sessions_dir, investigation_id)
    if state is None:
        raise RuntimeError("No active protocol run")

    steps = state.get("steps") or []
    if step_index < 0 or step_index >= len(steps):
        raise IndexError(
            f"step_index {step_index} out of range for {len(steps)} step(s)"
        )

    steps[step_index]["note"] = note
    path = _state_path(sessions_dir, investigation_id)
    _atomic_write_json(path, state)
    return state


def cancel_protocol_run(sessions_dir: Path, investigation_id: str) -> None:
    """Idempotently delete the run state file."""
    path = _state_path(sessions_dir, investigation_id)
    try:
        path.unlink()
    except FileNotFoundError:
        return


def is_run_complete(state: dict[str, Any] | None) -> bool:
    """``True`` once ``state`` records a ``completed_at`` timestamp."""
    if not isinstance(state, dict):
        return False
    return bool(state.get("completed_at"))


def _bump_current_step(
    sessions_dir: Path,
    investigation_id: str,
    *,
    terminal_status: str,
    note: str | None,
) -> dict[str, Any]:
    state = get_protocol_run(sessions_dir, investigation_id)
    if state is None:
        raise RuntimeError("No active protocol run")
    if state.get("completed_at"):
        raise RuntimeError("Protocol run already complete")

    steps = state.get("steps") or []
    step_count = int(state.get("step_count", len(steps)) or 0)
    current_index = int(state.get("current_step_index", 0) or 0)

    if current_index < 0 or current_index >= len(steps):
        raise RuntimeError("Protocol run already complete")

    now = _now()
    current_step = steps[current_index]
    current_step["status"] = terminal_status
    current_step["completed_at"] = now
    if note is not None:
        current_step["note"] = note

    next_index = current_index + 1
    state["current_step_index"] = next_index

    if next_index >= step_count:
        state["completed_at"] = now
    else:
        next_step = steps[next_index]
        next_step["status"] = "in_progress"
        next_step["started_at"] = now

    path = _state_path(sessions_dir, investigation_id)
    _atomic_write_json(path, state)
    return state


def _state_path(sessions_dir: Path, investigation_id: str) -> Path:
    return Path(sessions_dir) / investigation_id / "protocol_run.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
