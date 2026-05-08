# Southern Signal Pi Hub

Prototype Raspberry Pi 5 investigation hub for recording paranormal field sessions as transparent evidence bundles.

## Run Locally

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r pi-hub\requirements.txt
$env:PYTHONPATH='pi-hub'
.\.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000.

## Run Tests

```powershell
.\.venv\Scripts\python -m pip install -r pi-hub\requirements-dev.txt
$env:PYTHONPATH='pi-hub'
.\.venv\Scripts\python -m unittest discover -s pi-hub\tests
```

## Current Prototype

- FastAPI local service
- SQLite investigation database
- Mock sensor logger
- Optional Sense HAT adapter with graceful fallback
- Hardware status endpoint
- Start/stop investigation lifecycle
- Optional USB microphone WAV recorder with silent WAV fallback when dependencies or hardware are unavailable
- Optional Pi camera still capture with placeholder image fallback
- Manual evidence markers
- Ordinary-cause contamination tagging for footsteps, speech, wind, phone movement, and equipment noise
- Automatic sensor anomaly cards
- Replay windows around anomalies with nearby events and media
- Evidence report endpoint with conservative confidence scoring
- Pure Python evidence confidence scoring module
- Live browser dashboard
- ZIP export with session JSON, events CSV, sensor CSV, anomaly cards, evidence report, hardware manifest, media, and README
- Protocol library for baseline, prompted EVP, and unattended room watch modes
- Evidence confidence scoring engine
- Sensor anomaly detection against local baselines

## Next Hardware Steps

- Add Sense HAT sensor adapter
- Test Sense HAT adapter on the real Pi
- Validate USB microphone WAV recording on the real Pi
- Add Pi NoIR still-frame capture
- Add systemd unit for boot startup on the Pi
