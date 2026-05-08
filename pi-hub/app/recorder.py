from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .recorders.audio import create_audio_recorder
from .recorders.camera import create_camera_recorder
from .sensors.registry import SensorRegistry
from .store import InvestigationStore


@dataclass
class RunningSession:
    investigation_id: str
    task: asyncio.Task


class RecorderManager:
    def __init__(self, store: InvestigationStore, interval_seconds: float = 1.0):
        self.store = store
        self.interval_seconds = interval_seconds
        self.sensors = SensorRegistry()
        self.audio = create_audio_recorder(store)
        self.camera = create_camera_recorder(store)
        self.running: dict[str, RunningSession] = {}

    async def start(self, investigation_id: str) -> None:
        if investigation_id in self.running:
            return
        self.store.start_investigation(investigation_id)
        self.audio.record_placeholder(investigation_id, duration_seconds=1)
        self.camera.capture_still(investigation_id)
        task = asyncio.create_task(self._sample_loop(investigation_id))
        self.running[investigation_id] = RunningSession(investigation_id, task)

    async def stop(self, investigation_id: str) -> None:
        running = self.running.pop(investigation_id, None)
        if running:
            running.task.cancel()
            try:
                await running.task
            except asyncio.CancelledError:
                pass
        self.store.stop_investigation(investigation_id)

    def is_running(self, investigation_id: str) -> bool:
        return investigation_id in self.running

    def live_snapshot(self) -> list[dict]:
        return self.sensors.read()

    def hardware_status(self) -> dict:
        return self.sensors.status()

    def capture_still(self, investigation_id: str) -> dict:
        return self.camera.capture_still(investigation_id)

    async def _sample_loop(self, investigation_id: str) -> None:
        while True:
            for reading in self.sensors.read():
                self.store.add_sensor_sample(investigation_id=investigation_id, **reading)
            await asyncio.sleep(self.interval_seconds)
