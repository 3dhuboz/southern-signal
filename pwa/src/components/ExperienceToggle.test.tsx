// @vitest-environment happy-dom

/**
 * ExperienceToggle smoke test.
 *
 * The header pill is the always-visible Simple/Pro toggle — Setup carries
 * a larger segmented control, but the pill is the global, instant switch.
 * Defaults must be Simple, clicking must flip to Pro and persist the
 * preference so other surfaces respond.
 *
 * Setup itself is too heavy to mount in a smoke test (DB, audio, sync
 * panels) — its toggle row is asserted via a source-text grep below, the
 * same pattern disclaimer-copy.smoke.test uses for heavy views.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExperienceToggle } from "./ExperienceToggle";

const PREFS_KEY = "ss-preferences-v1";

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
});

describe("<ExperienceToggle />", () => {
  it("renders the SIMPLE label by default (no prefs persisted)", () => {
    render(<ExperienceToggle />);
    expect(screen.getByRole("button").textContent).toContain("SIMPLE");
  });

  it("flips to PRO when clicked", () => {
    render(<ExperienceToggle />);
    const button = screen.getByRole("button");
    act(() => { fireEvent.click(button); });
    expect(button.textContent).toContain("PRO");
  });

  it("persists the choice to localStorage so other surfaces pick it up", () => {
    render(<ExperienceToggle />);
    act(() => { fireEvent.click(screen.getByRole("button")); });
    const raw = localStorage.getItem(PREFS_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { experienceMode?: string };
    expect(parsed.experienceMode).toBe("pro");
  });

  it("starts at PRO when preferences already have experienceMode=pro", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ experienceMode: "pro" }));
    render(<ExperienceToggle />);
    expect(screen.getByRole("button").textContent).toContain("PRO");
  });
});

// Source-text guard for the Setup view: the Setup view is too heavy to
// mount in a smoke test, but the segmented control must remain present —
// it's the discoverable home for the toggle. A copy-edit pass that deletes
// the "Presentation mode" panel header would silently break the
// "Switch to Pro in Settings" hint elsewhere; this is the alarm bell.
describe("Setup view source-text — Presentation mode panel still present", () => {
  it("Setup.tsx still defines a Presentation mode section with both segments", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "views", "Setup.tsx"),
      "utf8",
    );
    expect(src).toMatch(/Presentation mode/);
    expect(src).toMatch(/experienceMode:\s*"simple"/);
    expect(src).toMatch(/experienceMode:\s*"pro"/);
    expect(src).toMatch(/Simple mode hides advanced statistics/);
  });
});
