# Raspberry Pi 5 Investigation Hub MVP Plan

Date: 2026-05-07

## Goal

Build the first working hardware-backed prototype for Southern Signal.

The prototype should let us start an investigation, record sensor/audio/camera evidence from a Raspberry Pi 5, add markers, stop the investigation, and export a complete evidence bundle.

## MVP Demo Target

Within one local browser session:

1. Create a new investigation.
2. Start recording.
3. Capture sensor readings once per second.
4. Record audio.
5. Capture still frames or video from the Pi camera if attached.
6. Add manual event markers.
7. Stop recording.
8. Export a timestamped session folder or ZIP.

## Why This Comes First

The Raspberry Pi hub is the product's credibility wedge.

Most paranormal apps are phone-only and compete on spooky effects. A Pi-based field station lets this product compete on independent data capture, longer unattended recordings, better microphones, real night vision, and transparent evidence logs.

## Prototype Architecture

```text
Browser Dashboard
  |
  | http://raspberrypi.local:8000
  v
Python API Service
  |
  +-- Session controller
  +-- Sensor logger
  +-- Audio recorder
  +-- Camera capture
  +-- Evidence marker API
  +-- Export builder
  |
  +-- SQLite database
  +-- /sessions/<session-id>/ files
```

## Suggested Tech Stack

- Python 3
- FastAPI
- SQLite
- Uvicorn
- sounddevice or PyAudio for USB microphone capture
- picamera2 for Raspberry Pi camera capture
- sense-hat library if using Sense HAT
- pandas optional for export/report generation
- Simple HTML dashboard served by FastAPI

## File Structure

```text
pi-hub/
  app/
    main.py
    db.py
    models.py
    sessions.py
    sensors/
      base.py
      sense_hat.py
      mock.py
    recorders/
      audio.py
      camera.py
    export.py
    static/
      index.html
      app.js
      styles.css
  data/
    southern_signal.db
    sessions/
  requirements.txt
  README.md
```

## Core API

| Method | Route | Purpose |
|---|---|---|
| POST | /api/investigations | Create a new investigation |
| POST | /api/investigations/{id}/start | Start capture |
| POST | /api/investigations/{id}/stop | Stop capture |
| GET | /api/investigations | List sessions |
| GET | /api/investigations/{id} | Session detail |
| GET | /api/investigations/{id}/events | Timeline events |
| POST | /api/investigations/{id}/markers | Add manual marker |
| GET | /api/investigations/{id}/live | Live sensor snapshot |
| POST | /api/investigations/{id}/export | Build export bundle |

## Database Tables

### investigations

- id
- title
- location_name
- notes
- started_at
- ended_at
- status

### sensor_samples

- id
- investigation_id
- timestamp
- sensor_type
- x
- y
- z
- value
- unit
- metadata_json

### evidence_events

- id
- investigation_id
- timestamp
- source
- event_type
- title
- description
- linked_file
- metadata_json

### media_assets

- id
- investigation_id
- timestamp_start
- timestamp_end
- media_type
- file_path
- checksum
- metadata_json

## Sensor Sampling Plan

### MVP Required

- Mock sensor source for development on non-Pi machines
- System timestamp
- CPU temperature, if available
- Sense HAT values if attached:
  - temperature
  - humidity
  - pressure
  - magnetometer
  - accelerometer
  - gyroscope
  - light/colour, if available

### MVP Optional

- External I2C magnetometer
- Vibration sensor
- Thermal camera

## Audio Plan

MVP:
- Record one WAV file per investigation.
- Store sample rate, device name, start/end timestamps.
- Add event markers for recording start/stop.

Next:
- Show waveform and spectrogram.
- Detect clipping.
- Track noise floor.
- Allow marker during playback.

## Camera Plan

MVP:
- If Pi camera is attached, capture a still frame every N seconds or on marker.
- If camera support is stable, add video recording.

Next:
- NoIR + IR illuminator mode.
- Motion detection.
- Timelapse review.
- Low-light frame quality warnings.

## Dashboard MVP

Views:
- Start investigation form
- Live status panel
- Sensor readout
- Marker button
- Event timeline
- Stop/export controls

Design tone:
- Dark field-tool interface
- Dense, readable data
- No fake radar as the core UI
- Evidence-first, not scare-first

## Export Bundle

Each export should include:

```text
session.json
sensor_samples.csv
events.csv
media/
  audio.wav
  frames/
README.txt
```

The README should explain:
- Device used
- Sensors available
- Sampling rate
- Known limitations
- That the system records environmental data and does not prove paranormal activity

## Validation Checklist

### Stability

- Can record for 10 minutes.
- Can record for 60 minutes.
- Handles missing Sense HAT.
- Handles missing camera.
- Handles missing microphone.
- Stop always closes files cleanly.

### Data Quality

- Sensor timestamps are monotonic.
- Audio start/end is recorded.
- Marker timestamps appear in the event timeline.
- Export files can be opened on another machine.

### Field Readiness

- Works without internet.
- Recovers from browser refresh.
- Shows storage remaining.
- Shows battery/power warning if available.
- Has a clear stop button.

## Hardware Shopping List

Required if not already owned:

- Raspberry Pi 5
- Official power supply or high-quality USB-C battery
- microSD or NVMe storage
- Case with cooling
- USB microphone

Recommended:

- Raspberry Pi Camera Module 3 NoIR or compatible NoIR camera
- IR illuminator
- Sense HAT or environmental sensor HAT
- Small tripod or mount
- Portable battery / UPS HAT
- Rugged case

Optional:

- Better I2C magnetometer
- Vibration sensor
- USB audio interface
- Thermal camera module

## First Engineering Milestones

### Milestone 1: Skeleton Service

- FastAPI app
- SQLite database
- Create/list investigations
- Start/stop session state
- Simple dashboard

### Milestone 2: Sensor Logger

- Mock sensor logger
- Sense HAT logger
- Background sampling task
- CSV export

### Milestone 3: Evidence Markers

- Marker API
- Marker button in dashboard
- Timeline display

### Milestone 4: Audio Capture

- WAV recording
- Audio metadata
- Start/stop events

### Milestone 5: Camera Capture

- Still frame capture
- Camera availability detection
- Frame events in timeline

### Milestone 6: Export Bundle

- Session JSON
- CSV files
- Media folder
- README
- ZIP export

## Open Decisions

1. Do we start with a Pi-only browser dashboard, or build a phone app in parallel?
   - Recommendation: Pi-only dashboard first.

2. Do we use Sense HAT first or individual sensors?
   - Recommendation: Sense HAT or mock sensor first, then improve with dedicated sensors.

3. Do we record video immediately?
   - Recommendation: still frames first, then video once the session lifecycle is stable.

4. Do we include spirit box / word bank in MVP?
   - Recommendation: no. Add later as transparent experimental mode.

## Definition Of Done For MVP

The MVP is done when a user can run a 60-minute investigation from the Pi dashboard, export the evidence bundle, and inspect sensor logs, event markers, audio, and camera frames outside the app.
