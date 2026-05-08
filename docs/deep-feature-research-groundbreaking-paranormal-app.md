# Deep Feature Research: Groundbreaking Paranormal Investigation App

Date: 2026-05-07

## Executive Take

The app should not try to "prove ghosts" with a single fake detector. The breakthrough is to become the most rigorous paranormal field recorder available to hobbyists, creators, and ghost tour teams.

The product should help users catch potential paranormal activity by:

1. Capturing more independent evidence channels.
2. Synchronising those channels precisely.
3. Detecting ordinary false positives.
4. Preserving raw evidence.
5. Making review less biased.
6. Turning each session into a shareable, auditable evidence case file.

The core claim should be:

> Southern Signal captures, correlates, and preserves anomalous field events so investigators can review what happened and rule out ordinary causes.

Avoid:

> Southern Signal proves ghosts are real.

## Research Findings

### 1. Most Paranormal Apps Over-Index On Output, Not Evidence

Current leading apps focus on:

- Magnetometer readings
- Word logs
- SLS/body detection
- Spirit box / VOX sound banks
- Video filters
- Haunted-place maps
- EVP recording

GhostTube, for example, uses phone sensors, magnetic field readings, sound spectrum analysis, generated word logs, low-light video filters, and community haunted-place data. GhostTube VOX uses phone magnetometer changes to trigger sounds from online radio streams. Ghost Science M3 claims LiDAR-enabled infrared/grid imaging and AI figure detection on supported iPhones. Necrophonic uses sound banks, phonemes, reverse audio, and white-noise-style banks.

The gap: these tools rarely produce a rigorous, synchronised, debunkable case file. They produce moments.

### 2. EVP Is Valuable But Highly Vulnerable To Bias

EVP research and investigation guides repeatedly warn about:

- Audio pareidolia: hearing words in ambiguous noise.
- Environmental contamination.
- Radio or electrical interference.
- Mechanical recorder noise.
- Low bit-rate compression artifacts.
- Repeated listening increasing confidence in false interpretations.
- Review bias when the reviewer is told what to hear.

ASSAP notes that without video or good contextual logging, it can be difficult to recall natural sound sources after the fact. EVP guidance also recommends tagging background noises during recording so they are not mistaken for anomalies later.

Implication:

The app should not merely record audio. It should manage the whole EVP chain: clean capture, live tagging, contamination logging, blind review, waveform/spectrogram, and cross-checking against video and movement.

### 3. Phone EMF Is Often Misunderstood

Phones can read magnetic field data through a magnetometer, but that is not the same as a professional EMF meter. Phone magnetometers are primarily compass sensors. They generally do not measure RF radiation, electric fields, or all AC magnetic fields. Nearby magnets, metal, phone cases, chargers, speakers, appliances, wiring, and the phone itself can distort readings.

Android exposes geomagnetic field sensors, and Apple Core Motion exposes accelerometer, gyroscope, magnetometer, and barometer data where available. But the app should label phone magnetometer data as magnetic field data, not as a definitive spirit/EMF detector.

Implication:

The app can be better than competitors by saying exactly what was measured, with calibration and interference warnings.

### 4. Raspberry Pi Hardware Is The Credibility Wedge

The Pi hub allows Southern Signal to move beyond phone-only limitations.

With a Sense HAT, the Pi can capture:

- Temperature
- Humidity
- Pressure
- Colour / brightness
- Orientation
- Movement
- Gyroscope
- Accelerometer
- Magnetometer

With Camera Module 3 NoIR Wide and IR illumination, the Pi can capture actual infrared-assisted night vision. Raspberry Pi states that Camera Module 3 NoIR variants have no IR filter and can be used as night-vision cameras when paired with infrared lighting.

Implication:

The app should treat the Pi as a stationary witness: a calibrated, timestamped, independent field station that can watch a room while investigators move around.

### 5. Time Synchronisation Is A Product Feature, Not An Implementation Detail

Multi-sensor evidence only matters if timestamps are trustworthy. Research on multi-sensor systems highlights that data quality depends heavily on time accuracy; drift between clocks can make audio, video, and acceleration correlation error-prone.

Implication:

The app should expose sync quality:

- Phone clock versus Pi clock
- Last sync time
- Estimated drift
- Session timestamp confidence
- Optional clap/snap sync marker at start and end

