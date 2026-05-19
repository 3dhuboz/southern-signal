// @vitest-environment happy-dom

/**
 * PosteriorBar visual-gating smoke test.
 *
 * Simple mode (the default for new users) must hide the P=X.XX numeric
 * value and the log LR annotation. The 8px coloured bar + band label
 * (INCONCLUSIVE / ELEVATED / FLAG) carries the meaning for amateurs.
 *
 * Pro mode surfaces the full statistics. Both modes carry the
 * "Posterior is a model estimate" disclaimer — guarded separately by
 * the disclaimer-copy.smoke.test pin tests so this file doesn't have to
 * duplicate the assertion.
 *
 * Uses the forceProDetail prop to assert the visual gating regardless
 * of the persisted preference. The hook test in
 * hooks/usePresentationMode.test.tsx covers the integration with
 * localStorage.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PosteriorBar } from "./PosteriorBar";

afterEach(() => {
  cleanup();
});

import type { LogIncrement } from "../lib/posterior/posterior";

const FIXTURE_INCREMENT: LogIncrement = {
  ts: 1_700_000_000_000,
  channel: "acoustic",
  logLr: 1.6,
  logitBefore: -2.0,
  logitAfter: -0.5,
  posteriorBefore: 0.12,
  posteriorAfter: 0.38,
  reason: "acoustic transient, 3-of-3 bands coherent",
};

describe("<PosteriorBar /> Simple mode (forceProDetail=false)", () => {
  it("hides the P=X.XX numeric value", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={false}
      />,
    );
    expect(screen.queryByText(/P\s*=\s*0\.42/)).toBeNull();
  });

  it("hides the log LR annotation row", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={false}
      />,
    );
    expect(screen.queryByText(/log LR/)).toBeNull();
  });

  it("still renders the band label (INCONCLUSIVE) — amateurs need a verdict word", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={false}
      />,
    );
    // 0.42 → below 0.5 → "BELOW THRESHOLD"
    expect(screen.getByText(/BELOW THRESHOLD/)).toBeInTheDocument();
  });

  it("surfaces the View details link so users can discover Pro mode", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={false}
      />,
    );
    expect(screen.getByRole("button", { name: /view details/i })).toBeInTheDocument();
  });

  it("View details click reveals an explanation that points at Settings", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={false}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    });
    expect(screen.getByText(/hidden in Simple mode/i)).toBeInTheDocument();
    expect(screen.getByText(/Switch to Pro/)).toBeInTheDocument();
  });
});

describe("<PosteriorBar /> Pro mode (forceProDetail=true)", () => {
  it("shows the P=X.XX numeric value", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={true}
      />,
    );
    expect(screen.getByText(/P\s*=\s*0\.42/)).toBeInTheDocument();
  });

  it("shows the log LR annotation row", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={true}
      />,
    );
    expect(screen.getByText(/log LR/)).toBeInTheDocument();
  });

  it("does NOT show the View details affordance in Pro", () => {
    render(
      <PosteriorBar
        posterior={0.42}
        recentIncrements={[FIXTURE_INCREMENT]}
        prior={0.05}
        forceProDetail={true}
      />,
    );
    expect(screen.queryByRole("button", { name: /view details/i })).toBeNull();
  });
});
