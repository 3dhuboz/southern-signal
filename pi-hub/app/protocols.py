from __future__ import annotations

from copy import deepcopy


PROTOCOLS = {
    "baseline": {
        "id": "baseline",
        "title": "Baseline Investigation",
        "description": "Capture normal room behaviour before looking for anomalies.",
        "steps": [
            {
                "title": "Set room state",
                "duration_seconds": 60,
                "instructions": "Place the Pi hub, stop unnecessary movement, and note doors, windows, devices, and people present.",
            },
            {
                "title": "Quiet-room capture",
                "duration_seconds": 120,
                "instructions": "Record silence while capturing audio, video, magnetic, vibration, and environmental readings.",
            },
            {
                "title": "Controlled movement",
                "duration_seconds": 60,
                "instructions": "Walk once through the room and tag expected footsteps, floorboards, and clothing noise.",
            },
            {
                "title": "Interference sweep",
                "duration_seconds": 60,
                "instructions": "Move phone, battery pack, lights, and known electronics near the hub to map false positives.",
            },
            {
                "title": "Review baseline",
                "duration_seconds": 60,
                "instructions": "Confirm noise floor, sensor drift, and known contamination sources before the main session.",
            },
        ],
    },
    "prompted_evp": {
        "id": "prompted_evp",
        "title": "Prompted EVP Session",
        "description": "Structured question-and-silence protocol for cleaner EVP review.",
        "steps": [
            {
                "title": "Opening silence",
                "duration_seconds": 30,
                "instructions": "Record silence before any questions to establish the audio floor.",
            },
            {
                "title": "Ask question 1",
                "duration_seconds": 10,
                "instructions": "Ask one clear question, then stop speaking.",
            },
            {
                "title": "Response silence 1",
                "duration_seconds": 30,
                "instructions": "Keep everyone silent and still. Tag any known sounds immediately.",
            },
            {
                "title": "Ask question 2",
                "duration_seconds": 10,
                "instructions": "Ask a second clear question.",
            },
            {
                "title": "Response silence 2",
                "duration_seconds": 30,
                "instructions": "Keep the room still. Let the app mark this as a review window.",
            },
            {
                "title": "Closing silence",
                "duration_seconds": 30,
                "instructions": "Record final silence for comparison.",
            },
        ],
    },
    "unattended_room": {
        "id": "unattended_room",
        "title": "Unattended Room Watch",
        "description": "Leave the Pi hub recording in an empty room to reduce human contamination.",
        "steps": [
            {
                "title": "Setup and exit",
                "duration_seconds": 60,
                "instructions": "Place the hub, start recording, tag setup sounds, and leave the room.",
            },
            {
                "title": "Empty-room watch",
                "duration_seconds": 600,
                "instructions": "Keep the room empty while audio, camera, and sensors record continuously.",
            },
            {
                "title": "Return and tag",
                "duration_seconds": 60,
                "instructions": "Re-enter, tag return sounds, and stop the session.",
            },
        ],
    },
}


def list_protocols() -> list[dict]:
    return [
        {
            "id": protocol["id"],
            "title": protocol["title"],
            "description": protocol["description"],
            "step_count": len(protocol["steps"]),
            "duration_seconds": sum(step["duration_seconds"] for step in protocol["steps"]),
        }
        for protocol in PROTOCOLS.values()
    ]


def get_protocol(protocol_id: str) -> dict:
    if protocol_id not in PROTOCOLS:
        raise KeyError(f"Protocol not found: {protocol_id}")
    return deepcopy(PROTOCOLS[protocol_id])
