// @vitest-environment happy-dom

/**
 * canvasCompositor burn-in tests.
 *
 * We can't execute the full compositor pipeline in vitest's node env (no
 * MediaRecorder, no captureStream, no real 2D context). What we CAN test is
 * the burn-in surface — the text rendered onto the recorded frame — by
 * driving `renderFrame` with a recording stub canvas context and asserting
 * the `fillText` calls match what the brief promises:
 *
 *   1. Case ID appears in the bottom-left burn-in (with the UTC date).
 *   2. Timestamp appears in the bottom-right (forensic mandatory).
 *   3. Both pull from the same `BroadcastClockSnapshot` — i.e. the case-ID
 *      date and the timestamp pill agree about which moment they describe.
 *
 * The compositor doesn't expose `renderFrame` directly. We exercise it via
 * `createCanvasCompositor(...).start()`, then read the recorded fillText
 * calls off our stub context.
 */

import { describe, expect, it } from "vitest";
import { createCanvasCompositor, type OverlayState } from "./canvasCompositor";

// ─── Fake CanvasRenderingContext2D ─────────────────────────────────────────

interface FillCall {
  text: string;
  x: number;
  y: number;
}

/**
 * A minimal stub of the subset of CanvasRenderingContext2D the compositor
 * touches. Anything that returns a value (`measureText`, `getImageData`,
 * `createLinearGradient`, `createRadialGradient`) returns the smallest
 * value the production code can tolerate without throwing.
 *
 * `fillText` is the only call we actually assert against — every text-emitting
 * burn-in routine ends in a fillText.
 */
function makeStubContext(): {
  ctx: CanvasRenderingContext2D;
  fillCalls: FillCall[];
} {
  const fillCalls: FillCall[] = [];

  // A gradient stand-in — addColorStop is the only method the compositor
  // calls on the returned object.
  const fakeGradient = {
    addColorStop: () => { /* no-op */ },
  };

  const stub: Record<string, unknown> = {
    // Mutable state-style properties — the compositor sets these on the ctx
    // and we accept whatever it writes.
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    // No-op draw methods. None are asserted in this test file.
    save() { /* */ },
    restore() { /* */ },
    beginPath() { /* */ },
    closePath() { /* */ },
    moveTo() { /* */ },
    lineTo() { /* */ },
    arc() { /* */ },
    arcTo() { /* */ },
    rect() { /* */ },
    fill() { /* */ },
    stroke() { /* */ },
    clip() { /* */ },
    setLineDash() { /* */ },
    translate() { /* */ },
    rotate() { /* */ },
    scale() { /* */ },
    drawImage() { /* */ },
    fillRect() { /* */ },
    strokeRect() { /* */ },
    clearRect() { /* */ },
    // Text emit — what we assert on.
    fillText(text: string, x: number, y: number) {
      fillCalls.push({ text, x, y });
    },
    // Measurements — return a width proportional to the text length so the
    // compositor's "does it fit" branches behave consistently across runs.
    measureText(text: string) {
      return { width: text.length * 8 } as TextMetrics;
    },
    // Gradient factories — return the addColorStop-capable stub.
    createLinearGradient: () => fakeGradient,
    createRadialGradient: () => fakeGradient,
    // ImageData — only used by the night-vision filter, which we leave OFF
    // in these tests. Returning a typed array shaped like an ImageData keeps
    // even an accidental call from blowing up.
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
      width: w,
      height: h,
    }),
    putImageData() { /* */ },
  };

  return { ctx: stub as unknown as CanvasRenderingContext2D, fillCalls };
}

/**
 * Wires up a fake HTMLCanvasElement whose `getContext` hands back the stub
 * above. `captureStream` is stubbed to return an object — the compositor
 * only invokes it from a method we never call in this test file.
 */
function makeStubCanvas(): {
  canvas: HTMLCanvasElement;
  fillCalls: FillCall[];
} {
  const { ctx, fillCalls } = makeStubContext();
  const fake: Record<string, unknown> = {
    width: 1280,
    height: 720,
    getContext: () => ctx,
    captureStream: () => ({} as MediaStream),
  };
  return { canvas: fake as unknown as HTMLCanvasElement, fillCalls };
}

