/**
 * gestures — pointer-event hooks for the camera surface.
 *
 * Three small hooks that each return a *partial* set of pointer handlers.
 * They are designed to compose: long-press, double-tap and swipe all want
 * `onPointerDown`, so consumers chain handlers via the exported
 * `composeHandlers` helper rather than spreading and accidentally
 * clobbering one another.
 *
 * Implementation notes:
 *   • State lives in refs so a moving finger doesn't trigger re-renders.
 *   • Callbacks are wrapped in a ref so callers don't have to memoize.
 *   • Works for `mouse`, `touch` and `pen` — we never inspect
 *     pointerType, so all three flow through the same code path.
 *   • Multi-touch is intentionally NOT modelled: the camera surface only
 *     reacts to the primary pointer; pinch-zoom and similar are the
 *     browser's job.
 */

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// ── composeHandlers ────────────────────────────────────────────────────────

/**
 * Compose multiple handlers for the same event into one. Each handler is
 * called in order with the same event object; we don't short-circuit on
 * `defaultPrevented` because the hooks here are independent concerns.
 */
export function composeHandlers<E>(
  ...handlers: Array<((e: E) => void) | undefined>
): (e: E) => void {
  return (e: E) => {
    for (const h of handlers) {
      if (h) h(e);
    }
  };
}

// ── small internal helper: keep callback fresh without forcing memoization ──

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

// ── useLongPress ───────────────────────────────────────────────────────────

interface LongPressOptions {
  thresholdMs?: number;
}

export function useLongPress(
  callback: (active: boolean) => void,
  options?: LongPressOptions,
): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onPointerLeave: (e: ReactPointerEvent) => void;
} {
  const thresholdMs = options?.thresholdMs ?? 250;

  const cbRef = useLatestRef(callback);
  // Use any usable timer-id type. setTimeout returns number in the DOM lib.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  // Clear the timer on unmount so a pending long-press doesn't fire after
  // the component goes away.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const onPointerDown = useCallback(
    (_e: ReactPointerEvent) => {
      // If we were somehow mid-press already, ignore — the existing timer
      // or active state owns this gesture.
      if (timerRef.current !== null || activeRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        activeRef.current = true;
        cbRef.current(true);
      }, thresholdMs);
    },
    [thresholdMs, cbRef],
  );

  const endPress = useCallback(() => {
    // Pending timer? It was a short tap — clear and ignore.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    // Long-press was active — notify that it's now released.
    if (activeRef.current) {
      activeRef.current = false;
      cbRef.current(false);
    }
  }, [cbRef]);

  return {
    onPointerDown,
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onPointerLeave: endPress,
  };
}

// ── useDoubleTap ───────────────────────────────────────────────────────────

interface DoubleTapOptions {
  gapMs?: number;
}

export function useDoubleTap(
  callback: () => void,
  options?: DoubleTapOptions,
): {
  onPointerDown: (e: ReactPointerEvent) => void;
} {
  const gapMs = options?.gapMs ?? 320;
  const cbRef = useLatestRef(callback);
  const lastDownRef = useRef(0);

  const onPointerDown = useCallback(
    (_e: ReactPointerEvent) => {
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      const gap = now - lastDownRef.current;
      if (lastDownRef.current !== 0 && gap <= gapMs) {
        // Second tap within window — fire and reset so a third tap doesn't
        // chain into another double-tap.
        lastDownRef.current = 0;
        cbRef.current();
        return;
      }
      lastDownRef.current = now;
    },
    [gapMs, cbRef],
  );

  return { onPointerDown };
}

// ── useHorizontalSwipe ─────────────────────────────────────────────────────

interface HorizontalSwipeOptions {
  thresholdPx?: number;
  maxVerticalDriftPx?: number;
}

export function useHorizontalSwipe(
  onSwipe: (dir: "left" | "right") => void,
  options?: HorizontalSwipeOptions,
): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
} {
  const thresholdPx = options?.thresholdPx ?? 50;
  const maxVerticalDriftPx = options?.maxVerticalDriftPx ?? 30;
  const cbRef = useLatestRef(onSwipe);

  const startRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const currentRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    startRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    currentRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!startRef.current || startRef.current.id !== e.pointerId) return;
    currentRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const start = startRef.current;
      const current = currentRef.current ?? { x: e.clientX, y: e.clientY };
      startRef.current = null;
      currentRef.current = null;
      if (!start || start.id !== e.pointerId) return;
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      if (Math.abs(dx) > thresholdPx && Math.abs(dy) < maxVerticalDriftPx) {
        cbRef.current(dx > 0 ? "right" : "left");
      }
    },
    [thresholdPx, maxVerticalDriftPx, cbRef],
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
