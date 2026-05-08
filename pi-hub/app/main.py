from __future__ import annotations

import os
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from .analysis.anomalies import detect_sensor_anomalies
from .analysis.blind_review import (
    compute_blind_review_agreement,
    list_blind_reviews,
    start_blind_review,
    submit_blind_review,
)
from .analysis.calibration import (
    compute_calibration,
    load_calibration,
    save_calibration,
)
from .analysis.pdf_report import render_pdf_bytes
from .analysis.report import build_evidence_report
from .analysis.scoring import score_evidence
from .analysis.waveform import generate_waveform_png
from .contamination import find_contamination_tag, get_contamination_tags
from .duration import (
    clear_duration_target,
    load_duration_target,
    parse_duration_minutes,
    save_duration_target,
    status_for as duration_status_for,
)
from .exporter import build_export_zip
from .hardware_copy import enrich_hardware_status
from .interference import (
    list_interference_items,
    load_interference_responses,
    save_interference_responses,
)
from .observations import build_observation_event, list_observation_types
from .protocols import get_protocol, list_protocols
from .recorder import RecorderManager
from .settings import AppSettings, SettingsStore
from .store import InvestigationStore
from .sync import import_bundle
from .uploads import save_upload


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("SOUTHERN_SIGNAL_DATA", ROOT_DIR / "data"))
STATIC_DIR = Path(__file__).resolve().parent / "static"
SERVICE_NAME = "southern-signal-pi-hub"
APP_VERSION = "0.1.0"

store = InvestigationStore(DATA_DIR / "southern_signal.db", DATA_DIR / "sessions")
recorder = RecorderManager(store)
settings_store = SettingsStore(DATA_DIR)
app = FastAPI(title="Southern Signal Pi Hub")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.state.store = store
app.state.recorder = recorder
app.state.settings_store = settings_store


class InvestigationCreate(BaseModel):
    title: str
    location_name: str | None = None
    notes: str | None = None


class MarkerCreate(BaseModel):
    title: str
    description: str | None = None


class ContaminationCreate(BaseModel):
    tag_id: str | None = None
    contamination_type: str | None = None
    description: str | None = None


class EvidenceScoreRequest(BaseModel):
    audio_spike: bool = False
    sensor_correlation_count: int = 0
    media_support: bool = False
    unattended_room: bool = False
    blind_reviewer_agreement_count: int = 0
    contamination_count: int = 0
    calibration_ok: bool = False
    sync_confidence: float = 0.0


class ObservationCreate(BaseModel):
    observation_type: str
    title: str | None = None
    intensity: int | None = None
    description: str | None = None
    timestamp: str | None = None
    linked_media_id: str | None = None


class DurationTarget(BaseModel):
    target_minutes: int | float | str | None = None


class InterferenceSubmission(BaseModel):
    answers: dict[str, object] = {}
    notes: str | None = None


class BlindReviewStart(BaseModel):
    reviewer_id: str | None = None


class BlindReviewSubmission(BaseModel):
    perceived_events: list[dict] = []
    notes: str | None = None


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/api/app-state")
def app_state() -> dict:
    hardware_status = recorder.hardware_status()
    return {
        "service": SERVICE_NAME,
        "app_version": APP_VERSION,
        "investigation_count": len(store.list_investigations()),
        "running_investigation_count": len(recorder.running),
        "active_hardware_provider": hardware_status.get("active_provider"),
        "protocol_count": len(list_protocols()),
    }


@app.get("/api/hardware")
def hardware() -> dict:
    return enrich_hardware_status(recorder.hardware_status())


@app.get("/api/protocols")
def protocols() -> list[dict]:
    return list_protocols()


