from __future__ import annotations

from typing import Any

from app.analysis.anomalies import detect_sensor_anomalies
from app.analysis.review_windows import build_review_windows
from app.analysis.scoring import score_evidence
from app.store import InvestigationStore


def build_evidence_report(store: InvestigationStore, investigation_id: str) -> dict[str, Any]:
    investigation = store.get_investigation(investigation_id)
    samples = store.list_sensor_samples(investigation_id)
    events = store.list_events(investigation_id)
    media = store.list_media_assets(investigation_id)
    anomalies = detect_sensor_anomalies(samples)
    review_windows = build_review_windows(anomalies, events, media)
    confidence = score_evidence(
        {
            "audio_spike": _has_audio_signal(anomalies),
            "sensor_correlation_count": len({anomaly["sensor_type"] for anomaly in anomalies}),
            "media_support": bool(media),
            "unattended_room": _mentions(events, "unattended"),
            "blind_reviewer_agreement_count": 0,
            "contamination_count": _contamination_count(events),
            "calibration_ok": _mentions(events, "calibration passed") or bool(samples),
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
