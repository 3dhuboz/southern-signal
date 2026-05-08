# Southern Signal Handover

Date: 2026-05-08

## Project

Southern Signal is an Australia-made paranormal investigation app prototype. The current build is a Raspberry Pi 5 Investigation Hub served locally at:

http://127.0.0.1:8000

The product direction is not "fake ghost detector." It is a serious evidence-capture system for paranormal field investigations: phone/Pi sensors, audio, camera, contamination tagging, anomaly detection, evidence scoring, and exportable case files.

## Workspace

Project folder:

`C:\Users\Steve\Documents\Codex\2026-05-07\so-i-ve-always-wanted-to`

Main app folder:

`C:\Users\Steve\Documents\Codex\2026-05-07\so-i-ve-always-wanted-to\pi-hub`

Current local server:

`http://127.0.0.1:8000`

Run command:

```powershell
$env:PYTHONPATH='pi-hub'
$env:SOUTHERN_SIGNAL_DATA='pi-hub\data'
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Run tests:

```powershell
$env:PYTHONPATH='pi-hub'
.\.venv\Scripts\python -m unittest discover -s pi-hub\tests
```

Last verified result:

`41 tests OK`

## Important Files

Docs:

- `docs\ghost-hunting-app-product-brief.md`
- `docs\raspberry-pi-investigation-hub-mvp-plan.md`
- `docs\deep-feature-research-groundbreaking-paranormal-app.md`

Backend:

- `pi-hub\app\main.py`
- `pi-hub\app\store.py`
- `pi-hub\app\recorder.py`
- `pi-hub\app\exporter.py`
- `pi-hub\app\protocols.py`
- `pi-hub\app\contamination.py`
- `pi-hub\app\analysis\anomalies.py`
- `pi-hub\app\analysis\scoring.py`
- `pi-hub\app\analysis\report.py`
- `pi-hub\app\analysis\review_windows.py`

Recorders:

- `pi-hub\app\recorders\audio.py`
- `pi-hub\app\recorders\camera.py`

Sensors:

- `pi-hub\app\sensors\registry.py`
- `pi-hub\app\sensors\mock.py`
- `pi-hub\app\sensors\sense_hat.py`

Frontend:

- `pi-hub\app\static\index.html`
- `pi-hub\app\static\app.js`
- `pi-hub\app\static\styles.css`

Tests:

- `pi-hub\tests\test_api.py`
- `pi-hub\tests\test_store_and_export.py`
- `pi-hub\tests\test_audio_media.py`
- `pi-hub\tests\test_camera_media.py`
- `pi-hub\tests\test_hardware_status.py`
- `pi-hub\tests\test_protocols.py`
- `pi-hub\tests\test_evidence_scoring.py`
- `pi-hub\tests\test_anomaly_detection.py`
- `pi-hub\tests\test_evidence_report.py`
- `pi-hub\tests\test_review_windows.py`
- `pi-hub\tests\test_contamination_tags.py`

## Current Implemented Features

### App Shell / GUI

- Persistent app sidebar.
- Views:
  - Mission
  - Review
  - Setup
  - Export
- Polished dark field-console UI.
- Sidebar app metadata from `/api/app-state`.
- Remembers selected view in `localStorage`.
- Remembers last selected investigation in `localStorage`.
- App notifications/toasts.
- Loading states on async buttons.
- Safer API error display.
- Escapes dynamic UI text.
- Header case summary strip:
  - status
  - samples
  - events
  - media

### Investigation Lifecycle

- Create investigations.
- Start/stop sessions.
- Session list.
- Selected investigation summary.
- Live polling.
- Export evidence bundle.

### Sensor Capture

- Mock sensor provider for dev machines.
- Optional Sense HAT provider for Raspberry Pi.
- Hardware status endpoint.
- Live sensor readings.
- Sensor samples stored in SQLite.

### Audio

- Silent WAV fallback recorder.
- Optional USB microphone recorder shape using a sounddevice-compatible backend.
- Audio media asset stored and exported.
- Does not require audio dependencies on Windows/dev.

### Camera

- Placeholder PNG camera fallback.
- Optional Pi Camera / `picamera2` capture path.
- Manual still capture endpoint.
- Camera image media stored and exported.

### Evidence Quality

- Evidence Confidence Engine.
- Sensor anomaly detection against local baselines.
- Review/replay windows.
- Evidence report endpoint.
- Contamination tagging.
- Quick ordinary-cause tags in GUI.
- Protocol library.

### Protocols

Available protocols:

- Baseline Investigation
- Prompted EVP Session
- Unattended Room Watch

### Contamination Tags

Current tags:

- Footstep
- Speech
- Breath or mic handling
- Phone movement
- Cable movement
- Nearby electronics
- Door or latch
- Wind
- Vehicle
- Animal
- Unknown

Aliases supported include `footsteps`, `steps`, `phone`, and similar.

## Current API Endpoints

- `GET /`
- `GET /api/health`
- `GET /api/app-state`
- `GET /api/hardware`
- `GET /api/protocols`
- `GET /api/protocols/{protocol_id}`
- `GET /api/contamination-tags`
- `POST /api/evidence/score`
- `POST /api/investigations`
- `GET /api/investigations`
- `GET /api/investigations/{id}`
- `POST /api/investigations/{id}/start`
- `POST /api/investigations/{id}/stop`
- `GET /api/investigations/{id}/events`
- `GET /api/investigations/{id}/samples`
- `GET /api/investigations/{id}/media`
- `POST /api/investigations/{id}/camera/still`
- `GET /api/investigations/{id}/anomalies`
- `GET /api/investigations/{id}/evidence-report`
- `POST /api/investigations/{id}/markers`
- `POST /api/investigations/{id}/contamination`
- `POST /api/investigations/{id}/export`
- `GET /api/investigations/{id}/export/download`

## Hardware Plan

Steve has a Raspberry Pi 5.

Recommended hardware:

1. Raspberry Pi 5 active cooler/case.
2. Sense HAT V2.
3. USB microphone.
4. Raspberry Pi Camera Module 3 NoIR Wide.
5. Pi 5 camera cable.
6. 850nm IR illuminator.
7. Battery pack or UPS HAT.
8. 128GB microSD or SSD/NVMe later.

First real hardware integration path:

1. Install and test Sense HAT.
2. Install and test USB mic recording.
3. Install and test Camera Module 3 NoIR still capture.
4. Add IR night capture workflow.
5. Add longer-running audio/camera recording lifecycle.

## Known Notes

### Codex Hook Issue

There was a recurring Codex app error:

`error: hook exited with code 1`

Root cause:

`C:\Users\Steve\.codex\hooks.json` had global Codex hooks copied from a Claude/Bash setup. They failed on Windows because `bash` was unavailable and because a new Git repo had no `HEAD`.

Fix applied:

Old hooks were backed up to:

`C:\Users\Steve\.codex\hooks.json.backup-20260507-101956`

Current hooks file was changed to:

```json
{
  "hooks": {}
}
```

If the error appears in an already-open Codex thread, restart Codex or open a fresh thread so the new hook config loads.

### Git

This project folder was initialized as its own repo because the parent `C:\Users\Steve` was also a Git root and caused noisy status/hook behavior.

Current local repo root:

`C:\Users\Steve\Documents\Codex\2026-05-07\so-i-ve-always-wanted-to`

`.gitignore` exists and excludes `.venv`, Python caches, and `pi-hub\data`.

No commit has been made yet.

## Next Todo

### Highest Priority

1. Test on the actual Raspberry Pi 5.
2. Install Pi dependencies:
   - `sense-hat`
   - `picamera2`
   - optional audio backend such as `sounddevice`
3. Confirm Sense HAT provider activates instead of mock.
4. Confirm Pi camera still capture creates real images.
5. Replace silent WAV placeholder with real USB microphone capture.

### Backend / Evidence

1. Add continuous audio recording lifecycle instead of 1-second placeholder capture.
2. Add session duration controls.
3. Add real camera capture cadence:
   - still on marker
   - still every N seconds
   - optional video later
4. Add waveform/spectrogram generation.
5. Add baseline calibration workflow.
6. Add interference checklist.
7. Add blind EVP review workflow.
8. Add PDF report export.
9. Add session cleanup/archive/delete.
10. Add settings endpoint and persisted app preferences.

### GUI

1. Add real icons to nav/buttons.
2. Add a session detail drawer or modal.
3. Add charts for sensor readings.
4. Add audio playback controls for media assets.
5. Add image thumbnail preview for captured stills.
6. Add protocol step runner UI.
7. Add clear active-recording timer.
8. Add better mobile bottom-nav mode.
9. Add skeleton/loading placeholders for first load.
10. Add confirmation before stopping a session.

### Product / Research

1. Expand Australian haunted-site pack structure.
2. Add safety and cultural sensitivity checklist.
3. Define Southern Signal Evidence Standard.
4. Define tour-operator mode.
5. Decide mobile app stack after Pi hub proves real hardware capture.

## Current Product Thesis

Southern Signal should not claim to prove ghosts. It should help investigators capture, correlate, and preserve anomalous events well enough to review them and rule out ordinary causes.

The strongest differentiator is the phone-plus-Raspberry-Pi investigation workflow:

- independent sensor witness
- better audio/camera capture
- transparent anomaly scoring
- contamination tagging
- exportable case files
- Australia-specific investigation context

