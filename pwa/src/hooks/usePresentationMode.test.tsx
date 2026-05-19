// @vitest-environment happy-dom

/**
 * usePresentationMode hook test.
 *
 *   • Default is "simple" — a brand-new install with nothing persisted
 *     must NOT land in Pro.
 *   • setMode("pro") flips the hook AND mutates localStorage so the
 *     preference survives a reload.
 *   • isPro reflects the current mode.
 *
 * We test through a tiny probe component because the React rules of hooks
 * forbid calling them outside render. renderHook would work too but the
 * probe pattern matches the rest of this codebase's smoke tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePresentationMode } from "./usePresentationMode";

const PREFS_KEY = "ss-preferences-v1";

function Probe() {
  const { mode, isPro, setMode } = usePresentationMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="is-pro">{isPro ? "yes" : "no"}</span>
      <button type="button" onClick={() => setMode("pro")}>To Pro</button>
      <button type="button" onClick={() => setMode("simple")}>To Simple</button>
    </div>
  );
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
});

describe("usePresentationMode", () => {
  it("defaults to 'simple' when no preference is persisted", () => {
    render(<Probe />);
    expect(screen.getByTestId("mode").textContent).toBe("simple");
    expect(screen.getByTestId("is-pro").textContent).toBe("no");
  });

  it("flips to 'pro' when setMode('pro') is invoked", () => {
    render(<Probe />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "To Pro" }));
    });
    expect(screen.getByTestId("mode").textContent).toBe("pro");
    expect(screen.getByTestId("is-pro").textContent).toBe("yes");
  });

  it("persists the mode to localStorage so it survives reloads", () => {
    render(<Probe />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "To Pro" }));
    });
    const raw = localStorage.getItem(PREFS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { experienceMode?: string };
    expect(parsed.experienceMode).toBe("pro");
  });

  it("reads the persisted mode on first mount when localStorage already has it", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ experienceMode: "pro" }));
    render(<Probe />);
    expect(screen.getByTestId("mode").textContent).toBe("pro");
    expect(screen.getByTestId("is-pro").textContent).toBe("yes");
  });

  it("round-trips simple → pro → simple", () => {
    render(<Probe />);
    expect(screen.getByTestId("mode").textContent).toBe("simple");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "To Pro" }));
    });
    expect(screen.getByTestId("mode").textContent).toBe("pro");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "To Simple" }));
    });
    expect(screen.getByTestId("mode").textContent).toBe("simple");
  });
});
