# Australia-Made Ghost Hunting App Product Brief

Date: 2026-05-07

## Working Product Name

Southern Signal

Other viable names:
- Night Ledger
- HauntKit Australia
- Signal & Shadow
- FieldGhost
- Blacklight Atlas

## One-Line Positioning

An Australia-made paranormal investigation recorder that combines mobile sensors, audio/video capture, location history, and optional Raspberry Pi field hardware into one transparent evidence timeline.

## Product Stance

This should not be positioned as a magic ghost detector.

The strongest positioning is:

> A field investigation recorder for audio, video, location, and environmental anomalies.

This keeps the product credible, still fun, and materially different from most ghost apps that rely on fake radar, random word output, or unclear sensor claims.

## Market Snapshot

The current ghost app market splits into two groups:

1. Entertainment-first apps:
   - Fake radar, jump-scare cameras, random words, heavy ads.
   - High downloads, low credibility.
   - Good for virality, weak for serious hobbyists.

2. Paranormal toolkit apps:
   - EMF/magnetometer, EVP recorder, SLS-style camera, spirit box, word banks, video filters, haunted maps.
   - Better user trust, but still often unclear about what is sensor-backed versus theatrical.

### Competitive Data

| Product | Signal | Features | Monetization | Weakness |
|---|---:|---|---|---|
| GhostTube | iOS 4.3, 5.8K ratings; Android 4.4, 1M+ downloads | Magnetometer, audio spectrum, word log, video filters, community map | Free + IAP/subscription | Still faces random-word and false-positive skepticism |
| GhostTube SLS | iOS 4.6, 8.5K ratings; Android 4.2, 5M+ downloads | SLS/body detection, LiDAR/depth on supported devices, recording, low-light filters | Free + ads/IAP | False positives from shapes, lighting, paid friction |
| Ghost Hunting Tools | iOS 4.2, 9K ratings; Android 4.4, 1M+ downloads | EMF-style scanner, radar, EVP/word bank, spirit UX | Free + ads/IAP | Ads, paywalls, fake/random complaints |
| Spirit Talker | Paid iOS/Android | Ovilus-style word/speech output from sensors | Paid upfront | Critics see it as preloaded phrase generation |
| Necrophonic | Paid iOS/Android | Sound banks, phonemes, reverse audio, white noise | Paid upfront | Needs external recording, authenticity debated |
| Ghost Science M3 | iOS paid, 4.6 rating | LiDAR/IR/AI figure detection, premium toolkit | Paid upfront | iOS-only, high category price |
| Ghost EVP Radio | Paid iOS/Android | Spirit box, EMF/motion readings, oscilloscope/spectrogram | Paid upfront | Niche, belief-dependent |

### Market Gap

Most apps compete on "spooky output."

The gap is "trustworthy investigation workflow":
- Raw sensor logs
- Calibration
- Multi-device evidence
- Good audio/video tools
- Offline-first operation
- Australian haunted/heritage context
- Exportable reports
- Clear separation between evidence, interpretation, and entertainment

## Core Differentiator

Southern Signal should be a two-tier system:

1. Mobile app only:
   - Accessible ghost hunting toolkit.
   - Audio/video/sensor capture.
   - Evidence timeline.
   - Australian haunted-place atlas.

2. Mobile app + Raspberry Pi 5 field station:
   - Serious investigation mode.
   - Independent environmental sensors.
   - Night vision.
   - Better microphones.
   - Offline local hub.
   - Exportable evidence packages.

This hardware-backed mode is the moat.

## Target Users

### Primary

Paranormal hobbyists and small investigation teams in Australia who want something more credible than random-word apps, but less expensive than a full professional equipment kit.

### Secondary

Ghost tour operators, heritage venues, dark tourism operators, and creators who want structured investigations, content capture, and post-event evidence galleries.

### Tertiary

Skeptical curious users who want a spooky but honest app that helps them explore stories, locations, and anomalies without feeling conned.

## Jobs To Be Done

1. When I visit a haunted location, I want to capture everything that happens in one place so I can review it later.
2. When I hear or see something strange, I want to check whether other sensors changed at the same time.
3. When I use a paranormal tool, I want to know whether it is raw data, analysis, or entertainment.
4. When I investigate with friends, I want everyone's observations and devices aligned on one timeline.
5. When I finish an investigation, I want a clean report I can share, archive, or use in a video.