@app.get("/api/protocols/{protocol_id}")
def protocol_detail(protocol_id: str) -> dict:
    try:
        return get_protocol(protocol_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/evidence/score")
def evidence_score(payload: EvidenceScoreRequest) -> dict:
    return score_evidence(payload.model_dump())


@app.get("/api/contamination-tags")
def contamination_tags() -> list[dict]:
    return get_contamination_tags()


@app.post("/api/investigations")
def create_investigation(payload: InvestigationCreate) -> dict:
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")
    return store.create_investigation(
        title=payload.title.strip(),
        location_name=payload.location_name,
        notes=payload.notes,
    )


@app.get("/api/investigations")
def list_investigations() -> list[dict]:
    return store.list_investigations()


@app.get("/api/investigations/{investigation_id}")
def get_investigation(investigation_id: str) -> dict:
    try:
        detail = store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    detail["running"] = recorder.is_running(investigation_id)
    detail["event_count"] = len(store.list_events(investigation_id))
    detail["sample_count"] = len(store.list_sensor_samples(investigation_id))
    detail["media_count"] = len(store.list_media_assets(investigation_id))
    return detail


@app.post("/api/investigations/{investigation_id}/start")
async def start_investigation(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await recorder.start(investigation_id)
    target = load_duration_target(store.sessions_dir, investigation_id)
    if target and target.get("target_minutes") is not None:
        running = store.get_investigation(investigation_id)
        save_duration_target(
            store.sessions_dir,
            investigation_id,
            target_minutes=target["target_minutes"],
            started_at=running.get("started_at"),
        )
    return {"status": "running", "investigation_id": investigation_id}


@app.post("/api/investigations/{investigation_id}/stop")
async def stop_investigation(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await recorder.stop(investigation_id)
    return {"status": "stopped", "investigation_id": investigation_id}


@app.get("/api/investigations/{investigation_id}/events")
def list_events(investigation_id: str) -> list[dict]:
    return store.list_events(investigation_id)


@app.get("/api/investigations/{investigation_id}/samples")
def list_samples(investigation_id: str) -> list[dict]:
    return store.list_sensor_samples(investigation_id)


@app.get("/api/investigations/{investigation_id}/media")
def list_media(investigation_id: str) -> list[dict]:
    return store.list_media_assets(investigation_id)


@app.post("/api/investigations/{investigation_id}/camera/still")
def capture_still(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return recorder.capture_still(investigation_id)


@app.get("/api/investigations/{investigation_id}/anomalies")
def list_anomalies(investigation_id: str) -> list[dict]:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return detect_sensor_anomalies(store.list_sensor_samples(investigation_id))


@app.get("/api/investigations/{investigation_id}/evidence-report")
def evidence_report(investigation_id: str) -> dict:
    try:
        return build_evidence_report(store, investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/investigations/{investigation_id}/markers")
def add_marker(investigation_id: str, payload: MarkerCreate) -> dict:
    if not payload.title.strip():
        raise HTTPException(status_code=400, detail="Marker title is required")
    try:
        return store.add_marker(investigation_id, payload.title.strip(), payload.description)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/investigations/{investigation_id}/contamination")
def add_contamination(investigation_id: str, payload: ContaminationCreate) -> dict:
    tag_id = (payload.tag_id or payload.contamination_type or "").strip()
    if not tag_id:
        raise HTTPException(status_code=400, detail="Contamination tag is required")
    try:
        tag = find_contamination_tag(tag_id)
        return store.add_event(
            investigation_id=investigation_id,
            source="user",
            event_type="contamination",
            title=tag["label"],
            description=payload.description,
            metadata={
                "tag": tag,
                "contamination_type": tag["id"],
                "ordinary_cause": True,
            },
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/investigations/{investigation_id}/live")
def live_snapshot(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    duration = duration_status_for(load_duration_target(store.sessions_dir, investigation_id))
    return {
        "investigation_id": investigation_id,
        "running": recorder.is_running(investigation_id),
        "readings": recorder.live_snapshot(),
        "duration": duration,
    }


@app.post("/api/investigations/{investigation_id}/export")
def export_investigation(investigation_id: str) -> dict:
    try:
        archive = build_export_zip(store, investigation_id, hardware_status=recorder.hardware_status())
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"archive": str(archive), "filename": archive.name}


@app.get("/api/investigations/{investigation_id}/export/download")
def download_export(investigation_id: str) -> FileResponse:
    archive = build_export_zip(store, investigation_id, hardware_status=recorder.hardware_status())
    return FileResponse(archive, filename=archive.name, media_type="application/zip")


@app.get("/api/investigations/{investigation_id}/evidence-report.pdf")
def evidence_report_pdf(investigation_id: str) -> Response:
    try:
        report = build_evidence_report(store, investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Response(
        content=render_pdf_bytes(report),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="evidence_report_{investigation_id}.pdf"',
        },
    )


@app.post("/api/investigations/{investigation_id}/calibration")
def create_calibration(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    samples = store.list_sensor_samples(investigation_id)
    calibration = compute_calibration(samples)
    save_calibration(store.sessions_dir, investigation_id, calibration)
    saved = load_calibration(store.sessions_dir, investigation_id)
    if saved is None:
        raise HTTPException(status_code=500, detail="Failed to persist calibration")
    return saved


@app.get("/api/investigations/{investigation_id}/calibration")
def get_calibration(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    calibration = load_calibration(store.sessions_dir, investigation_id)
    if calibration is None:
        raise HTTPException(status_code=404, detail="No calibration recorded for this investigation")
    return calibration


@app.get("/api/investigations/{investigation_id}/media/{media_id}/waveform.png")
def media_waveform(investigation_id: str, media_id: str) -> FileResponse:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    asset = next(
        (item for item in store.list_media_assets(investigation_id) if item["id"] == media_id),
        None,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="Media asset not found")
    if asset.get("media_type") != "audio":
        raise HTTPException(status_code=400, detail="Waveforms are only available for audio assets")
    wav_path = store.session_dir(investigation_id) / asset["file_path"]
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail="Audio file is missing on disk")
    png_path = wav_path.with_suffix(".png")
    if not png_path.exists() or png_path.stat().st_mtime < wav_path.stat().st_mtime:
        generate_waveform_png(wav_path, png_path)
    return FileResponse(png_path, media_type="image/png")


@app.get("/api/settings")
def get_settings() -> AppSettings:
    return settings_store.load()


@app.put("/api/settings")
def update_settings(patch: dict = Body(default_factory=dict)) -> AppSettings:
    try:
        return settings_store.update(patch)
    except ValidationError as error:
        raise HTTPException(status_code=422, detail=error.errors()) from error


@app.post("/api/settings/reset")
def reset_settings() -> AppSettings:
    return settings_store.reset()


@app.get("/api/observation-types")
def observation_types() -> list[dict]:
    return list_observation_types()


@app.post("/api/investigations/{investigation_id}/observations")
def add_observation(investigation_id: str, payload: ObservationCreate) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    try:
        event_kwargs = build_observation_event(
            observation_type=payload.observation_type,
            title=payload.title,
            intensity=payload.intensity,
            description=payload.description,
            timestamp=payload.timestamp,
            linked_media_id=payload.linked_media_id,
        )
    except KeyError as error:
        raise HTTPException(status_code=400, detail=f"Unknown observation type: {error}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return store.add_event(
        investigation_id=investigation_id,
        source=event_kwargs["source"],
        event_type=event_kwargs["event_type"],
        title=event_kwargs["title"],
        description=event_kwargs["description"],
        metadata=event_kwargs["metadata"],
        timestamp=event_kwargs["timestamp"],
    )


@app.get("/api/investigations/{investigation_id}/duration")
def get_duration(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return duration_status_for(load_duration_target(store.sessions_dir, investigation_id))


@app.post("/api/investigations/{investigation_id}/duration")
def set_duration(investigation_id: str, payload: DurationTarget) -> dict:
    try:
        investigation = store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    try:
        minutes = parse_duration_minutes(payload.target_minutes)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    started_at = investigation.get("started_at") if recorder.is_running(investigation_id) else None
    saved = save_duration_target(
        store.sessions_dir,
        investigation_id,
        target_minutes=minutes,
        started_at=started_at,
    )
    return duration_status_for(saved)


@app.delete("/api/investigations/{investigation_id}/duration")
def delete_duration(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    clear_duration_target(store.sessions_dir, investigation_id)
    return duration_status_for(None)


@app.get("/api/interference-items")
def interference_items() -> list[dict]:
    return list_interference_items()


@app.get("/api/investigations/{investigation_id}/interference")
def get_interference(investigation_id: str) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    record = load_interference_responses(store.sessions_dir, investigation_id)
    if record is None:
        raise HTTPException(status_code=404, detail="No interference checklist recorded")
    return record


@app.post("/api/investigations/{investigation_id}/interference")
def submit_interference(investigation_id: str, payload: InterferenceSubmission) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    try:
        return save_interference_responses(
            store.sessions_dir,
            investigation_id,
            answers=payload.answers,
            notes=payload.notes,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/investigations/{investigation_id}/blind-reviews")
def begin_blind_review(investigation_id: str, payload: BlindReviewStart) -> dict:
    try:
        return start_blind_review(store, investigation_id, reviewer_id=payload.reviewer_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.put("/api/investigations/{investigation_id}/blind-reviews/{reviewer_id}")
def submit_blind_review_endpoint(
    investigation_id: str,
    reviewer_id: str,
    payload: BlindReviewSubmission,
) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    try:
        return submit_blind_review(
            store,
            store.sessions_dir,
            investigation_id,
            reviewer_id=reviewer_id,
            perceived_events=payload.perceived_events,
            notes=payload.notes,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/investigations/{investigation_id}/blind-reviews")
def list_blind_reviews_endpoint(investigation_id: str) -> list[dict]:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return list_blind_reviews(store.sessions_dir, investigation_id)


@app.get("/api/investigations/{investigation_id}/blind-reviews/agreement")
def blind_review_agreement(investigation_id: str, tolerance_seconds: int = 5) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return compute_blind_review_agreement(
        store,
        store.sessions_dir,
        investigation_id,
        tolerance_seconds=tolerance_seconds,
    )


@app.post("/api/investigations/{investigation_id}/uploads")
async def upload_media(
    investigation_id: str,
    file: UploadFile = File(...),
    description: str | None = Form(None),
    timestamp_start: str | None = Form(None),
    create_observation: bool = Form(False),
    observation_type: str | None = Form(None),
) -> dict:
    try:
        store.get_investigation(investigation_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    try:
        media_asset = save_upload(
            store=store,
            investigation_id=investigation_id,
            content=content,
            original_filename=file.filename or "upload",
            content_type=file.content_type,
            description=description,
            timestamp_start=timestamp_start,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    response: dict = {"media_asset": media_asset}
    if create_observation and observation_type:
        try:
            event_kwargs = build_observation_event(
                observation_type=observation_type,
                description=description,
                timestamp=media_asset.get("timestamp_start"),
                linked_media_id=media_asset["id"],
            )
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        response["event"] = store.add_event(
            investigation_id=investigation_id,
            source=event_kwargs["source"],
            event_type=event_kwargs["event_type"],
            title=event_kwargs["title"],
            description=event_kwargs["description"],
            metadata=event_kwargs["metadata"],
            timestamp=event_kwargs["timestamp"],
        )
    return response


@app.post("/api/sync/import")
async def sync_import(
    bundle: UploadFile = File(...),
    strict: bool = Form(False),
) -> dict:
    """Accept a PWA-exported bundle.zip and ingest it into the Pi's store.

    The PWA is the V1 product; this endpoint lets users archive their
    sessions to a Pi over local WiFi. Strict mode rejects on any manifest
    hash mismatch; non-strict logs issues but ingests what it can.
    """
    if not bundle.filename or not bundle.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Expected a .zip bundle")
    payload = await bundle.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Bundle is empty")
    try:
        result = import_bundle(
            store=store,
            sessions_dir=store.sessions_dir,
            bundle_bytes=payload,
            strict=strict,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        "investigation_id": result.investigation_id,
        "events_imported": result.events_imported,
        "samples_imported": result.samples_imported,
        "media_imported": result.media_imported,
        "manifest_verified": result.manifest_verified,
        "issues": result.issues,
    }
