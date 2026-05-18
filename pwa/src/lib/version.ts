/**
 * Single source of truth for the app version. Currently a hand-maintained
 * constant; if/when we wire Vite's import.meta or read package.json at build
 * time, this is the choke point to update — every other module reads from
 * here (or eventually will, the existing hardcoded copies in manifest.ts
 * and exportBundle.ts are scheduled for cleanup).
 *
 * Bumping APP_VERSION also re-surfaces the Setup → What's new card to all
 * users via WHATS_NEW_KEY, so a release manifests as both a manifest bump
 * AND a discovery prompt in one change.
 */
export const APP_VERSION = "0.7.0";

/** localStorage key for the "What's new" panel dismissal — versioned by
 *  APP_VERSION so each release re-surfaces the card. */
export const WHATS_NEW_KEY = `ss-whats-new-seen-v${APP_VERSION}`;

/** First-run camera welcome card dismissal — versioned so a release that
 *  adds a new gesture worth surfacing (e.g. swipe-to-cycle-scene) re-shows
 *  the card to existing users without a separate flag. */
export const CAMERA_WELCOME_KEY = `ss-camera-welcome-seen-v${APP_VERSION}`;
