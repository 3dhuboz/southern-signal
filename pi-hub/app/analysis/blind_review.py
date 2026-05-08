from __future__ import annotations

import json
import os
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


_INSTRUCTIONS = (
    "Blind EVP review.\n"
    "Listen to each audio asset from the start to the end without referring to "
    "the original investigator's notes or markers.\n"
    "When you perceive a possible voice, knock, or other anomalous sound, "
    "submit the wall-clock timestamp at which you heard it.\n"
    "Optional fields: a short label, a confidence rating from 1 (faint) to 5 "
    "(unmistakable), and the audio asset id you were listening to.\n"
    "Submitting an empty list of perceived events is a valid response: "
    "'I heard nothing' is data."
)


def start_blind_review(
    store: Any,
    investigation_id: str,
    *,
    reviewer_id: str | None = None,
) -> dict[str, Any]:
    """Seed a blind review session by surfacing audio assets only.

    The returned payload deliberately omits event markers, observation events,
    and any timestamp metadata that would tell the reviewer where to listen.
    """
    store.get_investigation(investigation_id)

    resolved_reviewer_id = reviewer_id or str(uuid.uuid4())

    audio_assets: list[dict[str, Any]] = []
    for asset in store.list_media_assets(investigation_id):
        if asset.get("media_type") != "audio":
            continue
        timestamp_start = asset.get("timestamp_start")
        timestamp_end = asset.get("timestamp_end")
        audio_assets.append(
            {
                "id": asset.get("id"),
                "media_type": "audio",
                "file_path": asset.get("file_path"),
                "timestamp_start": timestamp_start,
                "timestamp_end": timestamp_end,
                "duration_seconds": _duration_seconds(timestamp_start, timestamp_end),
            }
        )

    return {
        "investigation_id": investigation_id,
        "reviewer_id": resolved_reviewer_id,
        "started_at": _utc_now_iso(),
        "audio_assets": audio_assets,
        "instructions": _INSTRUCTIONS,
    }


def submit_blind_review(
    store: Any,
    sessions_dir: Path,
    investigation_id: str,
    *,
    reviewer_id: str,
    perceived_events: list[dict[str, Any]],
    notes: str | None = None,
) -> dict[str, Any]:
    """Persist a blind reviewer's perceptions for an investigation."""
    store.get_investigation(investigation_id)

    if not isinstance(perceived_events, list):
        raise ValueError("perceived_events must be a list")

    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(perceived_events):
        if not isinstance(entry, dict):
            raise ValueError(f"perceived_events[{index}] must be an object")
        timestamp = entry.get("timestamp")
        if not isinstance(timestamp, str) or not timestamp:
            raise ValueError(
                f"perceived_events[{index}] is missing a timestamp"
            )
        if _parse_timestamp(timestamp) is None:
            raise ValueError(
                f"perceived_events[{index}] has malformed timestamp: {timestamp!r}"
            )

        normalized_entry: dict[str, Any] = {"timestamp": timestamp}

        media_id = entry.get("media_id")
        if media_id is not None:
            normalized_entry["media_id"] = str(media_id)

        label = entry.get("label")
        if label is not None:
            normalized_entry["label"] = str(label)

        if "confidence" in entry and entry.get("confidence") is not None:
            confidence_raw = entry.get("confidence")
            try:
                confidence_value = int(confidence_raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    f"perceived_events[{index}] confidence must be an integer 1-5"
                ) from exc
            if confidence_value < 1 or confidence_value > 5:
                raise ValueError(
                    f"perceived_events[{index}] confidence must be in range 1-5"
                )
            normalized_entry["confidence"] = confidence_value

        normalized.append(normalized_entry)

    submitted_at = _utc_now_iso()
    payload: dict[str, Any] = {
        "reviewer_id": reviewer_id,
        "submitted_at": submitted_at,
        "perceived_events": normalized,
        "notes": notes,
    }

    target_dir = Path(sessions_dir) / investigation_id / "blind_reviews"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{reviewer_id}.json"
    _atomic_write_json(target_path, payload)
    return payload


def list_blind_reviews(
    sessions_dir: Path,
    investigation_id: str,
) -> list[dict[str, Any]]:
    """Return all submitted blind reviews for an investigation, sorted by submission time."""
    target_dir = Path(sessions_dir) / investigation_id / "blind_reviews"
    if not target_dir.exists():
        return []

    reviews: list[dict[str, Any]] = []
    for path in sorted(target_dir.glob("*.json")):
        try:
            with path.open("r", encoding="utf-8") as handle:
                review = json.load(handle)
        except (OSError, ValueError):
            continue
        if isinstance(review, dict):
            reviews.append(review)

    reviews.sort(key=lambda review: str(review.get("submitted_at") or ""))
    return reviews


