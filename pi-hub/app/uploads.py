from __future__ import annotations

import hashlib
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


ALLOWED_AUDIO_EXTENSIONS: set[str] = {".wav", ".mp3", ".m4a", ".ogg", ".webm"}
ALLOWED_IMAGE_EXTENSIONS: set[str] = {".png", ".jpg", ".jpeg", ".webp", ".heic"}

_AUDIO_CONTENT_TYPE_MAP: dict[str, str] = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".m4a",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
}

_IMAGE_CONTENT_TYPE_MAP: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heic",
}

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9.\-]+")


def _split_extension(name: str) -> tuple[str, str]:
    base = os.path.basename(name.replace("\\", "/"))
    base = base.lstrip(".")
    if "." in base:
        stem, _, ext = base.rpartition(".")
        return stem, "." + ext.lower()
    return base, ""


def detect_media_kind(filename: str, content_type: str | None = None) -> str:
    _, extension = _split_extension(filename)
    if extension:
        if extension in ALLOWED_AUDIO_EXTENSIONS:
            return "audio"
        if extension in ALLOWED_IMAGE_EXTENSIONS:
            return "image"
        raise ValueError(f"Unsupported upload extension: {extension}")

    if content_type:
        normalized = content_type.split(";")[0].strip().lower()
        if normalized in _AUDIO_CONTENT_TYPE_MAP:
            return "audio"
        if normalized in _IMAGE_CONTENT_TYPE_MAP:
            return "image"
        if normalized.startswith("audio/"):
            return "audio"
        if normalized.startswith("image/"):
            return "image"
        raise ValueError(f"Unsupported upload content type: {content_type}")

    raise ValueError("Cannot determine media kind without filename extension or content type.")


def safe_upload_filename(original: str, *, fallback_kind: str = "upload") -> str:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    base = os.path.basename((original or "").replace("\\", "/"))
    base = base.lstrip(".")

    if "." in base:
        stem, _, ext = base.rpartition(".")
        ext = ext.lower()
    else:
        stem, ext = base, ""

    sanitized_stem = _SAFE_NAME_RE.sub("-", stem).strip("-.")
    sanitized_ext = _SAFE_NAME_RE.sub("", ext)

    if sanitized_stem and sanitized_ext:
        body = f"{sanitized_stem}.{sanitized_ext}"
    elif sanitized_stem:
        body = sanitized_stem
    elif sanitized_ext:
        body = f"{fallback_kind}.{sanitized_ext}"
    else:
        body = f"{fallback_kind}.bin"

    return f"{timestamp}_{body}"


def save_upload(
    *,
    store: Any,
    investigation_id: str,
    content: bytes,
    original_filename: str,
    content_type: str | None = None,
    description: str | None = None,
    timestamp_start: str | None = None,
) -> dict[str, Any]:
    if not content:
        raise ValueError("Upload content is empty.")

    store.get_investigation(investigation_id)

    media_kind = detect_media_kind(original_filename, content_type)
    safe_name = safe_upload_filename(original_filename, fallback_kind=media_kind)

    session_dir = Path(store.session_dir(investigation_id))
    uploads_dir = session_dir / "media" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    target_path = uploads_dir / safe_name
    target_path.write_bytes(content)

    checksum = hashlib.sha256(content).hexdigest()
    resolved_timestamp = timestamp_start or datetime.now(UTC).isoformat()

    metadata = {
        "source": "phone_upload",
        "original_filename": original_filename,
        "content_type": content_type,
        "description": description,
        "size_bytes": len(content),
    }

    return store.add_media_asset(
        investigation_id=investigation_id,
        media_type=media_kind,
        file_path=str(target_path),
        timestamp_start=resolved_timestamp,
        checksum=checksum,
        metadata=metadata,
    )
