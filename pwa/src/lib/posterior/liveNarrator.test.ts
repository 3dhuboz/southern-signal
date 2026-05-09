import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNarration } from "./liveNarrator";
import type { LogIncrement } from "./posterior";

const ACOUSTIC_OPENERS = ["I'm hearing", "Just picked up", "Catching a sound"] as const;

function inc(over: Partial<LogIncrement> = {}): LogIncrement {
  return {
    ts: 0,
    channel: "acoustic",
    logLr: 0,
    reason: "",
    metadata: {},
    ...over,
  } as LogIncrement;
}

describe("buildNarration · acoustic", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("includes the friendly sector when present", () => {
    const text = buildNarration(inc({ channel: "acoustic", metadata: { sector: "REAR-R" } }));
    expect(text).toContain("from your behind-right");
    expect(text.endsWith(".")).toBe(true);
  });

  it("uses one of the known openers", () => {
    vi.restoreAllMocks(); // let Math.random vary; just check membership
    const text = buildNarration(inc({ channel: "acoustic", metadata: { sector: "FRONT-L" } }));
    expect(ACOUSTIC_OPENERS.some((o) => text.startsWith(o))).toBe(true);
  });

  it("omits the directional clause when no sector is set", () => {
    const text = buildNarration(inc({ channel: "acoustic", metadata: {} }));
    expect(text).not.toContain("from your");
    expect(text.endsWith(".")).toBe(true);
  });
});

describe("buildNarration · infrasound", () => {
  it("formats peak hz to one decimal and rounds duration to seconds", () => {
    const text = buildNarration(inc({ channel: "infrasound", metadata: { peak_hz: 12.345, duration_s: 4.7 } }));
    expect(text).toContain("12.3 hertz");
    expect(text).toContain("sustained 5 seconds");
  });

  it("drops the duration tail when duration is missing", () => {
    const text = buildNarration(inc({ channel: "infrasound", metadata: { peak_hz: 8 } }));
    expect(text).toContain("8.0 hertz");
    expect(text).not.toContain("sustained");
  });

  it("falls back to a generic sentence when peak_hz is absent", () => {
    expect(buildNarration(inc({ channel: "infrasound", metadata: {} }))).toBe("Low-frequency pressure shift in the room.");
  });
});

describe("buildNarration · magnetometer", () => {
  it("reports z_score magnitude as standard deviations", () => {
    const text = buildNarration(inc({ channel: "magnetometer", metadata: { z_score: 3.7 } }));
    expect(text).toContain("3.7 standard deviations");
  });

  it("uses absolute value for negative z_scores", () => {
    const text = buildNarration(inc({ channel: "magnetometer", metadata: { z_score: -4.2 } }));
    expect(text).toContain("4.2 standard deviations");
  });

  it("falls back when z_score is missing", () => {
    expect(buildNarration(inc({ channel: "magnetometer", metadata: {} }))).toBe("Magnetic field anomaly.");
  });
});

describe("buildNarration · coupling", () => {
  it("joins coupled channel labels with 'and'", () => {
    const text = buildNarration(inc({ channel: "coupling", metadata: { coupled_channels: ["acoustic", "magnetometer"] } }));
    expect(text).toContain("sound and magnetic anomaly");
  });

  it("handles a single coupled channel without breaking", () => {
    const text = buildNarration(inc({ channel: "coupling", metadata: { coupled_channels: ["acoustic"] } }));
    expect(text).toContain("sound");
  });

  it("handles missing coupled_channels gracefully", () => {
    const text = buildNarration(inc({ channel: "coupling", metadata: {} }));
    expect(text).toMatch(/Two channels firing at once: \./);
  });
});

describe("buildNarration · contamination", () => {
  it("humanises the underscore-tag", () => {
    const text = buildNarration(inc({ channel: "contamination", metadata: { tag: "voice_other" } }));
    expect(text).toContain("voice other");
    expect(text).toContain("Subtracting from the activity");
  });

  it("falls back to 'interference' when tag is absent", () => {
    expect(buildNarration(inc({ channel: "contamination", metadata: {} }))).toContain("interference");
  });
});

describe("buildNarration · default", () => {
  it("uses the channel's friendly label", () => {
    expect(buildNarration(inc({ channel: "marker", metadata: {} }))).toBe("Marker dropped event.");
  });

  it("falls back to the verbatim channel name for unknowns", () => {
    expect(buildNarration(inc({ channel: "photonic", metadata: {} }))).toBe("photonic event.");
  });
});