## MVP Scope

### Mobile App MVP

Core screens:
- Home / Start Investigation
- Live Investigation Dashboard
- EVP Recorder
- Sensor Dashboard
- Evidence Timeline
- Notes and Markers
- Session Review
- Export Report
- Haunted Places / Australian Atlas
- Settings / Privacy / Calibration

Core phone features:
- Audio recording with markers
- Video recording or photo capture
- Magnetometer readings where available
- Accelerometer/gyroscope readings
- Location tagging
- Manual notes
- Event timeline
- Session export as ZIP
- CSV sensor logs
- Clear "experimental" labels for any spirit-box or word-bank feature

### Raspberry Pi 5 Field Station MVP

The Pi runs a local "Investigation Hub" service.

Core functions:
- Records sensor data locally
- Provides a local API over Wi-Fi/hotspot
- Streams live readings to the phone app
- Records timestamped audio/video
- Syncs session data after the investigation
- Works offline

Minimum Pi hardware:
- Raspberry Pi 5
- Pi NoIR camera or compatible IR camera
- IR illuminator
- USB microphone or mic array
- Sense HAT or equivalent environmental sensor board
- Battery pack / UPS HAT
- Rugged case

Useful sensor channels:
- Temperature
- Humidity
- Pressure
- Light/brightness
- Magnetometer
- Accelerometer
- Gyroscope
- Audio amplitude/noise floor
- Video frames/night vision
- Optional vibration sensor

## Evidence Timeline

The evidence timeline is the killer feature.

Example:

| Time | Event |
|---|---|
| 21:14:03 | User asks EVP question |
| 21:14:09 | Pi microphone detects audio spike |
| 21:14:10 | Phone magnetometer spike |
| 21:14:11 | Pi vibration sensor detects movement |
| 21:14:12 | NoIR camera frame marker created |
| 21:14:15 | User note: "Knock heard from east hallway" |

This helps users correlate, debunk, and tell better stories.

## Hardware Architecture

### Simple Architecture

```text
Phone App
  |
  | Local Wi-Fi / hotspot / later Bluetooth
  v
Raspberry Pi 5 Investigation Hub
  |
  +-- Pi NoIR Camera
  +-- USB Microphone
  +-- Sense HAT / sensor board
  +-- Optional vibration sensor
  +-- Local SQLite database
  +-- Local media storage
```

### Pi Service Responsibilities

- Start/stop session
- Timestamp every sensor sample
- Store sensor readings locally
- Record WAV audio
- Capture video or periodic image frames
- Expose live readings to the mobile app
- Export a session bundle
- Sync with the phone when connected

### Suggested Pi Software Stack

- Python for sensor capture
- FastAPI or Flask for local API
- SQLite for session metadata and sensor logs
- Local filesystem for WAV/video/image files
- systemd service for auto-start
- Optional WebSocket stream for live readings

## Data Model

### Investigation

- id
- title
- location name
- GPS coordinates, optional
- started_at
- ended_at
- participants
- privacy mode
- notes

### Evidence Event

- id
- investigation_id
- timestamp
- source: phone, pi, user, imported
- type: audio_marker, sensor_spike, video_frame, note, photo, calibration, question
- title
- description
- linked_file
- confidence / severity

### Sensor Sample

- id
- investigation_id
- device_id
- timestamp
- sensor_type
- x
- y
- z
- value
- unit
- metadata

### Media Asset

- id
- investigation_id
- device_id
- timestamp_start
- timestamp_end
- type: audio, video, photo
- file_path
- checksum
- notes

## Australian Differentiation

### Product Features

- Australian haunted-place atlas
- Heritage-site investigation packs
- Offline site packs for poor reception areas
- Tour operator mode
- Cultural sensitivity layer for Aboriginal and Torres Strait Islander heritage
- Privacy-first evidence vault
- Australian seasons, moon phase, tides, storms, fire danger, and state daylight-saving context

### Partner Opportunities

- Ghost tour operators
- Heritage venues
- Museums
- Regional tourism boards
- Accommodation operators
- Paranormal investigation groups
- YouTube/TikTok creators