/**
 * Replace `document.createElement('canvas')` with our stub canvas so the
 * compositor sees a fillText-recording context when it constructs its own
 * <canvas>. Returns the fillCalls array + a restore function.
 */
function installCanvasStub(): {
  fillCalls: FillCall[];
  restore: () => void;
} {
  const { canvas, fillCalls } = makeStubCanvas();
  const realCreate = document.createElement.bind(document);
  // Only swap canvas; let everything else (e.g. <video> in other tests) pass
  // through. Cast through `unknown` because TypeScript doesn't love
  // monkey-patching builtins.
  (document.createElement as unknown) = (tag: string) =>
    tag === "canvas" ? canvas : realCreate(tag);
  return {
    fillCalls,
    restore: () => {
      (document.createElement as unknown) = realCreate;
    },
  };
}

/**
 * Build a HAVE_CURRENT_DATA video element stand-in so the compositor's
 * `video.readyState >= 2` guard passes and `drawImage(video, ...)` runs.
 */
function makeFakeVideo(): HTMLVideoElement {
  const fake: Record<string, unknown> = {
    readyState: 4,           // HAVE_ENOUGH_DATA
    videoWidth: 1280,
    videoHeight: 720,
  };
  return fake as unknown as HTMLVideoElement;
}

/**
 * Step a requestAnimationFrame loop forward by one tick. The compositor uses
 * `requestAnimationFrame` for its render loop; the global is provided by
 * happy-dom in *.test.tsx but not in plain *.test.ts node env. We stub it
 * here with a synchronous "execute on next microtask" implementation so the
 * compositor's `draw()` callback fires within the test.
 */
