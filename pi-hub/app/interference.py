from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


INTERFERENCE_ITEMS: list[dict] = [
    {
        "id": "hvac_off",
        "label": "HVAC / fans switched off",
        "description": "HVAC blowers and fans add broadband noise that masks low-level audio anomalies.",
        "category": "acoustic",
        "weight": 3,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "traffic_audible",
        "label": "Traffic audible from the location",
        "description": "Passing vehicles produce low-frequency rumble that contaminates audio and seismic baselines.",
        "category": "acoustic",
        "weight": 2,
        "desired_answer": "no",
        "default_answer": "no",
    },
    {
        "id": "voices_audible",
        "label": "People audible nearby",
        "description": "Conversation or footsteps from other people can be misread as anomalous voices.",
        "category": "acoustic",
        "weight": 3,
        "desired_answer": "no",
        "default_answer": "no",
    },
    {
        "id": "phones_airplane_mode",
        "label": "Phones in airplane mode",
        "description": "Cellular and Bluetooth radios cause spikes in EMF and audio interference patterns.",
        "category": "electromagnetic",
        "weight": 2,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "wifi_disabled",
        "label": "Wifi access points disabled",
        "description": "Wifi radios broadcast steady RF that biases EMF readings; many sites cannot disable wifi.",
        "category": "electromagnetic",
        "weight": 1,
        "desired_answer": "yes",
        "default_answer": "no",
    },
    {
        "id": "local_devices_minimised",
        "label": "Local electronics minimised",
        "description": "Nearby chargers, fluorescent lights, and motors create localised EMF that masks anomalies.",
        "category": "electromagnetic",
        "weight": 2,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "weather_severe",
        "label": "Severe weather active",
        "description": "Thunder, heavy rain, or high wind drive false positives across audio and pressure sensors.",
        "category": "environmental",
        "weight": 1,
        "desired_answer": "no",
        "default_answer": "no",
    },
    {
        "id": "temperature_stable",
        "label": "Room temperature stable",
        "description": "Thermal drift skews IR and temperature deltas during the session window.",
        "category": "environmental",
        "weight": 1,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "location_sealed",
        "label": "Doors and windows closed and known",
        "description": "Open or unknown apertures admit drafts, sound, and uncatalogued people.",
        "category": "environmental",
        "weight": 2,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "equipment_self_check",
        "label": "All gear powered, charged, and tested",
        "description": "Self-check confirms every recorder, sensor, and battery is healthy before the session.",
        "category": "equipment",
        "weight": 3,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "baseline_captured",
        "label": "Calibration baseline captured",
        "description": "A clean baseline lets the analysis distinguish anomalies from ambient steady state.",
        "category": "procedure",
        "weight": 3,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
    {
        "id": "time_logged",
        "label": "Session start time logged",
        "description": "An accurate start time is required for cross-recorder synchronisation downstream.",
        "category": "procedure",
        "weight": 1,
        "desired_answer": "yes",
        "default_answer": "yes",
    },
]


_REQUIRED_KEYS = (
    "id",
    "label",
    "description",
    "category",
    "weight",
    "desired_answer",
    "default_answer",
)

_VALID_CATEGORIES = {"acoustic", "electromagnetic", "environmental", "equipment", "procedure"}

_YES_TOKENS = {"yes", "y", "true", "1"}
_NO_TOKENS = {"no", "n", "false", "0"}
_NULL_TOKENS = {"", "unsure", "u", "unknown", "skip"}


def list_interference_items() -> list[dict]:
    return deepcopy(INTERFERENCE_ITEMS)


def find_interference_item(item_id: str) -> dict:
    for item in INTERFERENCE_ITEMS:
        if item["id"] == item_id:
            return deepcopy(item)
    raise KeyError(f"Interference item not found: {item_id}")


def normalize_answer(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        if value == 1:
            return "yes"
        if value == 0:
            return "no"
        raise ValueError(f"Invalid interference answer: {value!r}")
    if isinstance(value, str):
        token = value.strip().lower()
        if token in _NULL_TOKENS:
            return None
        if token in _YES_TOKENS:
            return "yes"
        if token in _NO_TOKENS:
            return "no"
        raise ValueError(f"Invalid interference answer: {value!r}")
    raise ValueError(f"Invalid interference answer: {value!r}")


def compute_interference_score(answers: dict[str, object]) -> dict[str, Any]:
    items_payload: list[dict[str, Any]] = []
    total_weight = 0
    answered_weight = 0
    ok_weight = 0
    ok_count = 0
    issue_count = 0
    unanswered_count = 0

    for item in INTERFERENCE_ITEMS:
        item_id = item["id"]
        weight = int(item["weight"])
        desired = item["desired_answer"]
        total_weight += weight

        raw_answer = answers.get(item_id) if isinstance(answers, dict) else None
        try:
            answer = normalize_answer(raw_answer)
        except ValueError:
            answer = None

        if answer is None:
            status = "unanswered"
            unanswered_count += 1
        elif answer == desired:
            status = "ok"
            ok_count += 1
            ok_weight += weight
            answered_weight += weight
        else:
            status = "issue"
            issue_count += 1
            answered_weight += weight

        items_payload.append(
            {
                "id": item_id,
                "label": item["label"],
                "category": item["category"],
                "weight": weight,
                "answer": answer,
                "desired_answer": desired,
                "status": status,
            }
        )

    if answered_weight > 0:
        score = int(round((ok_weight / answered_weight) * 100))
    else:
        score = 0

    if total_weight > 0:
        coverage = int(round((answered_weight / total_weight) * 100))
    else:
        coverage = 0

    return {
        "score": score,
        "coverage": coverage,
        "issue_count": issue_count,
        "ok_count": ok_count,
        "unanswered_count": unanswered_count,
        "items": items_payload,
    }


def save_interference_responses(
    sessions_dir: Path,
    investigation_id: str,
    *,
    answers: dict[str, object],
    notes: str | None = None,
) -> dict[str, Any]:
    target_dir = Path(sessions_dir) / investigation_id
    target_dir.mkdir(parents=True, exist_ok=True)

    normalized: dict[str, str | None] = {}
    if isinstance(answers, dict):
        for key, value in answers.items():
            try:
                normalized[str(key)] = normalize_answer(value)
            except ValueError:
                normalized[str(key)] = None

    payload: dict[str, Any] = {
        "answers": normalized,
        "notes": notes,
        "computed": compute_interference_score(normalized),
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }

    path = target_dir / "interference.json"
    _atomic_write_json(path, payload)
    return payload


def load_interference_responses(
    sessions_dir: Path,
    investigation_id: str,
) -> dict[str, Any] | None:
    path = Path(sessions_dir) / investigation_id / "interference.json"
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def has_acceptable_interference(
    sessions_dir: Path,
    investigation_id: str,
    *,
    threshold: int = 70,
    min_coverage: int = 70,
) -> bool:
    record = load_interference_responses(sessions_dir, investigation_id)
    if record is None:
        return False
    computed = record.get("computed") or {}
    score = int(computed.get("score", 0) or 0)
    coverage = int(computed.get("coverage", 0) or 0)
    return score >= threshold and coverage >= min_coverage


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
