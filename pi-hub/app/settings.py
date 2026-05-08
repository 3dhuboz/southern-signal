from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


class AppSettings(BaseModel):
    model_config = {"extra": "ignore"}

    default_protocol_id: str | None = None
    auto_capture_still_seconds: int | None = Field(default=None, ge=1)
    theme: Literal["dark", "light"] = "dark"
    default_session_duration_minutes: int | None = Field(default=None, ge=1)
    evp_blind_review: bool = False
    notes: str | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


class SettingsStore:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "settings.json"

    def load(self) -> AppSettings:
        if not self.path.exists():
            return AppSettings()
        try:
            raw = self.path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"Settings file at {self.path} is malformed: {error}"
            ) from error
        if not isinstance(data, dict):
            raise ValueError(
                f"Settings file at {self.path} must contain a JSON object, got {type(data).__name__}"
            )
        return AppSettings(**data)

    def save(self, settings: AppSettings) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            settings.model_dump(),
            indent=2,
            sort_keys=True,
        )
        tmp_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self.data_dir,
            prefix="settings.json.",
            suffix=".tmp",
            delete=False,
        )
        tmp_path = Path(tmp_file.name)
        try:
            with tmp_file as handle:
                handle.write(payload)
            os.replace(tmp_path, self.path)
        except Exception:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
            raise

    def update(self, patch: dict[str, Any]) -> AppSettings:
        current = self.load()
        merged = current.model_dump()
        merged.update(patch)
        new_settings = AppSettings(**merged)
        self.save(new_settings)
        return new_settings

    def reset(self) -> AppSettings:
        defaults = AppSettings()
        self.save(defaults)
        return defaults