This sounds nerdy, but it is foundational. Without it, cross-sensor evidence is mush.

## Groundbreaking Feature Set

### Feature 1: Evidence Confidence Engine

The app should score an event based on how many independent channels changed at the same time.

Example:

| Signal | Evidence weight |
|---|---:|
| User marker only | Low |
| Audio spike only | Low |
| Audio spike + movement detected | Medium |
| Audio spike + Pi vibration + camera frame + no human motion nearby | High |
| EVP-like audio + blind reviewer agreement + no tagged contamination + cross-device capture | Very high |

The score should not say "ghost." It should say:

- Low confidence anomaly
- Correlated anomaly
- Contaminated event
- Needs review
- Strong candidate event

Why it is groundbreaking:

Most apps generate spooky output. This one ranks evidence quality.

### Feature 2: Multi-Witness Capture

Use the phone and Pi as independent witnesses.

Modes:

- Phone handheld recorder
- Pi stationary room recorder
- Optional second phone witness
- Optional second Pi room node later

An event becomes stronger if it appears on more than one device. A sound captured by the Pi mic and phone mic at slightly different amplitudes is more interesting than a sound captured only inside one recorder.

Why it matters:

Single-device evidence is easy to dismiss as device noise. Multi-device evidence helps separate environmental events from hardware artifacts.

### Feature 3: Blind EVP Review

When a possible voice is found, reviewers should not initially see the suggested words.

Workflow:

1. App extracts a candidate clip.
2. Reviewer listens without transcript.
3. Reviewer types what they hear.
4. App compares responses between reviewers.
5. Only then does it reveal investigator notes.

Output:

- Agreement score
- Number of reviewers
- Common words heard
- Disagreement notes

Why it matters:

This directly fights audio pareidolia and suggestion bias.

### Feature 4: Contamination Tagging

During recording, users can tap quick tags:

- Footstep
- Breath
- Whisper
- Clothing noise
- Vehicle
- Animal
- Wind
- Door
- Plumbing
- Phone notification
- Investigator speaking
- Unknown

The app should also automatically mark likely contamination:

- Phone moved
- Pi bumped
- High wind/noise floor
- Clipping
- Camera exposure change
- Known nearby device interference

Why it matters:

EVP review often fails because nobody remembers what else happened. A fast tag system protects evidence.

### Feature 5: Baseline And Control Protocols

Before a session starts, the app should run a guided baseline:

- 2 minutes quiet-room audio baseline
- Magnetometer baseline
- Temperature/humidity/pressure baseline
- Light baseline
- Vibration baseline
- Wi-Fi/Bluetooth/phone state snapshot
- Camera exposure/noise baseline

Control mode:

- Same room, no people
- Same room, investigators present
- Door open/closed
- Known appliance on/off
- Phone nearby/far away
- IR on/off

Why it matters:

An anomaly means little without knowing normal behaviour for that location and gear.

### Feature 6: Interference Radar

Not a fake ghost radar. A real interference checklist and detector.

The app should warn about:

- Phone magnets / MagSafe-style cases
- Chargers and power banks
- Speakers
- Laptops
- Routers
- Power panels
- Metal furniture
- Moving the phone
- High CPU load on the phone affecting magnetic readings
- Camera autofocus/exposure changes
- IR reflections from glass/mirrors

Why it matters:

This makes the app more credible than competitors and helps reduce false positives.

### Feature 7: Synchronized Evidence Timeline

The core UI should be a timeline that aligns:

- Audio waveform
- Spectrogram
- Pi sensor readings
- Phone sensor readings
- Video frames
- Manual tags
- Location/room position
- Questions asked
- Review notes
- Hardware status

The user should be able to click an event and see the surrounding 30 seconds before and after across every sensor stream.

Why it matters:

Paranormal investigation is about correlation. This is the feature competitors mostly lack.

### Feature 8: Anomaly Replay

For each candidate event, generate a replay card:

- 10 seconds before / 20 seconds after
- Audio clip
- Still frame or video segment
- Sensor graphs
- Investigator notes
- Contamination tags
- Confidence explanation

Export as:

- ZIP evidence bundle
- PDF case report
- Creator-friendly video overlay
- JSON/CSV for analysis

Why it matters:

This turns raw data into reviewable evidence without hiding the raw files.

### Feature 9: Environmental Drift Map

For longer investigations, map slow changes:

