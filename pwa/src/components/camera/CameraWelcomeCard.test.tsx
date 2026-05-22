// @vitest-environment happy-dom

/**
 * CameraWelcomeCard smoke tests — pin the gesture-list copy, the modal
 * a11y semantics, and the dismiss wiring.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { CameraWelcomeCard } from "./CameraWelcomeCard";

afterEach(() => {
  cleanup();
});

describe("<CameraWelcomeCard />", () => {
  it("renders the four discoverable-gesture bullets", () => {
    const trapRef = createRef<HTMLDivElement>();
    render(<CameraWelcomeCard onDismiss={() => {}} trapRef={trapRef} />);
    expect(screen.getByText(/double-tap/i)).toBeInTheDocument();
    expect(screen.getByText(/swipe left\/right/i)).toBeInTheDocument();
    expect(screen.getByText(/big shutter/i)).toBeInTheDocument();
    expect(screen.getByText(/watchdog/i)).toBeInTheDocument();
  });

  it("modal a11y: role=dialog + aria-modal + aria-labelledby", () => {
    const trapRef = createRef<HTMLDivElement>();
    render(<CameraWelcomeCard onDismiss={() => {}} trapRef={trapRef} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "ss-welcome-title");
  });

  it("clicking ✕ invokes onDismiss", () => {
    const onDismiss = vi.fn();
    const trapRef = createRef<HTMLDivElement>();
    render(<CameraWelcomeCard onDismiss={onDismiss} trapRef={trapRef} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss welcome card/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clicking 'Got it' invokes onDismiss", () => {
    const onDismiss = vi.fn();
    const trapRef = createRef<HTMLDivElement>();
    render(<CameraWelcomeCard onDismiss={onDismiss} trapRef={trapRef} />);
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("trapRef is attached to the dialog root", () => {
    const trapRef = createRef<HTMLDivElement>();
    render(<CameraWelcomeCard onDismiss={() => {}} trapRef={trapRef} />);
    expect(trapRef.current).not.toBeNull();
    expect(trapRef.current?.getAttribute("role")).toBe("dialog");
  });
});
