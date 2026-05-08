"""Evidence confidence scoring for paranormal investigation events.

This module scores how well an event was captured and cross-checked. It does
not decide whether an event is paranormal.
"""

from __future__ import annotations

from typing import Any


def score_evidence(context: dict[str, Any]) -> dict[str, Any]:
    """Score an event context and explain the result in plain English."""
    audio_spike = bool(context.get("audio_spike", False))
    sensor_correlation_count = _non_negative_int(context.get("sensor_correlation_count", 0))
    media_support = bool(context.get("media_support", False))
    unattended_room = bool(context.get("unattended_room", False))
    blind_reviewer_agreement_count = _non_negative_int(
        context.get("blind_reviewer_agreement_count", 0)
    )
    contamination_count = _non_negative_int(context.get("contamination_count", 0))
    calibration_ok = bool(context.get("calibration_ok", False))
    interference_ok = bool(context.get("interference_ok", False))
    interference_score_raw = context.get("interference_score")
    interference_score: int | None
    if interference_score_raw is None:
        interference_score = None
    else:
        try:
            interference_score = int(interference_score_raw)
        except (TypeError, ValueError):
            interference_score = None
    sync_confidence = _clamp_float(context.get("sync_confidence", 0.0), 0.0, 1.0)

    score = 0
    reasons: list[str] = []

    if audio_spike:
        score += 15
        reasons.append("Audio spike was detected around the event.")
    else:
        reasons.append("No audio spike was detected around the event.")

    if sensor_correlation_count:
        sensor_points = min(sensor_correlation_count, 4) * 12
        score += sensor_points
        reasons.append(
            f"{sensor_correlation_count} sensor stream(s) changed at the same time."
        )
    else:
        reasons.append("No independent sensor streams changed with the event.")

    if media_support:
        score += 15
        reasons.append("Photo, video, or audio media supports the event.")
    else:
        reasons.append("No supporting media was attached to the event.")

    if unattended_room:
        score += 10
        reasons.append("The room was marked unattended, reducing handling contamination.")
    else:
        reasons.append("The room was not marked unattended during the event.")

    if blind_reviewer_agreement_count:
        reviewer_points = min(blind_reviewer_agreement_count, 3) * 8
        score += reviewer_points
        reasons.append(
            f"{blind_reviewer_agreement_count} blind reviewer(s) independently agreed."
        )
    else:
        reasons.append("No blind reviewer agreement was recorded.")

    if contamination_count:
        penalty = min(contamination_count * 12, 36)
        score -= penalty
        reasons.append(
            f"{contamination_count} contamination flag(s) reduce confidence."
        )
    else:
        reasons.append("No contamination flags were recorded.")

    if not calibration_ok:
        score -= 18
        reasons.append("Calibration was missing or failed, reducing confidence.")
    else:
        reasons.append("Calibration checks passed.")

    if interference_score is not None:
        if interference_ok:
            score += 15
            reasons.append(
                f"Interference checklist passed (score: {interference_score}/100)"
            )
        else:
            score -= 15
            reasons.append(
                f"Interference checklist below threshold (score: {interference_score}/100)"
            )

    if sync_confidence < 0.5:
        score -= 15
        reasons.append("Sync confidence was poor, so timing correlations are weaker.")
    elif sync_confidence < 0.75:
        score -= 7
        reasons.append("Sync confidence was only fair, so timing correlations are limited.")
    else:
        reasons.append("Sync confidence was high enough for timeline correlation.")

    final_score = int(round(_clamp_float(score, 0, 100)))
    return {
        "score": final_score,
        "label": _label_for_score(final_score),
        "reasons": reasons,
    }


def _label_for_score(score: int) -> str:
    if score >= 75:
        return "strong"
    if score >= 40:
        return "moderate"
    return "weak"


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _clamp_float(value: Any, minimum: float, maximum: float) -> float:
    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        numeric_value = minimum
    return max(minimum, min(maximum, numeric_value))