function installRafStub(): { restore: () => void; tick: () => void } {
  const queue: FrameRequestCallback[] = [];
  const realRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  const realCaf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  (globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame = (cb) => {
      queue.push(cb);
      return queue.length;
    };
  (globalThis as { cancelAnimationFrame: (id: number) => void })
    .cancelAnimationFrame = () => { /* */ };

  return {
    tick: () => {
      // Drain the queue once. Pass a timestamp > the frameInterval guard so
      // the compositor actually renders this tick.
      const cbs = queue.splice(0, queue.length);
      for (const cb of cbs) cb(1_000_000);
    },
    restore: () => {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = realRaf;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = realCaf;
    },
  };
}

function baseOverlay(overrides: Partial<OverlayState> = {}): OverlayState {
  // A nowMs pinned to 2026-05-22T03:34:18Z. The compositor's case-ID burn-in
  // appends the UTC date derived from this value via the shared clock.
  const nowMs = Date.parse("2026-05-22T03:34:18.000Z");
  return {
    caseId: "case-0a7b1c",
    caseTitle: "Old Mill Investigation",
    isoTimestamp: new Date(nowMs).toISOString(),
    nowMs,
    posterior: 0.42,
    activityLabel: "Possible",
    activityBand: "possible",
    sector: null,
    coherence: 0,
    audioRms: 0.1,
    recording: false,
    liveStreaming: false,
    ...overrides,
  };
}

// ─── The tests ─────────────────────────────────────────────────────────────

describe("canvasCompositor burn-in", () => {
  it("renders the case ID with the UTC date in the bottom-left", () => {
    const canvasStub = installCanvasStub();
    const rafStub = installRafStub();
    try {
      const compositor = createCanvasCompositor({
        video: makeFakeVideo(),
        getOverlay: () => baseOverlay(),
      });
      compositor.start();
      rafStub.tick();

      const textsRendered = canvasStub.fillCalls.map((c) => c.text);
      // Case-ID block: last 8 chars of "case-0a7b1c" (slug includes the dash,
      // so the trim is "e-0a7b1c" lowercased) uppercased, then a middle dot,
      // then the UTC date.
      const caseRow = textsRendered.find((t) => t.startsWith("CASE "));
      expect(caseRow).toBeDefined();
      expect(caseRow).toContain("0A7B1C");
      expect(caseRow).toContain("·");
      expect(caseRow).toContain("2026-05-22");

      compositor.stop();
    } finally {
      rafStub.restore();
      canvasStub.restore();
    }
  });

  it("renders 'NO CASE' with the date when caseId is missing", () => {
    const canvasStub = installCanvasStub();
    const rafStub = installRafStub();
    try {
      const compositor = createCanvasCompositor({
        video: makeFakeVideo(),
        getOverlay: () => baseOverlay({ caseId: undefined }),
      });
      compositor.start();
      rafStub.tick();

      const noCaseRow = canvasStub.fillCalls
        .map((c) => c.text)
        .find((t) => t.startsWith("NO CASE"));
      expect(noCaseRow).toBeDefined();
      // Even without a case ID we still want the date so editors can tell
      // which day the clip is from.
      expect(noCaseRow).toContain("2026-05-22");

      compositor.stop();
    } finally {
      rafStub.restore();
      canvasStub.restore();
    }
  });

  it("renders the SMPTE-style HH:MM:SS:FF timestamp using the shared clock", () => {
    const canvasStub = installCanvasStub();
    const rafStub = installRafStub();
    try {
      const compositor = createCanvasCompositor({
        video: makeFakeVideo(),
        getOverlay: () => baseOverlay(),
      });
      compositor.start();
      rafStub.tick();

      // The shared clock formatted 2026-05-22T03:34:18Z as "03:34:18" UTC.
      // The compositor appends a 30fps frame counter (":00" for the .000ms
      // remainder) for a final timestamp string of "03:34:18:00".
      const tsRow = canvasStub.fillCalls
        .map((c) => c.text)
        .find((t) => /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(t));
      expect(tsRow).toBe("03:34:18:00");

      compositor.stop();
    } finally {
      rafStub.restore();
      canvasStub.restore();
    }
  });

  it("case-ID date and timestamp pill describe the SAME moment per frame", () => {
    const canvasStub = installCanvasStub();
    const rafStub = installRafStub();
    try {
      // A moment that crosses a sub-second boundary so the two pills could
      // disagree if one read Date.now() while the other read overlay.nowMs.
      const nowMs = Date.parse("2026-05-22T23:59:59.750Z");
      const compositor = createCanvasCompositor({
        video: makeFakeVideo(),
        getOverlay: () => baseOverlay({ nowMs }),
      });
      compositor.start();
      rafStub.tick();

      const texts = canvasStub.fillCalls.map((c) => c.text);
      const caseRow = texts.find((t) => t.startsWith("CASE "));
      const tsRow = texts.find((t) => /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(t));
      // The case row's date must match the UTC date for this nowMs.
      expect(caseRow).toContain("2026-05-22");
      // The timestamp HH:MM:SS must match the UTC time. Frame counter (:22)
      // is computed from the 750ms remainder at 30fps → floor(750/(1000/30))=22.
      expect(tsRow).toBe("23:59:59:22");

      compositor.stop();
    } finally {
      rafStub.restore();
      canvasStub.restore();
    }
  });

  it("falls back to parsing isoTimestamp when nowMs is absent", () => {
    const canvasStub = installCanvasStub();
    const rafStub = installRafStub();
    try {
      const compositor = createCanvasCompositor({
        video: makeFakeVideo(),
        // Drop nowMs but keep a valid ISO stamp.
        getOverlay: () =>
          baseOverlay({ nowMs: undefined, isoTimestamp: "2026-06-01T12:00:00.000Z" }),
      });
      compositor.start();
      rafStub.tick();

      const texts = canvasStub.fillCalls.map((c) => c.text);
      const caseRow = texts.find((t) => t.startsWith("CASE "));
      expect(caseRow).toContain("2026-06-01");

      compositor.stop();
    } finally {
      rafStub.restore();
      canvasStub.restore();
    }
  });
});
