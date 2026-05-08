from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


def build_review_windows(
    anomalies: list[dict[str, Any]],
    events: list[dict[str, Any]],
    media: list[dict[str, Any]],
    window_seconds: int = 30,
) -> list[dict[str, Any]]:
    windows = []
    for anomaly in anomalies:
        center = _parse_timestamp(anomaly.get("timestamp"))
        if center is None:
            continue
        start = center - timedelta(seconds=window_seconds)
        end = center + timedelta(seconds=window_seconds)
        windows.append(
            {
                "timestamp": anomaly.get("timestamp"),
                "start": start.isoformat(),
                "end": end.isoformat(),
                "severity": anomaly.get("severity"),
                "title": f"{anomaly.get('sensor_type', 'sensor')} anomaly",
                "reason": anomaly.get("reason"),
                "anomaly": anomaly,
                "events": [_strip_internal(event) for event in events if _inside(event.get("timestamp"), start, end)],
                "media": [
                    _strip_internal(asset)
                    for asset in media
                    if _inside(asset.get("timestamp_start") or asset.get("timestamp"), start, end)
                ],
            }
        )
    return windows


def _inside(timestamp: Any, start: datetime, end: datetime) -> bool:
    parsed = _parse_timestamp(timestamp)
    return parsed is not None and start <= parsed <= end


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _strip_internal(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.startswith("_")}
