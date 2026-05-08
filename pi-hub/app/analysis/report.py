from __future__ import annotations

from typing import Any

from app.analysis.anomalies import detect_sensor_anomalies
from app.analysis.blind_review import compute_blind_review_agreement
from app.analysis.calibration import (
    calibration_ok as _calibration_ok,
    load_calibration,
)
from app.analysis.review_windows import build_review_windows
from app.analysis.scoring import score_evidence
from app.interference import has_acceptable_interference, load_interference_responses
from app.store import InvestigationStore


def build_evidence_report(store: InvestigationStore, investigation_id: str) -> dict[str, Any]:
    investigation = store.get_investigation(investigation_id)
    samples = store.list_sensor_samples(investigation_id)
    events = store.list_events(investigation_id)
    media = store.list_media_assets(investigation_id)
    anomalies = detect_sensor_anomalies(samples)
    review_windows = build_review_windows(anomalies, events, media)

    calibration_record = load_calibration(store.sessions_dir, investigation_id)
    calibration_passed = _calibration_ok(store.sessions_dir, investigation_id)

    interference_record = load_interference_responses(
        store.sessions_dir, investigation_id
    )
    interference_passed = has_acceptable_interference(
        store.sessions_dir, investigation_id
    )
    interference_score: int | None
    if interference_record is None:
        interference_score = None
    else:
        computed = interference_record.get("computed") or {}
        raw_score = computed.get("score")
        if raw_score is None:
            interference_score = None
        else:
            try:
                interference_score = int(raw_score)
            except (TypeError, ValueError):
                interference_score = None

    blind_review_agreement = compute_blind_review_agreement(
        store, store.sessions_dir, investigation_id
    )
    blind_reviewer_agreement_count = int(
        blind_review_agreement.get("blind_reviewer_agreement_count", 0) or 0
    )

    confidence = score_evidence(
        {
            "audio_spike": _has_audio_signal(anomalies),
            "sensor_correlation_count": len({anomaly["sensor_type"] for anomaly in anomalies}),
            "media_support": bool(media),
            "unattended_room": _mentions(events, "unattended"),
            "blind_reviewer_agreement_count": blind_reviewer_agreement_count,
            "contamination_count": _contamination_count(events),
            "calibration_ok": calibration_passed,
            "interference_ok": interference_passed,
            "interference_score": interference_score,
            "sync_confidence": 0.85 if samples and media else 0.6 if samples else 0.0,
        }
    )

    return {
        "investigation": investigation,
        "counts": {
            "samples": len(samples),
            "events": len(events),
            "media": len(media),
            "anomalies": len(anomalies),
        },
        "anomalies": anomalies,
        "events": events,
        "media": media,
        "confidence": confidence,
        "review_windows": review_windows,
        "review_next_steps": _next_steps(anomalies, media),
        "calibration": calibration_record,
        "interference": interference_record,
        "blind_review_agreement": blind_review_agreement,
    }


def _has_audio_signal(anomalies: list[dict[str, Any]]) -> bool:
    return any("audio" in str(anomaly.get("sensor_type", "")).lower() for anomaly in anomalies)


def _contamination_count(events: list[dict[str, Any]]) -> int:
    return sum(1 for event in events if _event_contains(event, "contamination"))


def _mentions(events: list[dict[str, Any]], text: str) -> bool:
    return any(_event_contains(event, text) for event in events)


def _event_contains(event: dict[str, Any], text: str) -> bool:
    needle = text.lower()
    haystack = " ".join(str(event.get(key) or "") for key in ("event_type", "title", "description")).lower()
    return needle in haystack


def _next_steps(anomalies: list[dict[str, Any]], media: list[dict[str, Any]]) -> list[str]:
    steps = []
    if anomalies:
        steps.append("Replay the highest-severity anomaly windows against audio, image, and timeline markers.")
    else:
        steps.append("Capture a longer baseline or run a prompted EVP protocol to create review windows.")

    if media:
        steps.append("Check media timestamps against anomaly timestamps before interpreting the event.")
    else:
        steps.append("Capture still images or audio around future anomalies to improve evidence quality.")

    steps.append("Tag ordinary causes immediately: footsteps, speech, wind, cable movement, doors, and nearby electronics.")
    return steps
