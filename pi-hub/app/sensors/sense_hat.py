from __future__ import annotations

from typing import Any


class SenseHatSensor:
    name = "sense_hat"
    label = "Raspberry Pi Sense HAT"

    def __init__(self) -> None:
        self._sense: Any | None = None
        self._error: str | None = None
        try:
            from sense_hat import SenseHat  # type: ignore

            self._sense = SenseHat()
        except Exception as error:  # pragma: no cover - depends on Pi hardware/library
            self._error = str(error)

    def available(self) -> bool:
        return self._sense is not None

    def status(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "available": self.available(),
            "detail": "Available" if self.available() else self._error or "sense-hat library not installed",
        }

    def read(self) -> list[dict]:
        if self._sense is None:
            return []

        orientation = self._sense.get_orientation_radians()
        acceleration = self._sense.get_accelerometer_raw()
        compass = self._sense.get_compass_raw()
        return [
            {
                "sensor_type": "temperature",
                "value": float(self._sense.get_temperature()),
                "unit": "C",
                "metadata": {"source": self.name},
            },
            {
                "sensor_type": "humidity",
                "value": float(self._sense.get_humidity()),
                "unit": "%",
                "metadata": {"source": self.name},
            },
            {
                "sensor_type": "pressure",
                "value": float(self._sense.get_pressure()),
                "unit": "hPa",
                "metadata": {"source": self.name},
            },
            {
                "sensor_type": "magnetometer",
                "x": float(compass["x"]),
                "y": float(compass["y"]),
                "z": float(compass["z"]),
                "unit": "uT",
                "metadata": {"source": self.name},
            },
            {
                "sensor_type": "accelerometer",
                "x": float(acceleration["x"]),
                "y": float(acceleration["y"]),
                "z": float(acceleration["z"]),
                "unit": "g",
                "metadata": {"source": self.name},
            },
            {
                "sensor_type": "orientation",
                "x": float(orientation["pitch"]),
                "y": float(orientation["roll"]),
                "z": float(orientation["yaw"]),
                "unit": "rad",
                "metadata": {"source": self.name},
            },
        ]
