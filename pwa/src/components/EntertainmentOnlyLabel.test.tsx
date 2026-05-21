// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EntertainmentOnlyLabel } from "./EntertainmentOnlyLabel";
import { ENTERTAINMENT_ONLY_LABEL } from "../lib/legal/disclaimers";

// happy-dom keeps document.body content between tests; auto-cleanup
// (vitest's globals.cleanup) is off because globals: false in our
// vitest config. Mirror the pattern used in disclaimer-copy.smoke.test.tsx.
afterEach(() => cleanup());

describe("<EntertainmentOnlyLabel />", () => {
  it("renders the canonical entertainment-only sentence (constraint #3)", () => {
    render(<EntertainmentOnlyLabel />);
    expect(screen.getByText(ENTERTAINMENT_ONLY_LABEL)).toBeInTheDocument();
  });

  it("renders as a contentinfo landmark for screen readers", () => {
    render(<EntertainmentOnlyLabel />);
    const node = screen.getByRole("contentinfo", { name: /legal disclosure/i });
    expect(node).toBeInTheDocument();
  });

  it("default variant is fixed-position (camera surface)", () => {
    const { getByTestId } = render(<EntertainmentOnlyLabel />);
    const node = getByTestId("entertainment-only-label");
    // The class name is hashed by CSS modules; assert that the class
    // attribute contains a token ending in "fixed" — the variant key.
    expect(node.className).toMatch(/fixed/);
  });

  it("inline variant flows with document layout", () => {
    const { getByTestId } = render(<EntertainmentOnlyLabel variant="inline" />);
    const node = getByTestId("entertainment-only-label");
    expect(node.className).toMatch(/inline/);
  });
});