- Temperature drift
- Pressure changes
- Humidity changes
- Light changes
- Vibration trends
- Magnetic baseline drift

Then flag sudden deviations from that baseline.

Why it matters:

A sudden cold spot is less meaningful if the entire building is cooling at the same rate. Drift-aware detection is smarter.

### Feature 10: Prompted EVP Protocols

Instead of an open-ended recorder, the app should support structured sessions:

- Question timer
- Silence period
- Response window
- Auto-marker after every question
- Randomised question mode
- Control questions
- "Do not tell reviewers the question" review mode

Example:

| Time | Step |
|---|---|
| 00:00 | Baseline silence |
| 02:00 | Ask question 1 |
| 02:10 | Silent response window |
| 02:40 | Ask question 2 |
| 02:50 | Silent response window |

Why it matters:

Structured protocols create cleaner evidence than wandering around recording everything.

### Feature 11: Hardware Health And Chain Of Custody

Every session should include:

- Device model
- Sensor availability
- App version
- Pi software version
- Sample rates
- Calibration status
- Storage status
- Battery/power status
- File checksums
- Export timestamp

Why it matters:

If users want evidence to be taken seriously, the app must preserve provenance.

### Feature 12: Room Scan Mode

Before investigation, walk the room and build a false-positive map:

- Power outlets
- Appliances
- Mirrors/windows
- Metal furniture
- Draft sources
- Noisy floorboards
- Doors
- HVAC vents
- Road/rail noise direction

The app stores these as known contamination zones.

Why it matters:

Most ghost hunting apps ignore the physical environment. A real investigation app should understand the room.

### Feature 13: Investigator Presence Tracking

Use phone motion/location/manual status to know whether a person was near the event.

States:

- Investigator holding phone
- Phone placed stationary
- Investigator speaking
- Investigator moving
- Room unattended

An event in an unattended room, captured by the Pi, with no nearby movement is more interesting than an event while people are walking around.

Why it matters:

Human contamination is one of the biggest evidence problems.

### Feature 14: Experiment Library

Built-in repeatable experiments:

- Quiet EVP
- Call-and-response EVP
- Knock-response test
- Object movement watch
- Doorway watch
- Temperature drift test
- Trigger-object watch
- Room unattended watch
- IR motion watch
- Control room comparison

Each experiment defines:

- Required sensors
- Setup steps
- Duration
- What counts as a candidate event
- What contamination to watch for

Why it matters:

This turns the app from a gadget into an investigation methodology.

### Feature 15: Skeptic Mode

A toggle that makes the app stricter:

- No word bank
- No spirit box
- No entertainment labels
- Raw readings only
- Blind EVP review
- Minimum two-channel correlation
- Automatic contamination warnings
- Stronger export metadata

Why it matters:

Serious users will trust a product that can turn the theatrics off.

### Feature 16: Experimental Spirit Box With Audit Trail

If we include a spirit box or word bank, it must be auditable.

Rules:

- Label it experimental.
- Store the sound/word source.
- Store the random seed or trigger condition.
- Store the exact sensor threshold that triggered output.
- Never mix spirit-box output into raw EVP evidence.
- In review, clearly separate "generated audio" from "recorded environmental audio."

Why it matters:

Users want the feature, but it is credibility poison unless isolated and transparent.

### Feature 17: Australia-Made Haunted Field Packs

For Australian locations:

- Site history
- Known false-positive hazards
- Safety warnings
- Cultural sensitivity notes
- Operator-approved investigation route
- Offline map
- Prompt sets based on historical context
- Evidence report template

Important:

Do not expose sensitive Aboriginal cultural sites or encourage trespass.

Why it matters:

Australia-made should mean locally informed, not just branded.

### Feature 18: "Anomaly Hunt" Live Assistant

While recording, the app watches for candidate events and suggests next steps:

- "Audio spike detected. Hold silence for 20 seconds."
- "Phone moved; marking this event as contaminated."
- "Magnetic spike coincided with charger proximity warning."
- "Pi detected vibration but no audio spike."
- "Repeat the last question?"
- "Run a control test with investigators outside the room."

Why it matters:

It helps users collect better evidence in the moment.

### Feature 19: Post-Session Evidence Triage

After the session, the app automatically groups events:

- Strong correlated candidates
- Audio-only candidates
- Video-only candidates
- Sensor-only candidates
- Contaminated events
- Long quiet periods

