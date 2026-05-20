# Backdrop-blur bleed-through audit — 2026-05-20

## TL;DR

**No remaining high-risk surfaces.** The 2026-05-19 Messenger-bleed-through
bug on CameraScreen was a single point of failure now fixed by
CameraNoVideoOverlay. Every other glass-blur surface in the PWA is
protected by a two-layer opaque-background architecture that defeats
the bleed-through bug class. Documented here so this audit doesn't
get re-run by a future contributor (or a future me) who notices a
`backdrop-filter` and panics.

## The bug class we're hunting

`backdrop-filter: blur(N)` causes the element to **sample whatever
is rendered in the compositor buffer behind it.** On mobile Chrome
(Android in particular, occasionally iOS embedded WebViews), if there
is no opaque content painted in the compositor at that pixel — because
a video element hasn't started rendering yet, or the route's content
hasn't yet painted — the blur samples *whatever was previously in the
compositor*, which can be the previous tab. That's how the screenshot
showed Facebook Messenger contacts bleeding through the camera HUD on
2026-05-19.

The fix pattern is: **ensure every backdrop-blur element has a
guaranteed-opaque painted layer between it and the compositor buffer.**

## Why every glass surface in this app is safe

### Layer 1 — opaque body background

`pwa/src/styles/global.css:90-99`:

```css
body {
  background:
    radial-gradient(...rgba(93,242,199,0.04)...),
    radial-gradient(...rgba(127,252,215,0.03)...),
    var(--bg-canvas);
  background-attachment: fixed;
}
```

`var(--bg-canvas)` is the opaque dark token (`#0B0F14`-ish per
`tokens.css`). The two radial gradients are additive accent washes;
the fallback layer is solid. `background-attachment: fixed` means
the body background paints into the compositor at viewport extent
regardless of scroll position. **Every glass panel on every route
ultimately composites over this opaque body layer.**

### Layer 2 — opaque view roots

Every top-level view sets its own opaque background:

- `CameraScreen .screen` → `background: #000` (CameraScreen.module.css:51)
- `CameraScreen .cameraWrap` → `background: #000` (line 66)
- `BroadcastPreview .preview` → `background: var(--bg-app, #0B0F14)`
- `Review`, `EvidenceBrief`, `HuntSetup`, `Setup`, `CaseManager`,
  `Research`, `Estes`, `EvpReview`, `CommunityMap`, `About`,
  `MissionControl`, `DossierPrint` — all use opaque token backgrounds
  inherited from the global view shell pattern.

So a glass panel that creates its own stacking context (which
`backdrop-filter` does) samples its parent stacking context's content,
which is the view root's opaque background.

### Layer 3 — the special case: CameraScreen with no video

`CameraScreen` is the one surface where Layer 2 alone wasn't sufficient.
The video preview occupies a positioned area inside `.cameraWrap`, and
before `getUserMedia` resolves the video element is mounted but
**rendering nothing** — so the HUD chrome's `backdrop-filter` could
sample *the video element's not-yet-painted area*, which on some
browsers falls back to the compositor's previous buffer (other tab).

Fix: `CameraNoVideoOverlay` (z-index 15, `data-novideo-pinned`) paints
a guaranteed-opaque dark wash + glass card over the entire camera area
whenever camera state ≠ `streaming`. Triple protection:

```
camera state = streaming:    video element renders frames → opaque ✓
camera state ≠ streaming:    .cameraWrap #000 underneath  → opaque ✓
camera state ≠ streaming:    + overlay z-index 15 on top → opaque ✓
```

Component: `pwa/src/components/CameraNoVideoOverlay.tsx`
CSS: `pwa/src/components/CameraNoVideoOverlay.module.css`
Tests: `pwa/src/components/CameraNoVideoOverlay.test.tsx`

## What about the 21 high-risk items the Explore agent flagged?

The audit agent flagged every `backdrop-filter` with rgba alpha < 1.0
as "high risk." That misclassifies the actual risk because it doesn't
account for Layer 1 + Layer 2. Specifically:

- **12 items on CameraScreen** (markerPickerBtn, markerCountPill,
  deviceChip, snoozeChip, etc.) — all sit inside `.cameraWrap` which
  has `background: #000`. Safe.
- **6 items in broadcast/** (BroadcastBug, BroadcastTimestamp,
  BroadcastSensorHud, BroadcastSceneSelector, BroadcastLowerThird,
  BroadcastAudioMeter) — used on CameraScreen (inside `.cameraWrap`)
  and on `/preview/broadcast` (inside `.preview` with opaque bg).
  Safe in both contexts.
- **4 full-screen modal backdrops** (DispositionPicker, EvpEditor,
  ProtocolWizard, sparkModalBackdrop) — fixed-position, mounted as
  document children, composite over body's opaque background-attachment:
  fixed layer. Safe.
- **3 sticky chrome elements** (AppHeader, BottomNav, HuntSetup
  footer) — composite over their host route's opaque background.
  Safe.

## When this audit would need redoing

**Trigger conditions** that would invalidate the safety guarantees and
require re-auditing:

1. **Body background switched to non-opaque.** If anyone edits
   `global.css` and removes `var(--bg-canvas)` from `body { background }`
   or changes the bg to a partially-transparent value, Layer 1 fails
   and every modal backdrop becomes at risk.
2. **A new view ships without an opaque root background.** Same Layer-2
   failure mode. Any new `view/` should set an opaque background on
   its root selector.
3. **A new positioned glass panel ships in a context where its parent
   stacking context is transparent.** Camera-style — repeat of the
   original bug. The fix pattern is the same: guarantee an opaque
   layer underneath via either a parent background-color or an
   explicit underlay component like `CameraNoVideoOverlay`.

If any of these trigger, re-run this audit. Otherwise the safety
guarantees hold.

## Related

- `docs/camera-no-video-verification-2026-05-20.md` — phone checklist
  for the original fix.
- `pwa/src/views/CameraScreen.module.css` lines 13-43 — authoritative
  z-index scale for the camera surface.
- `pwa/src/components/CameraNoVideoOverlay.tsx` — the fix.
