/**
 * Module-level live-broadcast state. LiveStreamView is the single writer;
 * any view (AppHeader, status bars, future overlays) can subscribe so an
 * operator who's scrolled into the dial — or on a different tab entirely —
 * still sees REC / LIVE without scrolling back to the broadcast section.
 *
 * Same subscriber pattern as preferences / session for consistency.
 */

import { useEffect, useState } from "react";

export interface LiveBroadcastState {
  recording: boolean;
  broadcasting: boolean;
}

const INITIAL: LiveBroadcastState = { recording: false, broadcasting: false };
const subscribers = new Set<(s: LiveBroadcastState) => void>();
let current: LiveBroadcastState = INITIAL;

export function setLiveBroadcastState(next: LiveBroadcastState): void {
  if (next.recording === current.recording && next.broadcasting === current.broadcasting) return;
  current = next;
  for (const fn of subscribers) fn(current);
}

export function getLiveBroadcastState(): LiveBroadcastState {
  return current;
}

export function useLiveBroadcastState(): LiveBroadcastState {
  const [value, setValue] = useState<LiveBroadcastState>(current);
  useEffect(() => {
    const fn = (s: LiveBroadcastState) => setValue(s);
    subscribers.add(fn);
    // Re-sync to avoid races where the writer fired before subscription.
    setValue(current);
    return () => { subscribers.delete(fn); };
  }, []);
  return value;
}
