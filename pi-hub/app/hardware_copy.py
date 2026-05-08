from __future__ import annotations

from copy import deepcopy
from typing import Any


PROVIDER_COPY: dict[str, dict[str, Any]] = {
    "mock": {
        "friendly_label": "Mobile / standalone mode",
        "friendly_description": "Synthetic readings - perfect for review, manual logging, and phone-only investigations.",
        "is_pi_hardware": False,
    },
    "sense_hat": {
        "friendly_label": "Raspberry Pi Sense HAT",
        "friendly_description": "Live environmental capture from the Pi's built-in sensors.",
        "is_pi_hardware": True,
    },
}

_STANDALONE_HINT = (
    "Connect a Raspberry Pi 5 with a Sense HAT to add live sensor capture. "
    "Standalone use is fully supported."
)


def _provider_copy_for(name: str) -> dict[str, Any]:
    if name in PROVIDER_COPY:
        return deepcopy(PROVIDER_COPY[name])
    label = name.replace("_", " ").title() if name else "Sensor source"
    return {
        "friendly_label": label,
        "friendly_description": "Active sensor source.",
        "is_pi_hardware": False,
    }


def enrich_hardware_status(status: dict[str, Any]) -> dict[str, Any]:
    enriched = deepcopy(status)
    active = enriched.get("active_provider")

    providers = enriched.get("providers") or []
    enriched_providers: list[dict[str, Any]] = []
    for provider in providers:
        provider_dict = dict(provider)
        copy = _provider_copy_for(provider_dict.get("name", ""))
        provider_dict["friendly_label"] = copy["friendly_label"]
        provider_dict["friendly_description"] = copy["friendly_description"]
        provider_dict["is_pi_hardware"] = copy["is_pi_hardware"]
        enriched_providers.append(provider_dict)
    enriched["providers"] = enriched_providers

    is_standalone = active == "mock" or active is None
    if is_standalone:
        active_copy = _provider_copy_for(active or "mock")
        enriched["mode"] = "standalone"
        enriched["mode_label"] = active_copy["friendly_label"]
        enriched["mode_description"] = active_copy["friendly_description"]
        enriched["pi_hint"] = _STANDALONE_HINT
    else:
        active_copy = _provider_copy_for(active)
        enriched["mode"] = "pi_enhanced"
        enriched["mode_label"] = "Pi-enhanced capture"
        enriched["mode_description"] = active_copy["friendly_description"]
        enriched["pi_hint"] = None

    return enriched
