from __future__ import annotations

from copy import deepcopy
from typing import Any


OBSERVATION_TYPES: list[dict[str, Any]] = [
    {
        "id": "felt_presence",
        "label": "Felt presence",
        "description": "Subjective sense of being watched or accompanied.",
        "default_intensity": 3,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "cold_spot",
        "label": "Cold spot",
        "description": "Localized pocket of cold air without an obvious source.",
        "default_intensity": 3,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "temperature_drop",
        "label": "Temperature drop",
        "description": "Noticeable decrease in ambient temperature.",
        "default_intensity": 3,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "temperature_rise",
        "label": "Temperature rise",
        "description": "Noticeable increase in ambient temperature.",
        "default_intensity": 3,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "evp_heard",
        "label": "EVP heard",
        "description": "Suspected electronic voice phenomenon noticed in the moment.",
        "default_intensity": 4,
        "suggests_media": "audio",
        "category": "audio",
    },
    {
        "id": "voice_heard",
        "label": "Voice heard",
        "description": "Disembodied voice or speech without an apparent speaker.",
        "default_intensity": 4,
        "suggests_media": "audio",
        "category": "audio",
    },
    {
        "id": "knocks_taps",
        "label": "Knocks or taps",
        "description": "Percussive knocks, taps, or rapping noises.",
        "default_intensity": 3,
        "suggests_media": "audio",
        "category": "audio",
    },
    {
        "id": "footsteps_heard",
        "label": "Footsteps heard",
        "description": "Footstep-like sounds with no visible walker.",
        "default_intensity": 3,
        "suggests_media": "audio",
        "category": "audio",
    },
    {
        "id": "physical_touch",
        "label": "Physical touch",
        "description": "Tactile sensation of being touched, brushed, or pulled.",
        "default_intensity": 4,
        "suggests_media": None,
        "category": "physical",
    },
    {
        "id": "visual_anomaly",
        "label": "Visual anomaly",
        "description": "Unexplained light, mist, or distortion seen by an investigator.",
        "default_intensity": 3,
        "suggests_media": "image",
        "category": "visual",
    },
    {
        "id": "shadow_figure",
        "label": "Shadow figure",
        "description": "Dark, humanoid silhouette observed without a clear source.",
        "default_intensity": 4,
        "suggests_media": "image",
        "category": "visual",
    },
    {
        "id": "object_movement",
        "label": "Object movement",
        "description": "Object visibly moves, falls, or shifts on its own.",
        "default_intensity": 4,
        "suggests_media": "image",
        "category": "physical",
    },
    {
        "id": "equipment_interference",
        "label": "Equipment interference",
        "description": "Unexpected behavior in cameras, recorders, lights, or other gear.",
        "default_intensity": 3,
        "suggests_media": None,
        "category": "equipment",
    },
    {
        "id": "smell_anomaly",
        "label": "Smell anomaly",
        "description": "Sudden, unexplained odor (sweet, sulfurous, perfume, smoke).",
        "default_intensity": 2,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "emotional_response",
        "label": "Emotional response",
        "description": "Strong, sudden emotional shift such as dread, sadness, or elation.",
        "default_intensity": 2,
        "suggests_media": None,
        "category": "sensory",
    },
    {
        "id": "general",
        "label": "General observation",
        "description": "Anything noteworthy that does not match a more specific category.",
        "default_intensity": 2,
        "suggests_media": None,
        "category": "other",
    },
]


def list_observation_types() -> list[dict[str, Any]]:
    return deepcopy(OBSERVATION_TYPES)


def find_observation_type(type_id: str) -> dict[str, Any]:
    for entry in OBSERVATION_TYPES:
        if entry["id"] == type_id:
            return deepcopy(entry)
    raise KeyError(f"Observation type not found: {type_id}")


def build_observation_event(
    *,
    observation_type: str,
    title: str | None = None,
    intensity: int | None = None,
    description: str | None = None,
    timestamp: str | None = None,
    linked_media_id: str | None = None,
) -> dict[str, Any]:
    type_entry = find_observation_type(observation_type)

    resolved_intensity = intensity if intensity is not None else type_entry["default_intensity"]
    if not isinstance(resolved_intensity, int) or isinstance(resolved_intensity, bool):
        raise ValueError("Observation intensity must be an integer between 1 and 5.")
    if resolved_intensity < 1 or resolved_intensity > 5:
        raise ValueError("Observation intensity must be between 1 and 5 inclusive.")

    resolved_title = title if title is not None else type_entry["label"]
    if not isinstance(resolved_title, str) or not resolved_title.strip():
        raise ValueError("Observation title must be a non-empty string.")
    resolved_title = resolved_title.strip()

    return {
        "source": "user",
        "event_type": "observation",
        "title": resolved_title,
        "description": description,
        "timestamp": timestamp,
        "metadata": {
            "observation_type": type_entry["id"],
            "category": type_entry["category"],
            "intensity": resolved_intensity,
            "default_label": type_entry["label"],
            "linked_media_id": linked_media_id,
        },
    }
