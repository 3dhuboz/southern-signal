from __future__ import annotations

import math
import random
import time


class MockSensor:
    """Deterministic-ish readings for development away from the Pi."""

    name = "mock"
    label = "Mock development sensors"

    def available(self) -> bool:
        return True

    def status(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "available": True,
            "detail": "Synthetic readings for development and dashboard testing.",
        }

    def read(self) -> list[dict]:
        tick = time.time()
        wobble = math.sin(tick / 7)
        return [
            {"sensor_type": "temperature", "value": 21.0 + wobble, "unit": "C", "metadata": {"source": "mock"}},
            {"sensor_type": "humidity", "value": 48.0 + wobble * 3, "unit": "%", "metadata": {"source": "mock"}},
            {"sensor_type": "pressure", "value": 1012.0 + wobble, "unit": "hPa", "metadata": {"source": "mock"}},
            {
                "sensor_type": "mock_magnetometer",
                "x": random.uniform(-2, 2),
                "y": random.uniform(-2, 2),
                "z": random.uniform(-2, 2),
                "value": 45.0 + random.uniform(-1.5, 1.5),
                "unit": "uT",
                "metadata": {"source": "mock"},
            },
        ]
