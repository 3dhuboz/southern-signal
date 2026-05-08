from __future__ import annotations

import csv
import json
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from .analysis.anomalies import detect_sensor_anomalies
from .analysis.report import build_evidence_report
from .store import InvestigationStore


README_TEXT = """Southern Signal evidence bundle

This archive contains environmental data captured during a paranormal investigation session.
It records sensor readings, user markers, and session metadata. It does not prove paranormal
activity or claim to identify spirits.
"""


def write_csv(path: Path, rows: list[dict]) -> None:
    fieldnames = sorted({key for row in rows for key in row.keys()})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_export_zip(
    store: InvestigationStore,
    investigation_id: str,
    hardware_status: dict | None = None,
) -> Path:
    investigation = store.get_investigation(investigation_id)
    samples = store.list_sensor_samples(investigation_id)
    events = store.list_events(investigation_id)
    media_assets = store.list_media_assets(investigation_id)
    session_dir = store.session_dir(investigation_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    archive_path = session_dir / f"{investigation_id}-evidence.zip"

    with TemporaryDirectory() as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        (temp_dir / "session.json").write_text(
            json.dumps(investigation, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        write_csv(temp_dir / "sensor_samples.csv", samples)
        write_csv(temp_dir / "events.csv", events)
        write_csv(temp_dir / "media_assets.csv", media_assets)
        (temp_dir / "anomaly_cards.json").write_text(
            json.dumps(detect_sensor_anomalies(samples), indent=2, sort_keys=True),
            encoding="utf-8",
        )
        (temp_dir / "evidence_report.json").write_text(
            json.dumps(build_evidence_report(store, investigation_id), indent=2, sort_keys=True),
            encoding="utf-8",
        )
        (temp_dir / "README.txt").write_text(README_TEXT, encoding="utf-8")
        if hardware_status is not None:
            (temp_dir / "hardware_status.json").write_text(
                json.dumps(hardware_status, indent=2, sort_keys=True),
                encoding="utf-8",
            )

        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in temp_dir.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(temp_dir).as_posix())

            media_dir = session_dir / "media"
            if media_dir.exists():
                for path in media_dir.rglob("*"):
                    if path.is_file():
                        archive.write(path, f"media/{path.relative_to(media_dir).as_posix()}")

    return archive_path
