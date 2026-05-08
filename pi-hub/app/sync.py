"""
PWA → Pi sync handler.

The PWA is the V1 product. The Pi is now an optional accessory that ingests
exported case bundles from one or more PWAs over local WiFi. This module
accepts a signed bundle.zip, validates its manifest (when present), and
extracts media + JSON sidecars into the Pi's per-investigation session_dir.

Bundle layout expected:

    bundle.zip
      manifest.json           (optional; sha256 of every file)
      investigation.json      (single investigation dict matching store schema)
      events.jsonl            (one event per line)
      sensor_samples.jsonl    (one sample per line)
      media_assets.jsonl      (one media-asset metadata row per line)
      media/<filename>        (the actual media files referenced by file_path)

V1 keeps validation light: schema is loose JSONL, manifest hash mismatches
are reported but do not block import (configurable). Strict mode lands when
the PWA's COSE+RFC3161 signing pack ships.
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class SyncResult:
    investigation_id: str | None
    events_imported: int
    samples_imported: int
    media_imported: int
    manifest_verified: bool
    issues: list[str]


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_jsonl(zf: zipfile.ZipFile, name: str) -> list[dict[str, Any]]:
    if name not in zf.namelist():
        return []
    with zf.open(name) as fh:
        rows: list[dict[str, Any]] = []
        for line in fh.read().decode("utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows


def _read_json(zf: zipfile.ZipFile, name: str) -> dict[str, Any] | None:
    if name not in zf.namelist():
        return None
    return json.loads(zf.read(name).decode("utf-8"))


def import_bundle(*, store, sessions_dir: Path, bundle_bytes: bytes, strict: bool = False) -> SyncResult:
    """Extract a PWA bundle into the Pi's store + sessions directory.

    The store is a duck-typed object exposing the same surface as
    pi-hub.app.store.InvestigationStore: create_investigation,
    add_event, add_sensor_sample, add_media_asset, get_investigation,
    session_dir(id).
    """
    issues: list[str] = []
    events_imported = 0
    samples_imported = 0
    media_imported = 0
    manifest_verified = False
    investigation_id: str | None = None

    with zipfile.ZipFile(bytes_buffer := __import__("io").BytesIO(bundle_bytes)) as zf:
        manifest = _read_json(zf, "manifest.json")

        # Hash check (advisory unless strict).
        if manifest and isinstance(manifest.get("items"), list):
            for item in manifest["items"]:
                path = item.get("path")
                expected = item.get("sha256")
                if not path or not expected or path not in zf.namelist():
                    continue
                actual = _sha256_bytes(zf.read(path))
                if actual != expected:
                    issues.append(f"manifest mismatch: {path} expected {expected[:12]}… got {actual[:12]}…")
                    if strict:
                        raise ValueError(f"Manifest hash mismatch for {path}")
            if not issues:
                manifest_verified = True

        investigation = _read_json(zf, "investigation.json")
        if not investigation:
            raise ValueError("Bundle missing investigation.json")
        title = investigation.get("title") or "Imported investigation"
        location = investigation.get("location_name")
        notes = investigation.get("notes")
        # Use the existing store's create_investigation; sync uses a fresh ID
        # locally rather than trusting the source ID, to avoid collisions.
        created = store.create_investigation(title=title, location_name=location, notes=notes)
        investigation_id = created["id"]

        for event in _read_jsonl(zf, "events.jsonl"):
            metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
            store.add_event(
                investigation_id=investigation_id,
                source=event.get("source", "user"),
                event_type=event.get("event_type", "marker"),
                title=event.get("title", ""),
                description=event.get("description"),
                metadata=metadata,
                timestamp=event.get("timestamp"),
            )
            events_imported += 1

        for sample in _read_jsonl(zf, "sensor_samples.jsonl"):
            metadata = sample.get("metadata") if isinstance(sample.get("metadata"), dict) else None
            store.add_sensor_sample(
                investigation_id=investigation_id,
                sensor_type=sample.get("sensor_type", "unknown"),
                value=sample.get("value"),
                unit=sample.get("unit"),
                timestamp=sample.get("timestamp"),
                metadata=metadata,
            ) if metadata is not None else store.add_sensor_sample(
                investigation_id=investigation_id,
                sensor_type=sample.get("sensor_type", "unknown"),
                value=sample.get("value"),
                unit=sample.get("unit"),
                timestamp=sample.get("timestamp"),
            )
            samples_imported += 1

        # Extract media files into the Pi's per-investigation session dir.
        target_media = Path(sessions_dir) / investigation_id / "media" / "imported"
        target_media.mkdir(parents=True, exist_ok=True)

        for asset in _read_jsonl(zf, "media_assets.jsonl"):
            file_path = asset.get("file_path")
            if not file_path:
                continue
            # The bundle stores media under "media/<name>" — accept that path
            zip_name = file_path if file_path in zf.namelist() else f"media/{Path(file_path).name}"
            if zip_name not in zf.namelist():
                issues.append(f"media file missing in bundle: {file_path}")
                continue
            data = zf.read(zip_name)
            local_name = Path(file_path).name
            (target_media / local_name).write_bytes(data)
            store.add_media_asset(
                investigation_id=investigation_id,
                media_type=asset.get("media_type", "audio"),
                file_path=f"media/imported/{local_name}",
                timestamp_start=asset.get("timestamp_start"),
                timestamp_end=asset.get("timestamp_end"),
                checksum=asset.get("checksum_sha256") or asset.get("checksum"),
                metadata=asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {"source": "pwa-sync"},
            )
            media_imported += 1

    return SyncResult(
        investigation_id=investigation_id,
        events_imported=events_imported,
        samples_imported=samples_imported,
        media_imported=media_imported,
        manifest_verified=manifest_verified,
        issues=issues,
    )