### Important Guardrails

- Do not encourage trespassing.
- Do not expose sensitive cultural sites.
- Do not gamify burial places or restricted knowledge.
- Do not claim proof of spirits.
- Do not upload audio/video/location without explicit consent.
- Provide safety checklists for night investigations.

## Monetization Options

### Recommended

Freemium mobile app plus paid Pro subscription:
- Unlimited investigations
- Advanced audio analysis
- Pi Hub support
- Export bundles
- Cloud/private vault
- Team sessions
- Site packs

### Additional Revenue

- One-off paid site packs
- Hardware kit affiliate margin or direct kit sales
- Tour operator SaaS dashboard
- White-label tour mode
- Creator export templates

### Avoid Early

- Heavy ads
- Fake scarcity
- Paywalling basic safety/privacy controls
- Misleading "real ghost detector" claims

## MVP Validation Plan

### Prototype 1: Pi Sensor Logger

Goal:
Prove the Raspberry Pi 5 can capture synced sensor, audio, and night-vision data.

Build:
- Pi service
- Local web dashboard
- Sensor CSV logging
- WAV recording
- NoIR camera frame capture
- Manual event marker

Success:
- 60-minute stable recording
- Exportable session folder
- Timestamps aligned within 1 second
- Data readable in CSV/audio/image viewer

### Prototype 2: Mobile Companion

Goal:
Control and review Pi investigations from a phone.

Build:
- Start/stop session
- Live sensor view
- Add marker/note
- Session list
- Download/export bundle

Success:
- Phone can run a complete session without internet
- Evidence timeline displays Pi and phone events together

### Prototype 3: Field Test

Goal:
Test in a real environment.

Run:
- Home test near known interference sources
- Quiet room baseline
- Outdoor night test
- Heritage/tour-style walkthrough, if permitted

Measure:
- Sensor noise
- False positives
- Battery life
- Audio quality
- Sync reliability
- What users actually mark as interesting

## Roadmap

### Phase 1: Research + Concept

- Competitive analysis
- Sensor feasibility
- Product brief
- MVP architecture

### Phase 2: Raspberry Pi Hub Prototype

- Sensor logger
- Audio capture
- Camera capture
- Local API
- Export bundle

### Phase 3: Mobile App Prototype

- Investigation flow
- Live dashboard
- Evidence timeline
- Session review/export

### Phase 4: Australia Layer

- Haunted atlas prototype
- Site pack structure
- Tour operator workflow
- Privacy/cultural safeguards

### Phase 5: Pilot

- Test with hobbyists
- Test with one tour/operator partner
- Iterate hardware kit
- Validate pricing

## Build Recommendation

Start with the Raspberry Pi 5 hub prototype before the polished mobile app.

Reason:
The Pi hub is the thing that makes this product different. If we can prove stable synced capture, the mobile app becomes a beautiful controller and evidence browser. If we start with the app alone, we risk looking like every other paranormal app.

## Immediate Next Build Task

Build a local Raspberry Pi 5 Investigation Hub prototype:

- Python service
- SQLite session database
- CSV sensor logging
- WAV audio recording
- Optional camera capture
- Local browser dashboard
- Export session bundle

Target first demo:

> Start a 10-minute investigation, create markers, capture sensor/audio data, stop the session, and export a timestamped evidence bundle.

## Sources

- Raspberry Pi 5 official specs: https://www.raspberrypi.com/products/raspberry-pi-5/
- Raspberry Pi Sense HAT: https://www.raspberrypi.com/products/sense-hat/
- GhostTube App Store: https://apps.apple.com/us/app/ghosttube/id1429639135
- GhostTube SLS App Store: https://apps.apple.com/us/app/ghosttube-sls-camera/id1519650688
- GhostTube Google Play: https://play.google.com/store/apps/details?id=jcutting.ghosttube
- Android Sensors Overview: https://developer.android.com/guide/topics/sensors/sensors_overview
- Android Position Sensors: https://developer.android.com/develop/sensors-and-location/sensors/sensors_position
- Apple Core Motion: https://developer.apple.com/documentation/coremotion/
- OAIC Australian Privacy Principles: https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines/
