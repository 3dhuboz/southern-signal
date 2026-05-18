/**
 * useFocusTrap — accessibility primitive for modal overlays.
 *
 * Plug it into any `role="dialog"` / `aria-modal="true"` surface and the
 * hook will:
 *
 *   1. Move focus into the modal on open (first tabbable element, or the
 *      container itself if there are none — `aria-modal` + `tabIndex={-1}`
 *      on the wrap keeps the dialog announcement intact).
 *   2. Trap Tab / Shift+Tab inside the modal so an external-keyboard user
 *      can't tab into the page chrome behind the overlay.
 *   3. Fire `onEscape` when Escape is pressed.
 *   4. Return focus to whatever was focused before the modal opened, so
 *      the keyboard user lands back where they started.
 *
 * Why a hook (vs. a wrapper component): every modal in this app already
 * owns its own root div + className from a module.css — wrapping them all
 * in a generic <Modal/> would either fork the layout or require a
 * Slot-style render-prop. A ref-based hook is the lighter touch.
 *
 * Usage:
 *
 *   const ref = useFocusTrap<HTMLDivElement>(open, { onEscape: close });
 *   return open && (
 *     <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="x-h">
 *       <h2 id="x-h">…</h2>
 *       …
 *     </div>
 *   );
 */

import { useEffect, useRef } from "react";

interface FocusTrapOptions {
  /** Called when Escape is pressed inside the modal. Omit to disable. */
  onEscape?: () => void;
  /**
   * When true, the hook returns focus to the previously-focused element
   * on close. Default true. Disable when the close action explicitly
   * focuses a different element (e.g. a "next step" CTA outside the modal).
   */
  restoreFocus?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
  "[contenteditable=\"true\"]",
].join(",");

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  options: FocusTrapOptions = {},
): React.MutableRefObject<T | null> {
  const ref = useRef<T | null>(null);
  const restorePointRef = useRef<HTMLElement | null>(null);
  const { onEscape, restoreFocus = true } = options;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // Remember where focus was so we can return it on close. Capture by
    // ref so a re-render of the parent (which can happen between mount
    // and the initial-focus move) doesn't lose the original anchor.
    restorePointRef.current = (document.activeElement as HTMLElement) ?? null;

    // Move focus into the modal. Prefer the first natural focusable; fall
    // back to the container itself with tabIndex=-1 so the dialog still
    // gets announced. Defer to the next microtask so any open-animation
    // transform doesn't steal the initial scroll position.
    const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
      container.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscape) {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      // Re-query inside the handler so dynamically-added inputs are
      // honoured (e.g. an inline form that mounted after the modal opened).
      const tabbables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (tabbables.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("keydown", onKey);
      if (restoreFocus && restorePointRef.current && document.contains(restorePointRef.current)) {
        try { restorePointRef.current.focus(); } catch { /* element gone */ }
      }
    };
  }, [active, onEscape, restoreFocus]);

  return ref;
}
