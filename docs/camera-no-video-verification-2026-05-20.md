# Camera no-video fix — phone verification checklist

Created 2026-05-20 by Claude. The fix landed on master at `2225269` and dev
at `ad43245`. This file is a 5-minute hands-on checklist to confirm the
backdrop-bleed bug actually no longer reproduces in the wild — the smoke
tests pin the state-machine contract but a phone-on-cellular sanity check
catches things the unit tests can't (service-worker cache staleness,
backdrop-filter rendering on real Chrome/Safari, font fallbacks).

## What we fixed (one sentence each)

1. **No-video fallback overlay.** When `getUserMedia` hasn't yet handed
   the video element a stream (permission idle, opening, hardware error),
   a 4-state overlay paints a guaranteed-opaque dark backdrop + glass
   card. Previously the glass HUD panels sampled-through to whatever the
   browser composited last (the previous tab — Messenger contacts in
   your screenshot).
2. **Bottom action row** redesigned (Record / Go live / Close as proper
   chips, not mashed under the shutter).
3. **SCENES chip + Settings cog** — cog removed (duplicated the Setup
   tab in BottomNav); SCENES chip lifted into a clean broadcast pill.
4. **z-index scale** documented in CameraScreen.module.css so future
   surface additions know which layer they belong on.

## Verification — phone steps

URL: `https://master.southern-signal.pages.dev/camera`
(or `https://main.southern-signal.pages.dev/camera` if you've flipped
the Cloudflare Pages production branch — see open punch list below.)

**Important: hard-reload first.** The service worker may still be holding
the broken-bug build. To force a fresh fetch:

- iOS Safari: tap the reload icon while holding the address bar →
  "Request Desktop Site" toggle off → reload again, OR clear site data
  via Settings → Safari → Advanced → Website Data → search "southern" →
  Remove.
- Android Chrome: long-press reload → "Reload" with cache bypass; OR
  ⋮ → Settings → Site settings → All sites → southern-signal.pages.dev
  → Clear & reset.

### Test 1 — Previous-tab bleed-through (the original bug)

This is the scenario your screenshot captured. The fix's whole reason
for existing.

1. Open Facebook Messenger (or any high-contrast app) full-screen for a
   few seconds so the browser actually composites it.
2. Switch back to the browser tab on `master.southern-signal.pages.dev/camera`.
3. **Before tapping anything**, look at the screen:

   - [ ] **Dark backdrop covers the entire camera area.** Solid wash,
         no Messenger contact list visible bleeding through.
   - [ ] **Glass card centred** with heading "CAMERA PERMISSION REQUIRED"
         (uppercase + tracked), 2-3 lines of explainer copy, and a
         cyan-on-dark CTA button labelled "Allow camera + mic".
   - [ ] **Camera glyph** (rectangle + lens silhouette in a circular
         tinted halo) sits above the heading.
   - [ ] **Bottom-of-screen nav** (Setup / Camera / Review / Map etc.)
         still tappable — the overlay is non-modal by design.

### Test 2 — Permission grant path

1. Tap "Allow camera + mic".
2. Browser shows its native permission sheet.

   - [ ] Overlay text changes to "STARTING CAMERA…" with a rotating
         spinner glyph.
   - [ ] **No button visible during this state** — taps mid-getUserMedia
         re-fired the permission request noisily, so the CTA disappears
         until the open completes.

3. Grant permission.

   - [ ] Live video preview fills the screen.
   - [ ] No-video overlay disappears entirely.
   - [ ] HUD chrome (BroadcastBug top-left, SensorHud + SCENES chip
         top-right, AudioMeter mid-right, BIG SHUTTER bottom) all
         visible and readable against the live video.

### Test 3 — Permission denied path

1. Reset permission (Safari: Settings → Safari → Camera/Microphone →
   southern-signal.pages.dev → Ask; Chrome: ⋮ → Settings → Site settings).
2. Reload the camera route.
3. Tap "Allow camera + mic".
4. Deny on the browser sheet.

   - [ ] Overlay text changes to "CAMERA UNAVAILABLE" with a
         strikethrough-camera glyph.
   - [ ] Body shows the actual error message (e.g.
         "NotAllowedError: Permission denied").
   - [ ] **CTA button is now "Retry"** (not "Allow camera + mic").
   - [ ] Below the button, an italic hint reads "If the prompt didn't
         appear, open your browser's site settings and re-enable camera
         and microphone for this page."

### Test 4 — Setup chrome no longer leaks into fullscreen

The LiveStreamView ships with a setup panel (resolution, scene
selection) for the standalone preview. On the camera route that
panel is hidden — it would crowd the broadcast HUD.

   - [ ] Once live preview is showing, **no setup form / dropdowns
         visible inside the camera frame**. Setup lives on the dedicated
         Setup tab in BottomNav, not on top of the live preview.

## Pass criteria

All four tests pass: ship is verified.

If any test fails:

1. Screenshot what you see.
2. Note the browser + OS + reload method used.
3. Tell Claude and we iterate.

## Known not-yet-fixed (open punch list)

- **Cloudflare Pages production branch oddity.** Pages project's
  production branch is `main` (1 week ago commit) but the GitHub
  Actions workflow pushes to `master` and `dev`. So
  `southern-signal.pages.dev` (no subdomain) may be serving stale code;
  `master.southern-signal.pages.dev` and `dev.southern-signal.pages.dev`
  are the live preview aliases pointing at the actual current builds.
  Either flip Pages production branch to `master` via wrangler, or
  rename the working branch to `main`. Flagged but not actioned —
  needs your call on which side to move.
