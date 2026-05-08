from __future__ import annotations

import math
from collections import defaultdict
from statistics import median
from typing import Any


def detect_sensor_anomalies(samples: list[dict[str, Any]], min_baseline_samples: int = 5) -> list[dict[str, Any]]:
    streams: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        metric_value = _metric_value(sample)
        if metric_value is None:
            continue
        enriched = dict(sample)
        enriched["_metric_value"] = metric_value
        enriched["_metric"] = "magnitude" if _has_axes(sample) and sample.get("value") is None else "value"
        streams[str(sample.get("sensor_type", "unknown"))].append(enriched)

    anomalies: list[dict[str, Any]] = []
    for sensor_type, stream_samples in streams.items():
        if len(stream_samples) < min_baseline_samples:
            continue

        values = [sample["_metric_value"] for sample in stream_samples]
        baseline = median(values)
        deviations = [abs(value - baseline) for value in values]
        mad = median(deviations) or 0.0
        threshold = max(5.0, mad * 8)

        for sample in stream_samples:
            deviation = abs(sample["_metric_value"] - baseline)
            if deviation <= threshold:
                continue

            anomalies.append(
                {
                    "timestamp": sample.get("timestamp"),
                    "sensor_type": sensor_type,
                    "metric": sample["_metric"],
                    "value": sample["_metric_value"],
                    "baseline": baseline,
                    "deviation": deviation,
                    "unit": sample.get("unit"),
                    "severity": _severity(deviation, threshold),
                    "reason": f"{sensor_type} deviated from local baseline by {deviation:.2f}.",
                }
            )

    return sorted(anomalies, key=lambda anomaly: str(anomaly.get("timestamp", "")))


def _metric_value(sample: dict[str, Any]) -> float | None:
    if sample.get("value") is not None:
        return _float_or_none(sample.get("value"))
    if _has_axes(sample):
        x = _float_or_none(sample.get("x"))
        y = _float_or_none(sample.get("y"))
        z = _float_or_none(sample.get("z"))
        if x is None or y is None or z is None:
            return None
        return math.sqrt(x * x + y * y + z * z)
    return None


def _has_axes(sample: dict[str, Any]) -> bool:
    return all(axis in sample for axis in ("x", "y", "z"))


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _severity(deviation: float, threshold: float) -> str:
    if deviation >= threshold * 3:
        return "high"
    if deviation >= threshold * 1.75:
        return "medium"
    return "low"
