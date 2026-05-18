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
export const APP_VERSION = "0.2.0";

/** localStorage key for the "What's new" panel dismissal — versioned by
 *  APP_VERSION so each release re-surfaces the card. */
export const WHATS_NEW_KEY = `ss-whats-new-seen-v${APP_VERSION}`;
