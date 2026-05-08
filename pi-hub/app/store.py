from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from collections.abc import Iterator
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


class InvestigationStore:
    def __init__(self, db_path: Path, sessions_dir: Path):
        self.db_path = Path(db_path)
        self.sessions_dir = Path(sessions_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _init_db(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS investigations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    location_name TEXT,
                    notes TEXT,
                    started_at TEXT,
                    ended_at TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sensor_samples (
                    id TEXT PRIMARY KEY,
                    investigation_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    sensor_type TEXT NOT NULL,
                    x REAL,
                    y REAL,
                    z REAL,
                    value REAL,
                    unit TEXT,
                    metadata_json TEXT NOT NULL,
                    FOREIGN KEY (investigation_id) REFERENCES investigations(id)
                );

                CREATE TABLE IF NOT EXISTS evidence_events (
                    id TEXT PRIMARY KEY,
                    investigation_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    source TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    linked_file TEXT,
                    metadata_json TEXT NOT NULL,
                    FOREIGN KEY (investigation_id) REFERENCES investigations(id)
                );

                CREATE TABLE IF NOT EXISTS media_assets (
                    id TEXT PRIMARY KEY,
                    investigation_id TEXT NOT NULL,
                    timestamp_start TEXT NOT NULL,
                    timestamp_end TEXT,
                    media_type TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    checksum TEXT,
                    metadata_json TEXT NOT NULL,
                    FOREIGN KEY (investigation_id) REFERENCES investigations(id)
                );
                """
            )

    def create_investigation(
        self,
        title: str,
        location_name: str | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        investigation_id = str(uuid.uuid4())
        now = utc_now()
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO investigations
                (id, title, location_name, notes, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (investigation_id, title, location_name, notes, "created", now),
            )
        self.session_dir(investigation_id).mkdir(parents=True, exist_ok=True)
        return self.get_investigation(investigation_id)

    def start_investigation(self, investigation_id: str) -> dict[str, Any]:
        now = utc_now()
        with self.connect() as db:
            db.execute(
                """
                UPDATE investigations
                SET started_at = COALESCE(started_at, ?), status = ?
                WHERE id = ?
                """,
                (now, "running", investigation_id),
            )
        self.add_event(investigation_id, "hub", "session_started", "Session started", timestamp=now)
        return self.get_investigation(investigation_id)

    def stop_investigation(self, investigation_id: str) -> dict[str, Any]:
        now = utc_now()
        with self.connect() as db:
            db.execute(
                """
                UPDATE investigations
                SET ended_at = ?, status = ?
                WHERE id = ?
                """,
                (now, "stopped", investigation_id),
            )
        self.add_event(investigation_id, "hub", "session_stopped", "Session stopped", timestamp=now)
        return self.get_investigation(investigation_id)

    def get_investigation(self, investigation_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM investigations WHERE id = ?", (investigation_id,)).fetchone()
        if row is None:
            raise KeyError(f"Investigation not found: {investigation_id}")
        return row_to_dict(row)

    def list_investigations(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM investigations ORDER BY created_at DESC").fetchall()
        return [row_to_dict(row) for row in rows]

    def add_sensor_sample(
        self,
        investigation_id: str,
        sensor_type: str,
        value: float | None = None,
        unit: str | None = None,
        x: float | None = None,
        y: float | None = None,
        z: float | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        sample_id = str(uuid.uuid4())
        timestamp = timestamp or utc_now()
        metadata_json = json.dumps(metadata or {}, sort_keys=True)
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO sensor_samples
                (id, investigation_id, timestamp, sensor_type, x, y, z, value, unit, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (sample_id, investigation_id, timestamp, sensor_type, x, y, z, value, unit, metadata_json),
            )
            row = db.execute("SELECT * FROM sensor_samples WHERE id = ?", (sample_id,)).fetchone()
        return row_to_dict(row)

    def add_marker(
        self,
        investigation_id: str,
        title: str,
        description: str | None = None,
    ) -> dict[str, Any]:
        return self.add_event(investigation_id, "user", "marker", title, description)

    def add_event(
        self,
        investigation_id: str,
        source: str,
        event_type: str,
        title: str,
        description: str | None = None,
        linked_file: str | None = None,
        metadata: dict[str, Any] | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        timestamp = timestamp or utc_now()
        metadata_json = json.dumps(metadata or {}, sort_keys=True)
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO evidence_events
                (id, investigation_id, timestamp, source, event_type, title, description, linked_file, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    investigation_id,
                    timestamp,
                    source,
                    event_type,
                    title,
                    description,
                    linked_file,
                    metadata_json,
                ),
            )
            row = db.execute("SELECT * FROM evidence_events WHERE id = ?", (event_id,)).fetchone()
        return row_to_dict(row)

    def list_events(self, investigation_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM evidence_events WHERE investigation_id = ? ORDER BY timestamp ASC",
                (investigation_id,),
            ).fetchall()
        return [row_to_dict(row) for row in rows]

    def list_sensor_samples(self, investigation_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM sensor_samples WHERE investigation_id = ? ORDER BY timestamp ASC",
                (investigation_id,),
            ).fetchall()
        return [row_to_dict(row) for row in rows]

    def add_media_asset(
        self,
        investigation_id: str,
        media_type: str,
        file_path: str,
        timestamp_start: str,
        timestamp_end: str | None = None,
        checksum: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        asset_id = str(uuid.uuid4())
        metadata_json = json.dumps(metadata or {}, sort_keys=True)
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO media_assets
                (id, investigation_id, timestamp_start, timestamp_end, media_type, file_path, checksum, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset_id,
                    investigation_id,
                    timestamp_start,
                    timestamp_end,
                    media_type,
                    file_path,
                    checksum,
                    metadata_json,
                ),
            )
            row = db.execute("SELECT * FROM media_assets WHERE id = ?", (asset_id,)).fetchone()
        return row_to_dict(row)

    def list_media_assets(self, investigation_id: str) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM media_assets WHERE investigation_id = ? ORDER BY timestamp_start ASC",
                (investigation_id,),
            ).fetchall()
        return [row_to_dict(row) for row in rows]

    def session_dir(self, investigation_id: str) -> Path:
        return self.sessions_dir / investigation_id
