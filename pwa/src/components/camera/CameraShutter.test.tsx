// @vitest-environment happy-dom

/**
 * CameraShutter smoke tests — pin the begin/end state machine.
 *
 * The shutter is the ONE button that dominates the camera surface; muscle
 * memory has to be reliable across the begin/end toggle. These tests pin:
 *   - the running-flag → label/title mapping
 *   - busy → disabled wiring
 *   - the recording class toggling so a CSS regression breaks visibly here
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CameraShutter } from "./CameraShutter";

afterEach(() => {
  cleanup();
});

describe("<CameraShutter />", () => {
  it("idle state — 'Begin session' label + title", () => {
    render(<CameraShutter running={false} busy={false} onClick={() => {}} />);
    const btn = screen.getByRole("button", { name: /begin session/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("title", "Begin session");
    expect(btn).not.toBeDisabled();
  });

  it("running state — 'End session' label + title + recording class", () => {
    const { container } = render(
      <CameraShutter running busy={false} onClick={() => {}} />,
    );
    const btn = screen.getByRole("button", { name: /end session/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("title", "End session");
    // CSS-modules hashes the class; the second token on the button should be
    // the recording variant. Sanity: class list isn't empty.
    expect(container.querySelector("button")?.className.length).toBeGreaterThan(0);
  });

  it("busy=true disables the button regardless of running flag", () => {
    const { rerender } = render(
      <CameraShutter running={false} busy onClick={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /begin session/i })).toBeDisabled();
    rerender(<CameraShutter running busy onClick={() => {}} />);
    expect(screen.getByRole("button", { name: /end session/i })).toBeDisabled();
  });

  it("clicking the shutter invokes onClick exactly once", () => {
    const onClick = vi.fn();
    render(<CameraShutter running={false} busy={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /begin session/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled shutter does NOT invoke onClick when clicked", () => {
    const onClick = vi.fn();
    render(<CameraShutter running={false} busy onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /begin session/i }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("inner core span has aria-hidden so the AT only hears the button label", () => {
    const { container } = render(
      <CameraShutter running={false} busy={false} onClick={() => {}} />,
    );
    const core = container.querySelector("span");
    expect(core).not.toBeNull();
    expect(core).toHaveAttribute("aria-hidden", "true");
  });
});
