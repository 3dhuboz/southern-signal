// @vitest-environment happy-dom

/**
 * CameraDock smoke tests — pin the buttons + their wiring contract.
 *
 * The dock is the most visible piece of the camera overhaul: a 5-chip
 * mystery row that used cryptic 3-letter codes became a labelled set of
 * full-word buttons. These tests pin both the new labels (so a future
 * "tighten it back up" doesn't silently regress to SCR / Rear / Front)
 * and the click→ref wiring (so a refactor that swaps the toggle
 * mechanism breaks visibly here rather than at hunt-time).
 *
 * The ScreenRecordButton is passed in as a slot; the tests render a
 * placeholder span so the parent contract is exercised without dragging
 * the screen recorder's iOS branch + MediaRecorder dependencies into
 * the unit test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { CameraDock } from "./CameraDock";

afterEach(() => {
  cleanup();
});

interface Refs {
  recordToggleRef: ReturnType<typeof createRef<(() => void) | null>>;
  flipCameraRef: ReturnType<typeof createRef<(() => void) | null>>;
  torchToggleRef: ReturnType<typeof createRef<(() => void) | null>>;
}
function makeRefs(): Refs {
  return {
    recordToggleRef: createRef<(() => void) | null>(),
    flipCameraRef: createRef<(() => void) | null>(),
    torchToggleRef: createRef<(() => void) | null>(),
  };
}

describe("<CameraDock />", () => {
  it("renders Scenes + HUD + Markers in the left group", () => {
    const refs = makeRefs();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(screen.getByRole("button", { name: /open scene picker/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open hud layout/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open marker review/i })).toBeInTheDocument();
    expect(screen.getByText("Scenes")).toBeInTheDocument();
    expect(screen.getByText("HUD")).toBeInTheDocument();
    expect(screen.getByText("Markers")).toBeInTheDocument();
  });

  it("uses FULL WORD labels — no 3-letter codes anywhere", () => {
    const refs = makeRefs();
    const { container } = render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: true, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    const text = container.textContent ?? "";
    // The cryptic codes the redesign retired must not be back.
    expect(text).not.toMatch(/\bSCR\b/);
    expect(text).not.toMatch(/\bClip\b(?!ping|s\b)/); // "Clip" alone (allow "Clipping")
    // "Rear" / "Front" as visible labels were retired — they're only in
    // the aria-label for accessibility (which names the destination,
    // not the action). The visible label is "Lens".
    expect(text).not.toMatch(/\bRear\b/);
    expect(text).not.toMatch(/\bFront\b/);
    expect(text).toContain("Lens");
  });

  it("idle Clip button shows 'Record clip' label; recording shows 'Stop'", () => {
    const refs = makeRefs();
    const { rerender } = render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(screen.getByRole("button", { name: /start clip recording/i })).toBeInTheDocument();
    expect(screen.getByText("Record clip")).toBeInTheDocument();

    rerender(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(screen.getByRole("button", { name: /stop clip recording/i })).toBeInTheDocument();
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });

  it("Lens button is disabled when streamOn=false (no camera open)", () => {
    const refs = makeRefs();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: false, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    const lensBtn = screen.getByRole("button", { name: /switch to front camera/i });
    expect(lensBtn).toBeDisabled();
  });

  it("Torch button only renders when cameraState.torchSupported is true", () => {
    const refs = makeRefs();
    const { rerender, queryByRole } = render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(queryByRole("button", { name: /turn torch on/i })).toBeNull();

    rerender(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: true, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(screen.getByRole("button", { name: /turn torch on/i })).toBeInTheDocument();
  });

  it("simplifiedDock=true keeps HUD layout but hides the right group and Markers", () => {
    const refs = makeRefs();
    render(
      <CameraDock
        simplifiedDock
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: true, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    expect(screen.getByRole("button", { name: /open scene picker/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open hud layout/i })).toBeInTheDocument();
    // Markers shortcut is gated on the right-group visibility — Vigil
    // wants chromeless framing, so it goes away with the rest.
    expect(screen.queryByRole("button", { name: /open marker review/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start clip recording/i })).toBeNull();
    // Screen record button is part of the right group; it disappears
    // entirely on simplifiedDock so the Vigil scene stays cinematic.
    expect(screen.queryByRole("button", { name: /screen record/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /switch to front camera/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /turn torch on/i })).toBeNull();
  });

  it("clicking Scenes invokes onScenesOpen", () => {
    const refs = makeRefs();
    const onScenesOpen = vi.fn();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={onScenesOpen}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open scene picker/i }));
    expect(onScenesOpen).toHaveBeenCalledTimes(1);
  });

  it("clicking HUD invokes onHudOpen", () => {
    const refs = makeRefs();
    const onHudOpen = vi.fn();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={onHudOpen}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open hud layout/i }));
    expect(onHudOpen).toHaveBeenCalledTimes(1);
  });

  it("clicking Markers invokes onMarkersOpen (navigation to review)", () => {
    const refs = makeRefs();
    const onMarkersOpen = vi.fn();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={onMarkersOpen}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open marker review/i }));
    expect(onMarkersOpen).toHaveBeenCalledTimes(1);
  });

  it("clicking Clip invokes the recordToggleRef function", () => {
    const refs = makeRefs();
    const toggle = vi.fn();
    refs.recordToggleRef.current = toggle;
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start clip recording/i }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("clicking Lens invokes the flipCameraRef function", () => {
    const refs = makeRefs();
    const flip = vi.fn();
    refs.flipCameraRef.current = flip;
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /switch to front camera/i }));
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it("clicking Torch (when supported) invokes the torchToggleRef function", () => {
    const refs = makeRefs();
    const toggleTorch = vi.fn();
    refs.torchToggleRef.current = toggleTorch;
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: true, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /turn torch on/i }));
    expect(toggleTorch).toHaveBeenCalledTimes(1);
  });

  it("toolbar semantics: role=toolbar + aria-label", () => {
    const refs = makeRefs();
    render(
      <CameraDock
        simplifiedDock={false}
        broadcastRecording={false}
        cameraState={{ streamOn: true, facingMode: "environment", torchSupported: false, torchOn: false }}
        recordToggleRef={refs.recordToggleRef}
        flipCameraRef={refs.flipCameraRef}
        torchToggleRef={refs.torchToggleRef}
        onScenesOpen={() => {}}
        onHudOpen={() => {}}
        onMarkersOpen={() => {}}
        investigationId={null}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: /camera secondary controls/i });
    expect(toolbar).toBeInTheDocument();
  });
});
