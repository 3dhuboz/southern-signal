from __future__ import annotations

import hashlib
import wave
from pathlib import Path
from typing import Any, Callable

from app.store import InvestigationStore, utc_now


class SilentWavRecorder:
    """Creates a valid WAV asset when no microphone backend is available yet."""

    def __init__(
        self,
        store: InvestigationStore,
        sample_rate: int = 16000,
        metadata_overrides: dict[str, Any] | None = None,
    ):
        self.store = store
        self.sample_rate = sample_rate
        self.metadata = {
            "recorder": "silent_placeholder",
            "sample_rate": self.sample_rate,
            "channels": 1,
            "note": "Placeholder WAV until USB microphone recording is enabled.",
        }
        if metadata_overrides:
            self.metadata.update(metadata_overrides)

    def record_placeholder(self, investigation_id: str, duration_seconds: int = 1) -> dict:
        media_dir = self.store.session_dir(investigation_id) / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        audio_path = media_dir / "audio.wav"
        timestamp_start = utc_now()

        self._write_silent_wav(audio_path, duration_seconds)
        checksum = self._sha256(audio_path)
        timestamp_end = utc_now()

        return self.store.add_media_asset(
            investigation_id=investigation_id,
            media_type="audio",
            file_path="media/audio.wav",
            timestamp_start=timestamp_start,
            timestamp_end=timestamp_end,
            checksum=checksum,
            metadata=self.metadata,
        )

    def _write_silent_wav(self, path: Path, duration_seconds: int) -> None:
        frames = b"\x00\x00" * self.sample_rate * duration_seconds
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(frames)

    def _sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


class UsbMicrophoneWavRecorder:
    """Records a WAV file through an optional sounddevice-compatible backend."""

    def __init__(
        self,
        store: InvestigationStore,
        backend: Any,
        sample_rate: int = 48000,
        channels: int = 1,
        device: int | str | None = None,
    ):
        self.store = store
        self.backend = backend
        self.sample_rate = sample_rate
        self.channels = channels
        self.device = device
        self.metadata = {
            "recorder": "usb_microphone",
            "backend": "sounddevice",
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "device": self.device,
        }

    def record(self, investigation_id: str, duration_seconds: int = 60) -> dict:
        media_dir = self.store.session_dir(investigation_id) / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        audio_path = media_dir / "audio.wav"
        timestamp_start = utc_now()

        frames = self.backend.rec(
            int(self.sample_rate * duration_seconds),
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            device=self.device,
        )
        self.backend.wait()
        self._write_wav(audio_path, frames)

        checksum = self._sha256(audio_path)
        timestamp_end = utc_now()
        return self.store.add_media_asset(
            investigation_id=investigation_id,
            media_type="audio",
            file_path="media/audio.wav",
            timestamp_start=timestamp_start,
            timestamp_end=timestamp_end,
            checksum=checksum,
            metadata=self.metadata,
        )

    def record_placeholder(self, investigation_id: str, duration_seconds: int = 60) -> dict:
        return self.record(investigation_id, duration_seconds=duration_seconds)

    def _write_wav(self, path: Path, frames: Any) -> None:
        frame_bytes = frames.tobytes() if hasattr(frames, "tobytes") else bytes(frames)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(self.channels)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(frame_bytes)

    def _sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


AudioBackendLoader = Callable[[], Any | None]


def create_audio_recorder(
    store: InvestigationStore,
    *,
    prefer_real: bool = True,
    backend_loader: AudioBackendLoader | None = None,
) -> SilentWavRecorder | UsbMicrophoneWavRecorder:
    if not prefer_real:
        return SilentWavRecorder(store)

    loader = backend_loader or _load_sounddevice_backend
    backend = loader()
    if backend is not None and _backend_has_input_device(backend):
        return UsbMicrophoneWavRecorder(store, backend)

    return SilentWavRecorder(
        store,
        metadata_overrides={
            "fallback_reason": "microphone_backend_unavailable",
            "intended_recorder": "usb_microphone",
        },
    )


def _load_sounddevice_backend() -> Any | None:
    try:
        import sounddevice  # type: ignore[import-not-found]
    except Exception:
        return None
    return sounddevice


def _backend_has_input_device(backend: Any) -> bool:
    query_devices = getattr(backend, "query_devices", None)
    if query_devices is None:
        return True

    try:
        devices = query_devices()
    except Exception:
        return False

    if isinstance(devices, dict):
        return int(devices.get("max_input_channels", 0) or 0) > 0

    try:
        return any(int(device.get("max_input_channels", 0) or 0) > 0 for device in devices)
    except TypeError:
        return False
