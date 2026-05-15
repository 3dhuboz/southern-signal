/**
 * ITC (Instrumental Trans-Communication) channel store — the bridge between
 * the standalone Spirit Box / Ovilus / EVP tools and the live video overlay.
 *
 *   SpiritBoxTool  ──┐
 *   OvilusTool      ─┼──►  setXxxEmission()  ──►  module-scope state
 *   EvpEditor       ─┘                                  │
 *                                                       ▼
 *                                  LiveStreamView ◄── subscribe()
 *                                                       │
 *                                                       ▼
 *                                  OverlayState.itc  → canvasCompositor
 *
 * Why module-level state and not Redux/Zustand/React context?
 *   - The compositor reads on every frame (30Hz); a context re-render per
 *     emit would be wasteful.
 *   - The tools are spread across the dial; a global pub/sub is simpler
 *     than threading a callback through six props.
 *   - Mirrors the existing `liveBroadcast.ts` pattern in this codebase —
 *     same shape, same subscribe ergonomics.
 *
 * Ageing is computed *at read time* by the overlay (Date.now() - timestamp),
 * not stored as a derived value, so the readout fades smoothly on the next
 * frame rather than waiting for a setTimeout to tick.
 */

import { useEffect, useState } from "react";

export type ItcSource = "spiritBox" | "ovilus" | "evp";

export interface ItcEmission {
  /** The text that was emitted — phoneme for Spirit Box, dictionary word for Ovilus, transcript line for EVP. */
  text: string;
  /** Unix ms when emitted. Age is derived at render time. */
  timestamp: number;
}

export interface ItcChannelState {
  spiritBox: ItcEmission | null;
  ovilus: ItcEmission | null;
  evp: ItcEmission | null;
}

const INITIAL: ItcChannelState = { spiritBox: null, ovilus: null, evp: null };
let current: ItcChannelState = INITIAL;
const subscribers = new Set<(s: ItcChannelState) => void>();

function publish() {
  for (const fn of subscribers) fn(current);
}

function setEmission(source: ItcSource, text: string): void {
  // Whitespace-only or empty placeholders ("—") shouldn't push noise to the overlay.
  const trimmed = text.trim();
  if (!trimmed || trimmed === "—") return;
  current = { ...current, [source]: { text: trimmed, timestamp: Date.now() } };
  publish();
}

export function setSpiritBoxEmission(text: string): void { setEmission("spiritBox", text); }
export function setOvilusEmission(text: string): void { setEmission("ovilus", text); }
export function setEvpEmission(text: string): void { setEmission("evp", text); }

/** Clear a single channel (e.g. operator wipes Spirit Box history). */
export function clearItcChannel(source: ItcSource): void {
  if (current[source] == null) return;
  current = { ...current, [source]: null };
  publish();
}

/** Reset everything (rarely needed — used by tests). */
export function resetItcChannels(): void {
  current = INITIAL;
  publish();
}

export function getItcChannels(): ItcChannelState {
  return current;
}

export function subscribeItcChannels(fn: (s: ItcChannelState) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Subscribe in React. Returns the current channel state and re-renders on emission. */
export function useItcChannels(): ItcChannelState {
  const [value, setValue] = useState<ItcChannelState>(current);
  useEffect(() => {
    const fn = (s: ItcChannelState) => setValue(s);
    subscribers.add(fn);
    setValue(current); // re-sync in case of a write before subscription
    return () => { subscribers.delete(fn); };
  }, []);
  return value;
}
