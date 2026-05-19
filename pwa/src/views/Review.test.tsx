// @vitest-environment happy-dom

/**
 * Smoke tests for the Review view.
 *
 * Review is the operator's post-session cockpit — audit chain banner,
 * moment-marker list, posterior timeline, export controls. The view does a
 * lot, so the smoke tests deliberately stay shallow:
 *
 *   1. Empty state: with no markers and no audit rows, the "No markers yet"
 *      placeholder renders and the page heading still lands.
 *   2. Populated state: when the audit query returns marker rows + the
 *      brief resolver returns an investigation, the marker list shows the
 *      row titles and the markers section header counts them.
 *
 * Everything past that — keyboard nav, bulk actions, export modal, manifest
 * verifier — is covered by unit tests on the underlying libs. The view
 * layer only needs to prove its data → render mapping isn't broken.
 *
 * Mocks: query / verifyAuditChain / appendAuditEntry / loadMarkerOverrides /
 * buildManifest / buildExportBundle / buildEvidenceBrief / findMost… all at
 * the module level. The three heavy sub-components (NullRateDashboard,
 * CaseManager, InterviewsList) become inert div stubs because they each
 * pull in their own DB-touching effects that aren't worth wiring here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const {
  queryFn, verifyAuditChainFn, appendAuditEntryFn, loadMarkerOverridesFn,
  buildManifestFn, buildExportBundleFn, downloadBlobFn,
  buildEvidenceBriefFn, findMostRecentInvestigationIdFn,
} = vi.hoisted(() => ({
  queryFn: vi.fn(),
  verifyAuditChainFn: vi.fn(),
  appendAuditEntryFn: vi.fn(),
  loadMarkerOverridesFn: vi.fn(),
  buildManifestFn: vi.fn(),
  buildExportBundleFn: vi.fn(),
  downloadBlobFn: vi.fn(),
  buildEvidenceBriefFn: vi.fn(),
  findMostRecentInvestigationIdFn: vi.fn(),
}));

vi.mock("../lib/db/db", () => ({ query: queryFn, exec: vi.fn(), withTransaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../lib/db/auditLog", () => ({
  verifyAuditChain: verifyAuditChainFn,
  appendAuditEntry: appendAuditEntryFn,
}));
vi.mock("../lib/db/markerOverrides", () => ({ loadMarkerOverrides: loadMarkerOverridesFn }));
vi.mock("../lib/forensic/manifest", () => ({ buildManifest: buildManifestFn }));
vi.mock("../lib/forensic/exportBundle", () => ({
  buildExportBundle: buildExportBundleFn,
  downloadBlob: downloadBlobFn,
}));
vi.mock("../lib/forensic/evidenceBrief", () => ({
  buildEvidenceBrief: buildEvidenceBriefFn,
  findMostRecentInvestigationId: findMostRecentInvestigationIdFn,
}));

// Heavy sub-components: replace each with a label-only stub so the parent's
// own render path stays exercised without pulling in their effect chains.
vi.mock("../components/NullRateDashboard", () => ({
  NullRateDashboard: () => <div data-testid="null-rate-dashboard-stub" />,
}));
vi.mock("../components/CaseManager", () => ({
  CaseManager: () => <div data-testid="case-manager-stub" />,
}));
vi.mock("../components/InterviewsList", () => ({
  InterviewsList: () => <div data-testid="interviews-list-stub" />,
}));

import { Review } from "./Review";

beforeEach(() => {
  queryFn.mockReset();
  verifyAuditChainFn.mockReset();
  appendAuditEntryFn.mockReset();
  loadMarkerOverridesFn.mockReset();
  buildManifestFn.mockReset();
  buildExportBundleFn.mockReset();
  downloadBlobFn.mockReset();
  buildEvidenceBriefFn.mockReset();
  findMostRecentInvestigationIdFn.mockReset();

  // Sensible defaults for every test — overridden per case.
  verifyAuditChainFn.mockResolvedValue({ ok: true });
  loadMarkerOverridesFn.mockResolvedValue({ dismissed: new Set(), annotations: new Map() });
  buildManifestFn.mockResolvedValue({ global_audit_chain: { merkle_root: null } });
  buildEvidenceBriefFn.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

function renderReview() {
  return render(<MemoryRouter><Review /></MemoryRouter>);
}

describe("<Review />", () => {
  it("renders the page heading and 'No markers yet' empty state when nothing is on disk", async () => {
    queryFn.mockResolvedValue([]);            // every SELECT returns []
    findMostRecentInvestigationIdFn.mockResolvedValue(null);

    renderReview();

    // The h1 always renders eagerly — preferences default to non-pro, so the
    // friendly label wins. This proves the route actually mounted.
    expect(await screen.findByRole("heading", { level: 1, name: /Your cases/i })).toBeInTheDocument();
    // Empty-state copy comes from r.empty inside the Moment markers section.
    expect(await screen.findByText(/No markers yet\./)).toBeInTheDocument();
  });

  it("renders moment-marker rows when the audit/evidence query returns markers", async () => {
    findMostRecentInvestigationIdFn.mockResolvedValue("inv-1");
    // The view fires several SELECTs serially. Match by SQL substring to
    // keep the stub specific without coupling to call order, which can
    // shift if the view reorders its loaders.
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM audit_log")) return Promise.resolve([]);
      if (sql.includes("FROM sensor_samples")) return Promise.resolve([]);
      if (sql.includes("FROM evidence_events") && sql.includes("event_type = 'audio.evp_capture'")) {
        return Promise.resolve([{ n: 0 }]);
      }
      if (sql.includes("FROM evidence_events") && sql.includes("event_type = 'marker'")) {
        return Promise.resolve([
          {
            id: "marker-1",
            timestamp: "2026-05-19T10:05:00.000Z",
            investigation_id: "inv-1",
            title: "Cold spot",
            description: null,
            metadata_json: JSON.stringify({ sessionElapsedSec: 65, category: "felt", sceneId: "walkthrough" }),
          },
          {
            id: "marker-2",
            timestamp: "2026-05-19T10:07:30.000Z",
            investigation_id: "inv-1",
            title: "Footstep",
            description: null,
            metadata_json: JSON.stringify({ sessionElapsedSec: 130, category: "sound" }),
          },
        ]);
      }
      return Promise.resolve([]);
    });

    renderReview();

    // Marker rows render their `title` as .incrementMath; findBy waits for
    // the async effect to flush both query batches + the override merge.
    expect(await screen.findByText("Cold spot")).toBeInTheDocument();
    expect(await screen.findByText("Footstep")).toBeInTheDocument();
    // The section heading counts the rows and matches the empty state's
    // bypass: "Moment markers (2)". Use a heading-role match so we don't
    // pick up filter chips that also include the substring.
    const markersHeading = await screen.findByRole("heading", { name: /Moment markers \(2\)/ });
    expect(markersHeading).toBeInTheDocument();
    // Each marker row has an Edit toggle — sanity-check that the controls
    // mounted for both rows so the row renderer actually ran end-to-end.
    const editButtons = await screen.findAllByRole("button", { name: /Edit/ });
    expect(editButtons.length).toBeGreaterThanOrEqual(2);
    // And the empty-state copy must NOT appear when markers exist.
    expect(screen.queryByText(/No markers yet\./)).not.toBeInTheDocument();
    // Quick sanity on `within` — the markers heading lives inside the
    // markers section, alongside the two rows.
    const section = markersHeading.closest("section");
    if (section) {
      expect(within(section).getByText("Cold spot")).toBeInTheDocument();
    }
  });
});