def compute_blind_review_agreement(
    store: Any,
    sessions_dir: Path,
    investigation_id: str,
    *,
    tolerance_seconds: int = 5,
) -> dict[str, Any]:
    """Score how well blind reviewers agreed with the original markers."""
    markers = [
        event
        for event in store.list_events(investigation_id)
        if event.get("event_type") in ("marker", "observation")
    ]
    marker_entries: list[tuple[datetime, str]] = []
    for marker in markers:
        parsed = _parse_timestamp(marker.get("timestamp"))
        if parsed is None:
            continue
        marker_entries.append((parsed, str(marker.get("id"))))
    marker_entries.sort(key=lambda item: item[0])
    marker_count = len(marker_entries)

    reviews = list_blind_reviews(sessions_dir, investigation_id)
    reviewer_count = len(reviews)

    review_summaries: list[dict[str, Any]] = []
    matched_marker_ids_by_reviewer: list[set[str]] = []
    total_matches = 0

    for review in reviews:
        perceived = review.get("perceived_events") or []
        perceived_entries: list[datetime] = []
        for entry in perceived:
            if not isinstance(entry, dict):
                continue
            parsed = _parse_timestamp(entry.get("timestamp"))
            if parsed is None:
                continue
            perceived_entries.append(parsed)
        perceived_entries.sort()
        perceived_count = len(perceived_entries)

        matched_count, matched_ids = _greedy_match(
            perceived_entries, marker_entries, tolerance_seconds
        )

        false_positive_count = perceived_count - matched_count
        missed_marker_count = marker_count - matched_count

        if marker_count == 0 and perceived_count == 0:
            agreement_percent = 100
        else:
            denominator = max(marker_count, perceived_count)
            if denominator == 0:
                agreement_percent = 0
            else:
                agreement_percent = int(round(matched_count / denominator * 100))

        review_summaries.append(
            {
                "reviewer_id": review.get("reviewer_id"),
                "submitted_at": review.get("submitted_at"),
                "perceived_count": perceived_count,
                "matched_count": matched_count,
                "false_positive_count": false_positive_count,
                "missed_marker_count": missed_marker_count,
                "agreement_percent": agreement_percent,
            }
        )
        matched_marker_ids_by_reviewer.append(matched_ids)
        total_matches += matched_count

    if reviewer_count >= 2:
        consensus_ids: set[str] = set(matched_marker_ids_by_reviewer[0])
        for matched_ids in matched_marker_ids_by_reviewer[1:]:
            consensus_ids &= matched_ids
        marker_order = {marker_id: index for index, (_, marker_id) in enumerate(marker_entries)}
        consensus_marker_ids = sorted(consensus_ids, key=lambda mid: marker_order.get(mid, 0))
    else:
        consensus_marker_ids = []

    return {
        "tolerance_seconds": tolerance_seconds,
        "marker_count": marker_count,
        "reviewer_count": reviewer_count,
        "reviews": review_summaries,
        "blind_reviewer_agreement_count": total_matches,
        "consensus_marker_ids": consensus_marker_ids,
    }


def _greedy_match(
    perceived: list[datetime],
    markers: list[tuple[datetime, str]],
    tolerance_seconds: int,
) -> tuple[int, set[str]]:
    """Greedy nearest-match between perceived timestamps and markers.

    Each perceived event matches at most one marker and vice versa. Both
    inputs must already be sorted by time.
    """
    matched_ids: set[str] = set()
    if not perceived or not markers:
        return 0, matched_ids

    used_marker_indexes: set[int] = set()
    perceived_index = 0
    marker_index = 0
    tolerance = float(tolerance_seconds)

    while perceived_index < len(perceived) and marker_index < len(markers):
        perceived_time = perceived[perceived_index]
        # Advance marker pointer past markers that can no longer match.
        while marker_index < len(markers):
            marker_time, _ = markers[marker_index]
            if (perceived_time - marker_time).total_seconds() > tolerance:
                marker_index += 1
                continue
            break
        if marker_index >= len(markers):
            break

        # Find the closest still-unused marker within tolerance.
        best_offset: int | None = None
        best_delta: float | None = None
        offset = 0
        while marker_index + offset < len(markers):
            candidate_index = marker_index + offset
            marker_time, _ = markers[candidate_index]
            delta_seconds = (marker_time - perceived_time).total_seconds()
            if delta_seconds > tolerance:
                break
            if candidate_index in used_marker_indexes:
                offset += 1
                continue
            absolute_delta = abs(delta_seconds)
            if absolute_delta <= tolerance and (
                best_delta is None or absolute_delta < best_delta
            ):
                best_offset = offset
                best_delta = absolute_delta
            offset += 1

        if best_offset is not None:
            chosen_index = marker_index + best_offset
            used_marker_indexes.add(chosen_index)
            matched_ids.add(markers[chosen_index][1])

        perceived_index += 1

    return len(matched_ids), matched_ids


def _atomic_write_json(target_path: Path, payload: dict[str, Any]) -> None:
    target_dir = target_path.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(target_dir),
        prefix=".blind_review-",
        suffix=".tmp",
        delete=False,
    )
    try:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.replace(handle.name, target_path)


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    cleaned = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(cleaned)
    except ValueError:
        return None


def _duration_seconds(
    timestamp_start: Any,
    timestamp_end: Any,
) -> float | None:
    start = _parse_timestamp(timestamp_start)
    end = _parse_timestamp(timestamp_end)
    if start is None or end is None:
        return None
    delta = (end - start).total_seconds()
    if delta < 0:
        return 0.0
    return delta
