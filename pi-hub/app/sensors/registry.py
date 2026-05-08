from __future__ import annotations

from .mock import MockSensor
from .sense_hat import SenseHatSensor


class SensorRegistry:
    def __init__(self, preferred_provider: str | None = None):
        self.providers = [SenseHatSensor(), MockSensor()]
        self.preferred_provider = preferred_provider

    def active_provider(self):
        if self.preferred_provider:
            for provider in self.providers:
                if provider.name == self.preferred_provider and provider.available():
                    return provider

        for provider in self.providers:
            if provider.available() and provider.name != "mock":
                return provider

        return self.providers[-1]

    def status(self) -> dict:
        active = self.active_provider()
        return {
            "active_provider": active.name,
            "providers": [provider.status() for provider in self.providers],
        }

    def read(self) -> list[dict]:
        return self.active_provider().read()
