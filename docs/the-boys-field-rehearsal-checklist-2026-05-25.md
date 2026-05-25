# Southern Signal Field Rehearsal Checklist

Date: 2026-05-25

Use this before any creator-facing Southern Signal walkthrough or recorded
ghost hunt. The laptop checks prove the deployed app is healthy. This rehearsal
proves the actual phone, browser, room, network, and operator workflow are
ready.

## Go / No-Go Summary

Treat the app as ready for a serious creator demo only when every item below is
true:

- `pnpm check:launch` passes from `pwa/` on the current commit.
- The live app opens at `https://southern-signal.pages.dev/camera` on the
  phone that will be used on location.
- Camera, microphone, EVP, Spirit Box scene, Review, Setup, and Export all run
  on that phone without a refresh.
- The camera screen works in portrait and landscape.
- Overlays can be dragged into a clean layout, stay where they are placed, and
  remain readable over bright and dark camera backgrounds.
- Overlay opacity can be lowered enough for video content to remain visible
  while still keeping the EVP and session state legible.
- An EVP session can be started from the camera screen, recorded for at least
  two minutes, stopped, saved, reviewed, and exported.
- A 10-minute rehearsal recording completes without the phone sleeping, the
  app crashing, or storage warnings becoming critical.
- The operator can explain the disclaimers clearly: the app records and
  correlates investigation data; it never claims to prove paranormal activity.

No-go if any of these are true:

- The automated launch gate fails.
- The app needs repeated reloads to begin a session.
- The phone cannot grant camera or microphone access.
- The EVP recorder is only usable from the EVP tab and cannot be controlled
  from the camera workflow.
- The bottom dock, disclaimer, record control, or live overlays collide in the
  actual phone viewport.
- Export fails, or Review cannot find the test recording.
- A public episode is planned before the external Bayesian and acoustician
  sign-offs have been recorded.

## Gate 0 - Laptop Automation

Run from `pwa/`:

```bash
pnpm install
pnpm check:launch
```

Capture these artifacts after the run:

- `dist/launch-gates-report.json`
- `dist/camera-live-smoke.json`
- `dist/camera-live-smoke.png`
- Current commit hash
- Production URL used for the check

## Gate 1 - Real Phone Install

- Open `https://southern-signal.pages.dev/camera`.
- Add the PWA to the home screen on iOS, or install it from Chrome on Android.
- Open the installed app, not just the browser tab.
- Confirm camera and microphone permissions are granted.
- Confirm the phone has enough free storage for the planned recording window.
- Turn on Do Not Disturb and disable auto-lock where the OS allows it.
- Plug into power for any rehearsal over 10 minutes.

## Gate 2 - Camera And Overlay Layout

Run this twice: once in portrait and once in landscape.

- Start the camera.
- Select the Spirit Box Session scene.
- Drag the status pill, EVP panel, meter stack, timestamp, disclaimer, and
  record controls into a layout that leaves the subject visible.
- Lower overlay opacity until the camera feed is clearly visible.
- Increase opacity again just enough that labels are readable on a bright wall.
- Rotate the phone and confirm the layout does not become cramped or hidden
  behind the browser/PWA safe area.
- Take a screenshot of the final portrait and landscape layouts.

Acceptance target: the lower third must look deliberate, with no text sitting
under the record button, no controls touching the bottom dock, and no repeated
labels fighting for attention.

## Gate 3 - EVP Through Camera

- Stay on the camera screen.
- Start an EVP session from the camera overlay.
- Ask three timed questions out loud.
- Add at least one marker while the camera is still recording.
- Stop and save the EVP clip.
- Open Review and confirm the clip, markers, and timestamps are present.
- Play back the clip through the phone speaker or headphones.
- Export the session bundle and confirm the export opens.

Acceptance target: a creator should not need to leave the camera surface to
capture a clean EVP moment.

## Gate 4 - Ten-Minute Endurance Run

- Start camera recording.
- Start EVP capture from the camera overlay.
- Keep the screen awake for 10 minutes.
- Rotate once at minute 3 and once at minute 6.
- Drag one overlay at minute 5.
- Add one marker at minute 7.
- Stop and save at minute 10.
- Open Review, play the saved EVP, and export the session.

Record:

- Phone model and OS version
- Browser or installed PWA
- Start battery percentage
- End battery percentage
- Start free storage
- End free storage
- Any heat, sleep, permission, storage, or UI overlap issue

## Gate 5 - Private Live Dry Run

Only run this after Gates 0-4 pass.

- Use the same phone, same network style, and same orientation intended for
  the real shoot.
- Start a private or unlisted live destination.
- Begin camera recording and EVP capture.
- Confirm the stream sees the camera feed, not a browser permission screen.
- Confirm the stream sees the clean overlay layout.
- Record at least five minutes.
- Stop, save, then verify the local session still exists after streaming.

Acceptance target: the live output is clean enough that a producer could cut
it directly into an episode without apologising for the interface.

## Pre-Air Evidence Folder

Create one folder per rehearsal and keep:

- Launch gate JSON report
- Camera smoke screenshot
- Real-phone portrait screenshot
- Real-phone landscape screenshot
- Private live dry-run link or file
- Exported Southern Signal session bundle
- Short notes file with phone model, OS version, browser/PWA mode, and any
  issues found
- External reviewer sign-off records when the run is for a public episode

## Current Readiness Call

As of this checklist, Southern Signal can be treated as a creator demo
candidate after `pnpm check:launch` passes. It should not be treated as
public-episode ready until the real-phone rehearsal above has been completed
and the external Bayesian and acoustician sign-offs are in place.
