/**
 * Tiny global session store + React hook. No external state library —
 * a Set of subscribers + a value reference is enough for V1.
 */

import { useEffect, useState } from "react";
import type { Investigation } from "./db/schema";

interface SessionState {
  current: Investigation | null;
  permissionsGranted: boolean;
}

let state: SessionState = { current: null, permissionsGranted: false };
const subscribers = new Set<(s: SessionState) => void>();

function publish() {
  for (const fn of subscribers) fn(state);
}

export function getSession(): SessionState {
  return state;
}

export function setCurrent(investigation: Investigation | null): void {
  state = { ...state, current: investigation };
  publish();
}

export function setPermissionsGranted(granted: boolean): void {
  state = { ...state, permissionsGranted: granted };
  publish();
}

export function useSession(): SessionState {
  const [snapshot, setSnapshot] = useState<SessionState>(state);
  useEffect(() => {
    const fn = (s: SessionState) => setSnapshot(s);
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  }, []);
  return snapshot;
}
