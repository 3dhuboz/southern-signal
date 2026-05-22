// @vitest-environment happy-dom

/**
 * CameraMarkerToast smoke tests — pin the a11y semantics and the visible
 * confirmation copy. The whole point of the toast is that it lands in the
 * AT announcement queue without yanking focus.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CameraMarkerToast } from "./CameraMarkerToast";

afterEach(() => {
  cleanup();
});

describe("<CameraMarkerToast />", () => {
  it("renders the MARKED confirmation copy", () => {
    render(<CameraMarkerToast />);
    expect(screen.getByText(/marked/i)).toBeInTheDocument();
  });

  it("role=status + aria-live=polite — won't interrupt the AT", () => {
    render(<CameraMarkerToast />);
    const toast = screen.getByRole("status");
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveAttribute("aria-live", "polite");
  });
});
