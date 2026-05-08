from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import fmean, pstdev
from typing import Any


def compute_calibration(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarise calibration samples per sensor type.

    Each input sample is shaped like a row from ``InvestigationStore.list_sensor_samples``.
    Samples without a usable scalar metric are ignored when computing per-sensor stats,
    but their timestamps still count toward the overall window.
    """
    streams: dict[str, list[float]] = defaultdict(list)
    units: dict[str, str | None] = {}
    timestamps: list[str] = []
    sample_count = 0

    for sample in samples:
        sample_count += 1
        timestamp = sample.get("timestamp")
        if isinstance(timestamp, str) and timestamp:
            timestamps.append(timestamp)

        metric_value = _metric_value(sample)
        if metric_value is None:
            continue

        sensor_type = str(sample.get("sensor_type", "unknown"))
        streams[sensor_type].append(metric_value)
        unit = sample.get("unit")
        if sensor_type not in units and unit is not None:
            units[sensor_type] = unit

    sensors: dict[str, dict[str, Any]] = {}
    for sensor_type, values in streams.items():
        count = len(values)
        mean = fmean(values) if values else 0.0
        stdev = pstdev(values) if count >= 2 else 0.0
        sensor_summary: dict[str, Any] = {
            "count": count,
            "mean": mean,
            "stdev": stdev,
            "min": min(values) if values else 0.0,
            "max": max(values) if values else 0.0,
        }
        unit = units.get(sensor_type)
        if unit is not None:
            sensor_summary["unit"] = unit
        sensors[sensor_type] = sensor_summary

    started_at = min(timestamps) if timestamps else None
    ended_at = max(timestamps) if timestamps else None
    duration_seconds = _duration_seconds(started_at, ended_at)

    return {
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_seconds": duration_seconds,
        "sample_count": sample_count,
        "sensors": sensors,
    }


def assess_calibration(
    calibration: dict[str, Any],
    *,
    min_samples: int = 30,
    min_sensors: int = 1,
    max_stdev_ratio: float = 0.2,
) -> dict[str, Any]:
    """Decide whether a calibration baseline is healthy enough to trust."""
    reasons: list[str] = []
    sample_count = int(calibration.get("sample_count", 0) or 0)
    sensors = calibration.get("sensors") or {}

    if sample_count < min_samples:
        reasons.append(
            f"Only {sample_count} sample(s) captured; need at least {min_samples}."
        )

    if len(sensors) < min_sensors:
        reasons.append(
            f"Only {len(sensors)} sensor stream(s) present; need at least {min_sensors}."
        )

    for sensor_type, summary in sensors.items():
        mean = float(summary.get("mean", 0.0) or 0.0)
        stdev = float(summary.get("stdev", 0.0) or 0.0)
        if mean == 0.0:
            continue
        ratio = stdev / abs(mean)
        if ratio > max_stdev_ratio:
            reasons.append(
                f"{sensor_type} baseline noisy: stdev/mean ratio {ratio:.2f} "
                f"exceeds {max_stdev_ratio:.2f}."
            )

    return {"calibration_ok": not reasons, "reasons": reasons}


def save_calibration(
    sessions_dir: Path,
    investigation_id: str,
    calibration: dict[str, Any],
) -> Path:
    """Persist the calibration record (merged with assessment) as JSON."""
    target_dir = Path(sessions_dir) / investigation_id
    target_dir.mkdir(parents=True, exist_ok=True)
    payload = dict(calibration)
    assessment = assess_calibration(calibration)
    payload["calibration_ok"] = assessment["calibration_ok"]
    payload["reasons"] = assessment["reasons"]
    path = target_dir / "calibration.json"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
    return path


def load_calibration(sessions_dir: Path, investigation_id: str) -> dict[str, Any] | None:
    """Return the saved calibration record, or ``None`` when none exists."""
    path = Path(sessions_dir) / investigation_id / "calibration.json"
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def calibration_ok(sessions_dir: Path, investigation_id: str) -> bool:
    """Convenience helper for evidence scoring."""
    record = load_calibration(sessions_dir, investigation_id)
    if record is None:
        return False
    return bool(record.get("calibration_ok", False))


def _metric_value(sample: dict[str, Any]) -> float | None:
    value = sample.get("value")
    if value is not None:
        return _float_or_none(value)
    if all(axis in sample for axis in ("x", "y", "z")):
        x = _float_or_none(sample.get("x"))
        y = _float_or_none(sample.get("y"))
        z = _float_or_none(sample.get("z"))
        if x is None or y is None or z is None:
            return None
        return math.sqrt(x * x + y * y + z * z)
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _duration_seconds(started_at: str | None, ended_at: str | None) -> float:
    if not started_at or not ended_at:
        return 0.0
    from datetime import datetime

    try:
        start_dt = datetime.fromisoformat(started_at)
        end_dt = datetime.fromisoformat(ended_at)
    except ValueError:
        return 0.0
    delta = (end_dt - start_dt).total_seconds()
    return max(0.0, delta)
