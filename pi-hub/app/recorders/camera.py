from __future__ import annotations

import hashlib
import struct
import zlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.store import InvestigationStore, utc_now


class PlaceholderCameraRecorder:
    """Creates a valid still image when Pi camera hardware is not available."""

    def __init__(
        self,
        store: InvestigationStore,
        width: int = 640,
        height: int = 360,
        metadata: dict[str, Any] | None = None,
    ):
        self.store = store
        self.width = width
        self.height = height
        self.metadata = {
            "recorder": "placeholder_camera",
            "dimensions": {"width": width, "height": height},
            "placeholder": True,
            "format": "png",
            "note": "Placeholder PNG until Raspberry Pi camera capture is enabled.",
        }
        self.metadata.update(metadata or {})

    def capture_still(self, investigation_id: str) -> dict:
        media_dir = self.store.session_dir(investigation_id) / "media" / "camera"
        media_dir.mkdir(parents=True, exist_ok=True)
        image_path = media_dir / "placeholder.png"
        timestamp = utc_now()

        self._write_placeholder_png(image_path)

        return self.store.add_media_asset(
            investigation_id=investigation_id,
            media_type="image",
            file_path="media/camera/placeholder.png",
            timestamp_start=timestamp,
            timestamp_end=utc_now(),
            checksum=self._sha256(image_path),
            metadata=self.metadata,
        )

    def _write_placeholder_png(self, path: Path) -> None:
        rows = []
        for y in range(self.height):
            row = bytearray()
            for x in range(self.width):
                shade = 24 + int(38 * (x / max(self.width - 1, 1)))
                pulse = 26 if (x + y) % 37 == 0 else 0
                row.extend((shade + pulse, 46 + pulse, 58 + pulse))
            rows.append(b"\x00" + bytes(row))
        path.write_bytes(_png_bytes(self.width, self.height, b"".join(rows)))

    def _sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


class PiCameraRecorder:
    """Production-shaped still capture using picamera2 when available on Raspberry Pi."""

    def __init__(
        self,
        store: InvestigationStore,
        picamera2_cls: type,
        width: int = 1280,
        height: int = 720,
    ):
        self.store = store
        self.picamera2_cls = picamera2_cls
        self.width = width
        self.height = height
        self.metadata = {
            "recorder": "picamera2",
            "dimensions": {"width": width, "height": height},
            "placeholder": False,
            "format": "png",
        }

    def capture_still(self, investigation_id: str) -> dict:
        media_dir = self.store.session_dir(investigation_id) / "media" / "camera"
        media_dir.mkdir(parents=True, exist_ok=True)
        image_path = media_dir / "still.png"
        timestamp = utc_now()

        camera = self.picamera2_cls()
        config = camera.create_still_configuration(main={"size": (self.width, self.height)})
        camera.configure(config)
        camera.start()
        try:
            camera.capture_file(str(image_path))
        finally:
            camera.stop()

        return self.store.add_media_asset(
            investigation_id=investigation_id,
            media_type="image",
            file_path="media/camera/still.png",
            timestamp_start=timestamp,
            timestamp_end=utc_now(),
            checksum=self._sha256(image_path),
            metadata=self.metadata,
        )

    def _sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


def create_camera_recorder(
    store: InvestigationStore,
    prefer_pi: bool = True,
    backend_loader: Callable[[], type | None] | None = None,
) -> PlaceholderCameraRecorder | PiCameraRecorder:
    loader = backend_loader or _load_picamera2
    if prefer_pi:
        picamera2_cls = loader()
        if picamera2_cls is not None:
            return PiCameraRecorder(store, picamera2_cls)
        return PlaceholderCameraRecorder(
            store,
            metadata={
                "fallback_reason": "picamera2_unavailable",
                "intended_recorder": "picamera2",
            },
        )
    return PlaceholderCameraRecorder(store)


def _load_picamera2() -> type | None:
    try:
        from picamera2 import Picamera2
    except ImportError:
        return None
    return Picamera2


def _png_bytes(width: int, height: int, raw_scanlines: bytes) -> bytes:
    def chunk(chunk_type: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + chunk_type
            + payload
            + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw_scanlines)) + chunk(
        b"IEND", b""
    )