This saves hours of review.

Why it matters:

The pain is not only recording; it is reviewing hours of boring footage.

### Feature 20: Public Evidence Standard

Create a Southern Signal Evidence Standard:

- Raw files preserved
- No destructive audio editing
- All transformations documented
- Blind review supported
- Sensor calibration included
- Contamination tags included
- Chain-of-custody checksum included

Why it matters:

This could make the app the trusted format for paranormal investigation evidence.

## Feature Priority

### MVP: Must Build First

1. Synchronized evidence timeline
2. Pi + phone multi-witness capture
3. Baseline protocol
4. Contamination tagging
5. Hardware status and chain of custody
6. Exportable evidence bundle
7. Audio waveform/spectrogram
8. Manual markers
9. Sensor graphs
10. Room unattended mode

### V1: Breakthrough Layer

1. Evidence Confidence Engine
2. Blind EVP review
3. Anomaly replay cards
4. Interference radar
5. Environmental drift map
6. Prompted EVP protocols
7. Post-session triage
8. Creator export overlays
9. Australia site packs
10. Skeptic Mode

### V2: Advanced / Moat Features

1. Multi-Pi room mesh
2. Optional GPS/PPS or PTP time sync
3. Thermal camera support
4. External EMF/RF meter support
5. Machine-learning anomaly detection trained on the user's own baseline
6. Tour operator mode
7. Community evidence review
8. Evidence reputation system
9. Partner site dashboards
10. Open evidence standard

## Recommended App Architecture

### Mobile App

- Investigation controller
- Phone sensor recorder
- Audio/video recorder
- Notes and markers
- Timeline review
- Blind review
- Export/share
- Haunted atlas/site packs

### Pi Hub

- Stationary witness
- Environmental sensors
- Audio recorder
- NoIR camera capture
- IR mode
- Local API
- Offline storage
- Evidence export

### Optional Cloud

- Private evidence vault
- Multi-reviewer blind EVP
- Site packs
- Team collaboration
- Tour operator galleries
- Creator publishing

## Evidence Scoring Model

Suggested event model:

```text
event_score =
  independent_device_score
  + sensor_correlation_score
  + clean_audio_score
  + visual_support_score
  + unattended_room_score
  + blind_review_agreement_score
  - contamination_penalty
  - calibration_penalty
  - sync_uncertainty_penalty
```

Display this as a plain-English explanation, not just a number:

> Strong candidate: captured by Pi microphone and phone microphone, no investigator movement detected, no clipping, and 3 blind reviewers independently heard similar syllables.

Or:

> Weak candidate: audio-only spike during investigator movement; likely clothing or footstep contamination.

## Key Product Principle

The best app will not be the one that produces the scariest result.

The best app will be the one that says:

> "Here is what happened, here is what changed, here is what probably caused it, and here is why this event still deserves review."

## Sources

- GhostTube Original: https://ghosttube.com/blogs/ghosttube/ghosttube-original
- GhostTube VOX: https://ghosttube.com/en-gb/products/ghosttube-vox
- GhostTube Google Play listing: https://play.google.com/store/apps/details?id=jcutting.ghosttube
- Ghost Science M3 App Store: https://apps.apple.com/gb/app/ghost-science-m3/id1360656789
- Necrophonic official site: https://necrophonic.vercel.app/
- ASSAP, Recording EVP: https://www.assap.ac.uk/articles/detail/recording-evp
- ASSAP, Analysing EVP and paranormal sound recordings: https://www.assap.ac.uk/articles/detail/analysing-evp-and-paranormal-sound-recordings
- HowStuffWorks, How EVP Works: https://science.howstuffworks.com/science-vs-myth/afterlife/evp.htm
- Android position sensors: https://developer.android.com/develop/sensors-and-location/sensors/sensors_position
- Apple Core Motion: https://developer.apple.com/documentation/coremotion/
- Raspberry Pi Sense HAT: https://www.raspberrypi.com/products/sense-hat/
- Raspberry Pi Camera Module 3: https://www.raspberrypi.com/products/camera-module-3/
- Movement Ecology, time synchronisation for multi-source data: https://movementecologyjournal.biomedcentral.com/articles/10.1186/s40462-024-00512-7
- Sensors, system-level offline time synchronisation using Raspberry Pi 5: https://www.mdpi.com/1424-8220/26/8/2519
