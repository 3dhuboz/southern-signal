// @vitest-environment happy-dom

/**
 * CameraMarkerPill smoke tests — pin the singular/plural label, the
 * popover open/close branches, the per-category breakdown rendering,
 * and the navigation wiring.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { CameraMarkerPill } from "./CameraMarkerPill";

afterEach(() => {
  cleanup();
});

const noByCategory = { sound: 0, movement: 0, felt: 0, untagged: 0 };

describe("<CameraMarkerPill />", () => {
  it("count=1 → singular 'marker' label", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={1}
        open={false}
        byCategory={{ ...noByCategory, sound: 1 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.getByText("marker")).toBeInTheDocument();
    expect(screen.queryByText("markers")).toBeNull();
  });

  it("count=3 → plural 'markers' label", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open={false}
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.getByText("markers")).toBeInTheDocument();
  });

  it("popover hidden when open=false", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open={false}
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("popover visible when open=true — dialog semantics + breakdown rows", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open
        byCategory={{ sound: 2, movement: 1, felt: 0, untagged: 0 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: /marker breakdown by category/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/2 sound/i)).toBeInTheDocument();
    expect(screen.getByText(/1 movement/i)).toBeInTheDocument();
    // Empty categories are filtered out.
    expect(screen.queryByText(/felt/i)).toBeNull();
  });

  it("popover shows Open Review link", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.getByRole("button", { name: /open review/i })).toBeInTheDocument();
  });

  it("clicking the pill button invokes onToggle", () => {
    const onToggle = vi.fn();
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open={false}
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={onToggle}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /3 markers this session/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("clicking Open Review invokes onNavigateReview", () => {
    const onNavigateReview = vi.fn();
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    render(
      <CameraMarkerPill
        count={3}
        open
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={onNavigateReview}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open review/i }));
    expect(onNavigateReview).toHaveBeenCalledTimes(1);
  });

  it("aria-expanded on the pill mirrors open state", () => {
    const wrapRef = createRef<HTMLDivElement>();
    const trapRef = createRef<HTMLDivElement>();
    const { rerender } = render(
      <CameraMarkerPill
        count={3}
        open={false}
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.getByRole("button", { name: /3 markers/i })).toHaveAttribute("aria-expanded", "false");

    rerender(
      <CameraMarkerPill
        count={3}
        open
        byCategory={{ ...noByCategory, sound: 3 }}
        onToggle={() => {}}
        onNavigateReview={() => {}}
        wrapRef={wrapRef}
        trapRef={trapRef}
      />,
    );
    expect(screen.getByRole("button", { name: /3 markers/i })).toHaveAttribute("aria-expanded", "true");
  });
});
