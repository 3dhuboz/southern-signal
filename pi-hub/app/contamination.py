from __future__ import annotations

from copy import deepcopy


CONTAMINATION_TAGS = [
    {"id": "footstep", "label": "Footstep", "group": "human"},
    {"id": "speech", "label": "Speech", "group": "human"},
    {"id": "breath", "label": "Breath or mic handling", "group": "human"},
    {"id": "phone_movement", "label": "Phone movement", "group": "equipment"},
    {"id": "cable_movement", "label": "Cable movement", "group": "equipment"},
    {"id": "nearby_electronics", "label": "Nearby electronics", "group": "equipment"},
    {"id": "door", "label": "Door or latch", "group": "environment"},
    {"id": "wind", "label": "Wind", "group": "environment"},
    {"id": "vehicle", "label": "Vehicle", "group": "environment"},
    {"id": "animal", "label": "Animal", "group": "environment"},
    {"id": "unknown", "label": "Unknown contamination", "group": "unknown"},
]

ALIASES = {
    "footsteps": "footstep",
    "steps": "footstep",
    "whisper": "speech",
    "clothing": "speech",
    "phone": "phone_movement",
    "power_interference": "nearby_electronics",
    "pi_bump": "phone_movement",
    "plumbing": "door",
}


def get_contamination_tags() -> list[dict]:
    return deepcopy(CONTAMINATION_TAGS)


def get_contamination_tag(tag_id: str) -> dict | None:
    canonical_id = ALIASES.get(tag_id, tag_id)
    return next((tag for tag in CONTAMINATION_TAGS if tag["id"] == canonical_id), None)


def find_contamination_tag(tag_id: str) -> dict:
    tag = get_contamination_tag(tag_id)
    if tag is None:
        raise KeyError(f"Contamination tag not found: {tag_id}")
    return deepcopy(tag)


def find_contamination_tag(tag_id: str) -> dict:
    tag = get_contamination_tag(tag_id)
    if tag is None:
        raise KeyError(f"Contamination tag not found: {tag_id}")
    return deepcopy(tag)
