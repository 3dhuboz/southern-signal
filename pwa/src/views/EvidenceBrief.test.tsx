// @vitest-environment happy-dom

/**
 * Smoke tests for the EvidenceBrief view.
 *
 * Scope is intentionally narrow: the brief is essentially a print-template
 * around a single async data source (buildEvidenceBrief). The behaviours
 * worth pinning at the view level are:
 *
 *   1. Loading placeholder renders while the brief promise is in-flight.
 *   2. The case title + AHT verdict + tier-grouped research dossiers all
 *      land on the page when the data resolves.
 *   3. The "no investigations yet" error path renders when the resolver
 *      returns null.
 *
 * Anything richer — print(), dossier note rendering, tier-downgrade rules —
 * belongs in the unit tests for buildEvidenceBrief itself. This file only
 * proves the view wiring forwards the data to the right slots.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { EvidenceBrief as EvidenceBriefShape } from "../lib/forensic/evidenceBrief";
import type { Investigation } from "../lib/db/schema";

// Module-level hoisted mocks. The view imports buildEvidenceBrief and
// findMostRecentInvestigationId from the same module; both are async data
// boundaries we want to drive deterministically per test.
const { buildEvidenceBriefFn, findMostRecentInvestigationIdFn } = vi.hoisted(() => ({
  buildEvidenceBriefFn: vi.fn(),
  findMostRecentInvestigationIdFn: vi.fn(),
}));

vi.mock("../lib/forensic/evidenceBrief", () => ({
  buildEvidenceBrief: buildEvidenceBriefFn,
  findMostRecentInvestigationId: findMostRecentInvestigationIdFn,
}));

// plainEnglish helpers are pure functions over the brief data — let the
// real implementation through. Same for ahtVerdict / research/api types.
// The CSS-modules import is handled by Vite's default resolver in test mode
// (it returns a Proxy of class names).

// Import after the mock factories register so the view's import binding
// resolves to the mock fns above.
import { EvidenceBrief } from "./EvidenceBrief";

function makeInvestigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "inv-1",
    title: "Old Town Hall",
    location_name: "Sydney NSW",
    notes: null,
    created_at: "2026-05-19T10:00:00.000Z",
    started_at: "2026-05-19T10:00:00.000Z",
    ended_at: "2026-05-19T11:30:00.000Z",
    status: "ended",
    disposition: "inconclusive",
    source: "pwa",
    culturally_sensitive: 0,
    protocol_json: null,
    protocol_hash: null,
    session_type: "active",
    paired_investigation_id: null,
    to_consent_path: null,
    commercial_use_approved: 0,
    ...overrides,
  };
}

function makeBrief(overrides: Partial<EvidenceBriefShape> = {}): EvidenceBriefShape {
  return {
    generatedAt: "2026-05-19T12:00:00.000Z",
    investigation: makeInvestigation(),
    durationSeconds: 5400,
    topMoments: [],
    totalIncrements: 0,
    peakPosterior: 0.42,
    peakPosteriorBand: "elevated",
    finalPosterior: 0.31,
    contaminationCount: 0,
    markerCount: 0,
    markersWithNotes: [],
    observationCount: 0,
    mediaByType: { audio: 0, image: 0, video: 0 },
    chainStatus: { ok: true },
    merkleRoot: "ab".repeat(32),
    acknowledgementStatement: null,
    acknowledgementAcceptedAt: null,
    culturallySensitive: false,
    h0Confidence: 0.18,
    h0FromData: false,
    h0SampleCount: 0,
    ahtVerdict: {
      verdict: "inconclusive",
      label: "INCONCLUSIVE",
      detail: "AHT can't separate signal from H₀ insufficiency.",
    },
    researchDossiers: [],
    interviews: [],
    ...overrides,
  };
}

beforeEach(() => {
  buildEvidenceBriefFn.mockReset();
  findMostRecentInvestigationIdFn.mockReset();
});

afterEach(() => {
  cleanup();
});

// Render the view at a known route so useParams resolves to our fixture id.
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/brief/:investigationId" element={<EvidenceBrief />} />
        <Route path="/brief" element={<EvidenceBrief />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("<EvidenceBrief />", () => {
  it("shows the loading placeholder while buildEvidenceBrief is pending", () => {
    // Never-resolving promise — the effect dispatches but the body never
    // gets a setState, so the view stays on the "Assembling brief…" copy.
    buildEvidenceBriefFn.mockReturnValue(new Promise(() => { /* pending */ }));

    renderAt("/brief/inv-1");

    expect(screen.getByText(/Assembling brief…/)).toBeInTheDocument();
  });

  it("renders the investigation header, AHT verdict, and tier badges when the brief resolves", async () => {
    const brief = makeBrief({
      investigation: makeInvestigation({ title: "Old Town Hall", location_name: "Sydney NSW" }),
      researchDossiers: [
        {
          id: "dossier-1",
          venueName: "Old Town Hall",
          locationHint: null,
          region: "AU",
          createdAt: "2026-05-19T08:00:00.000Z",
          model: "perplexity/sonar",
          findingCount: 2,
          citationCount: 3,
          reviewerNoteCount: 0,
          hasPrimarySources: true,
          findingsByTier: [
            {
              tier: "HERITAGE",
              findings: [
                { tier: "HERITAGE", title: "Built 1888", body: "Listed on the NSW heritage register.", sources: [{ url: "https://example.org/", label: "NSW Register" }], findingKey: "k1", reviewerNote: null },
              ],
            },
            {
              tier: "FOLKLORE",
              findings: [
                { tier: "FOLKLORE", title: "Locals report cold spots", body: "Anecdotal accounts only.", sources: [], findingKey: "k2", reviewerNote: null },
              ],
            },
          ],
          raw: { findings: [], suggestions: [], search_terms_used: [], citations_raw: [], model: "perplexity/sonar", warnings: [] },
        },
      ],
    });
    buildEvidenceBriefFn.mockResolvedValue(brief);

    renderAt("/brief/inv-1");

    // findBy on the h1 heading is unambiguous — "Old Town Hall" also shows
    // up as the dossier venueName below, so we have to target the case
    // title specifically. findBy gives the effect a chance to resolve.
    const heading = await screen.findByRole("heading", { level: 1, name: "Old Town Hall" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/Sydney NSW/)).toBeInTheDocument();
    // AHT verdict label appears as the headline of the verdict section.
    expect(screen.getByText("INCONCLUSIVE")).toBeInTheDocument();
    // Tier badges from TIER_LABEL map — heritage + folklore both render.
    expect(screen.getByText("Heritage register")).toBeInTheDocument();
    expect(screen.getByText("Folklore")).toBeInTheDocument();
    // And the brand stays as a marker that the cover section rendered.
    expect(screen.getByText(/SOUTHERN SIGNAL · CASE BRIEF/)).toBeInTheDocument();
  });

  it("renders the empty-state error when there are no investigations on disk", async () => {
    // /brief without an id makes the view call findMostRecentInvestigationId;
    // a null return means "nothing on disk yet".
    findMostRecentInvestigationIdFn.mockResolvedValue(null);

    renderAt("/brief");

    expect(await screen.findByText(/No investigations yet/)).toBeInTheDocument();
    // The view exposes a "Back to Review" button on the error path so the
    // operator isn't stranded.
    expect(screen.getByRole("button", { name: /Back to Review/ })).toBeInTheDocument();
    // buildEvidenceBrief should NOT have been called — early return on null id.
    expect(buildEvidenceBriefFn).not.toHaveBeenCalled();
  });
});
