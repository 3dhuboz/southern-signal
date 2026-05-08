from __future__ import annotations

from typing import Protocol


class SensorProvider(Protocol):
    name: str
    label: str

    def available(self) -> bool:
        ...

    def status(self) -> dict:
        ...

    def read(self) -> list[dict]:
        ...
