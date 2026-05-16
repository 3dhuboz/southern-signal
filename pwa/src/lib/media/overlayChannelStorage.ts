/**
 * Shared helpers for persisting overlay channel preferences to localStorage.
 *
 * Both LiveStreamView (internal toggle panel) and CameraScreen (external dock)
 * use the same key so switching between views preserves the operator's choices.
 */

import { DEFAULT_OVERLAY_CHANNELS, type OverlayChannels } from "./canvasCompositor";

export const OVERLAY_CHANNELS_LS_KEY = "ss-overlay-channels";

export function loadOverlayChannels(): OverlayChannels {
  try {
    const raw = localStorage.getItem(OVERLAY_CHANNELS_LS_KEY);
    if (!raw) return DEFAULT_OVERLAY_CHANNELS;
    return { ...DEFAULT_OVERLAY_CHANNELS, ...(JSON.parse(raw) as Partial<OverlayChannels>) };
  } catch {
    return DEFAULT_OVERLAY_CHANNELS;
  }
}

export function saveOverlayChannels(channels: OverlayChannels): void {
  try { localStorage.setItem(OVERLAY_CHANNELS_LS_KEY, JSON.stringify(channels)); } catch { /**/ }
}
