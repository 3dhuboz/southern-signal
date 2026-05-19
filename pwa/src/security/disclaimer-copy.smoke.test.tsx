// @vitest-environment happy-dom

/**
 * Disclaimer copy smoke tests.
 *
 * Eight standing disclaimers are surfaced across the app — they are the
 * commitment to an external Bayesian + acoustician review before any
 * premiere. A future copy-tidying pass could silently delete a load-bearing
 * sentence; this file is the alarm bell.
 *
 * Coverage strategy
 * -----------------
 *   • Render-based assertion for the two components whose dependency
 *     surface is small enough to mount without scaffolding the whole app —
 *     PosteriorBar (pure props) and About (Router only).
 *   • Source-text grep for the others. Mounting MissionControl, Review,
 *     SimpleMissionView, AiAssistant, BaitToneTool, EvpEditor, or
 *     EvidenceBrief in a smoke test would require mocking ~a dozen DB /
 *     audio / crypto / OPFS modules each — far more brittle than checking
 *     the canonical sentence is still in the source.
 *
 * The grep checks are a weaker assertion, but they still catch the failure
 * mode that motivated this file: someone running a copy clean-up pass
 * accidentally deletes the only place a disclaimer is rendered, and nothing
 * notices until premiere day.
 *
 * If a real render-level regression is suspected, fold that component's
 * smoke into its own *.test.tsx (next to its source) rather than expanding
 * this one — the boundary kept narrow stays maintainable.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PosteriorBar } from "../components/PosteriorBar";
import { About } from "../views/About";

afterEach(() => {
  cleanup();
});

// Resolve component sources from this test file's directory. import.meta.dirname
// would be cleaner but isn't guaranteed across the vitest config; the relative
// hop is one level up from src/security/ to src/, then into the component dir.
function readSource(relativePath: string): string {
  const here = resolve(__dirname, "..");
  return readFileSync(resolve(here, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// Render-based assertions — components light enough to mount directly.
// ---------------------------------------------------------------------------

describe("<PosteriorBar /> disclaimer copy", () => {
  it("renders the model-estimate AND the 60° sector quadrant disclaimers", () => {
    render(<PosteriorBar posterior={0.42} recentIncrements={[]} prior={0.05} />);
    // The original disclaimer.
    expect(screen.getByText(/Posterior is a model estimate/)).toBeInTheDocument();
    // The newly-added sector framing — load-bearing for the acoustician sign-off.
    expect(screen.getByText(/Sectors are 60° quadrants/)).toBeInTheDocument();
  });
});

describe("<About /> disclaimer copy", () => {
  it("renders the 'not peer-reviewed' disclosure", () => {
    render(<MemoryRouter><About /></MemoryRouter>);
    // The external-review section is the natural home for this disclosure.
    // findBy/getBy uses a substring match — the surrounding paragraph can be
    // reflowed without breaking the assertion.
    expect(screen.getByText(/not been peer-reviewed/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Source-text grep assertions — components too heavy to mount in a smoke
// test. The constraint these tests enforce is "the canonical sentence is
// still typed into the source file"; rendering is covered by the component's
// own integration / view tests.
// ---------------------------------------------------------------------------

describe("source-text disclaimer presence", () => {
  it("SimpleMissionView still says 'AI proposes; you decide'", () => {
    const src = readSource("components/SimpleMissionView.tsx");
    expect(src).toMatch(/AI proposes; you decide/);
  });

  it("MissionControl still says 'Sector accuracy ±60°'", () => {
    const src = readSource("views/MissionControl.tsx");
    expect(src).toMatch(/Sector accuracy ±60°/);
  });

  it("AiAssistant still says 'AI proposes; the investigator decides'", () => {
    const src = readSource("components/AiAssistant.tsx");
    expect(src).toMatch(/AI proposes; the investigator decides/);
  });

  it("BaitToneTool still says 'timed marker' and 'causal stimulator'", () => {
    const src = readSource("components/BaitToneTool.tsx");
    // The canonical sentence is split across element boundaries
    // (<strong>timed marker</strong> ... not as a causal stimulator), so the
    // assertion is the two anchors rather than one literal phrase. The
    // "as" connector is tolerated so a minor copy edit (drop the "as")
    // wouldn't break the test for the wrong reason.
    expect(src).toMatch(/timed marker/);
    expect(src).toMatch(/not (?:a|as a) causal stimulator/);
  });

  it("EvpEditor still references the append-only 'audit chain'", () => {
    const src = readSource("components/EvpEditor.tsx");
    expect(src).toMatch(/audit chain/);
    // Also pin the active sentence — "saves are appended to the audit chain"
    // — so a future copy edit that drops the append-only framing trips.
    expect(src).toMatch(/appended to the audit chain/);
  });

  it("Review still flags AI failure as a 'model limitation'", () => {
    // Lower-case in source: "that's a model limitation". The canonical
    // framing in lib/posterior/ahtVerdict.ts is "MODEL limitation" — case-
    // insensitive match catches either form so a copy edit on Review.tsx
    // wouldn't break this assertion just by adjusting capitalisation.
    const src = readSource("views/Review.tsx");
    expect(src).toMatch(/model limitation/i);
  });

  it("EvidenceBrief still carries 'AHT eliminates explanations' AND the tool-specific reference", () => {
    const src = readSource("views/EvidenceBrief.tsx");
    // Source reads "(AHT) eliminates explanations" — the parens break a
    // strict substring match, so a tolerant regex pins the intent.
    expect(src).toMatch(/AHT\)? eliminates explanations/);
    // New footer sentence — added as part of this disclaimer hardening pass.
    expect(src).toMatch(/tool-specific disclaimers are surfaced/);
  });

  it("PosteriorBar source still says 'Posterior is a model estimate' AND 'Sectors are 60° quadrants'", () => {
    // Belt-and-braces alongside the render assertion above: if the file
    // ever lazy-loads its copy, the render check still passes but a
    // grep-only deletion would slip through.
    const src = readSource("components/PosteriorBar.tsx");
    expect(src).toMatch(/Posterior is a model estimate/);
    expect(src).toMatch(/Sectors are 60° quadrants/);
  });

  it("About source still says 'not been peer-reviewed'", () => {
    const src = readSource("views/About.tsx");
    expect(src).toMatch(/not been peer-reviewed/);
  });
});
