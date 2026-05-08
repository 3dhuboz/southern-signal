from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


_MAX_MINUTES = 24 * 60


def parse_duration_minutes(value: int | float | str | None) -> int | None:
    """Normalise a user-supplied duration into a positive integer of minutes.

    Returns ``None`` when the input is ``None`` or an empty string. Numeric
    strings are coerced to floats and rounded half-up to the nearest int.
    Zero, negative, non-numeric, or excessively large values raise
    ``ValueError``.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("target_minutes must be numeric, not a boolean")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError as exc:
            raise ValueError(f"target_minutes must be numeric: {value!r}") from exc
    elif isinstance(value, (int, float)):
        number = float(value)
    else:
        raise ValueError(f"target_minutes must be numeric: {value!r}")

    if not math.isfinite(number):
        raise ValueError("target_minutes must be a finite number")

    minutes = int(math.floor(number + 0.5))
    if minutes <= 0:
        raise ValueError("target_minutes must be a positive integer (got <= 0)")
    if minutes > _MAX_MINUTES:
        raise ValueError(
            f"target_minutes must be <= {_MAX_MINUTES} (one day); got {minutes}"
        )
    return minutes


def compute_target_end(started_at: str, target_minutes: int) -> str:
    """Return the ISO-8601 UTC timestamp ``target_minutes`` after ``started_at``."""
    start_dt = _parse_iso(started_at)
    end_dt = start_dt + timedelta(minutes=int(target_minutes))
    return _format_iso(end_dt)


def elapsed_seconds(started_at: str, now: str | None = None) -> int:
    """Whole seconds elapsed between ``started_at`` and ``now`` (clamped >= 0)."""
    start_dt = _parse_iso(started_at)
    now_dt = _resolve_now(now)
    delta = (now_dt - start_dt).total_seconds()
    if delta <= 0:
        return 0
    return int(math.floor(delta))


def remaining_seconds(target_end: str, now: str | None = None) -> int:
    """Whole seconds remaining until ``target_end`` (clamped >= 0)."""
    end_dt = _parse_iso(target_end)
    now_dt = _resolve_now(now)
    delta = (end_dt - now_dt).total_seconds()
    if delta <= 0:
        return 0
    return int(math.floor(delta))


def is_complete(target_end: str | None, now: str | None = None) -> bool:
    """``True`` once ``now`` reaches or passes ``target_end``."""
    if target_end is None:
        return False
    end_dt = _parse_iso(target_end)
    now_dt = _resolve_now(now)
    return now_dt >= end_dt


def save_duration_target(
    sessions_dir: Path,
    investigation_id: str,
    *,
    target_minutes: int | None,
    started_at: str | None = None,
) -> dict[str, Any]:
    """Persist (or clear) the duration target for an investigation.

    Passing ``target_minutes=None`` removes any existing target file. When a
    target is supplied without ``started_at``, ``target_end`` is left ``None``
    and resolved later once the session actually starts.
    """
    target_dir = Path(sessions_dir) / investigation_id

    if target_minutes is None:
        clear_duration_target(sessions_dir, investigation_id)
        return {
            "target_minutes": None,
            "target_end": None,
            "started_at": started_at,
        }

    minutes = int(target_minutes)
    target_end: str | None = None
    if started_at:
        target_end = compute_target_end(started_at, minutes)

    payload: dict[str, Any] = {
        "target_minutes": minutes,
        "target_end": target_end,
        "started_at": started_at,
    }

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "duration.json"
    _atomic_write_json(path, payload)
    return payload


def load_duration_target(
    sessions_dir: Path,
    investigation_id: str,
) -> dict[str, Any] | None:
    """Return the saved duration target dict, or ``None`` if absent/empty."""
    path = Path(sessions_dir) / investigation_id / "duration.json"
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


def clear_duration_target(sessions_dir: Path, investigation_id: str) -> None:
    """Idempotently remove the duration target file for an investigation."""
    path = Path(sessions_dir) / investigation_id / "duration.json"
    try:
        path.unlink()
    except FileNotFoundError:
        return


def status_for(
    target: dict[str, Any] | None,
    now: str | None = None,
) -> dict[str, Any]:
    """Project a saved (or absent) target into the live status shape."""
    if target is None:
        return {
            "target_minutes": None,
            "started_at": None,
            "target_end": None,
            "elapsed_seconds": None,
            "remaining_seconds": None,
            "complete": False,
        }

    target_minutes = target.get("target_minutes")
    started_at = target.get("started_at")
    target_end = target.get("target_end")
    if target_end is None and started_at and isinstance(target_minutes, int):
        target_end = compute_target_end(started_at, target_minutes)

    elapsed: int | None = None
    if isinstance(started_at, str) and started_at:
        elapsed = elapsed_seconds(started_at, now=now)

    remaining: int | None = None
    if isinstance(target_end, str) and target_end:
        remaining = remaining_seconds(target_end, now=now)

    complete = is_complete(target_end, now=now)

    return {
        "target_minutes": target_minutes if isinstance(target_minutes, int) else None,
        "started_at": started_at if isinstance(started_at, str) else None,
        "target_end": target_end if isinstance(target_end, str) else None,
        "elapsed_seconds": elapsed,
        "remaining_seconds": remaining,
        "complete": complete,
    }


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _format_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _resolve_now(now: str | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return _parse_iso(now)


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
