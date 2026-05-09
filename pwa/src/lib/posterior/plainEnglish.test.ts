import { describe, expect, it } from "vitest";
import {
  describeActivity,
  describeChannel,
  describeSector,
  plainEnglishReason,
} from "./plainEnglish";

describe("describeActivity", () => {
  it("returns 'calm' below 0.3", () => {
    expect(describeActivity(0).id).toBe("calm");
    expect(describeActivity(0.05).id).toBe("calm");
    expect(describeActivity(0.299).id).toBe("calm");
  });

  it("returns 'light' on [0.3, 0.5)", () => {
    expect(describeActivity(0.3).id).toBe("light");
    expect(describeActivity(0.4).id).toBe("light");
    expect(describeActivity(0.499).id).toBe("light");
  });

  it("returns 'possible' on [0.5, 0.7)", () => {
    expect(describeActivity(0.5).id).toBe("possible");
    expect(describeActivity(0.6).id).toBe("possible");
    expect(describeActivity(0.699).id).toBe("possible");
  });

  it("returns 'notable' on [0.7, 0.9)", () => {
    expect(describeActivity(0.7).id).toBe("notable");
    expect(describeActivity(0.8).id).toBe("notable");
    expect(describeActivity(0.899).id).toBe("notable");
  });

  it("returns 'strong' at or above 0.9", () => {
    expect(describeActivity(0.9).id).toBe("strong");
    expect(describeActivity(0.99).id).toBe("strong");
    expect(describeActivity(1).id).toBe("strong");
  });

  it("each band has a non-empty label and hint", () => {
    for (const p of [0.0, 0.4, 0.6, 0.8, 0.95]) {
      const band = describeActivity(p);
      expect(band.label.length).toBeGreaterThan(0);
      expect(band.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("describeChannel", () => {
  it("maps known channels to friendly labels with emoji", () => {
    expect(describeChannel("acoustic").label).toBe("Sound");
    expect(describeChannel("infrasound").label).toBe("Pressure shift");
    expect(describeChannel("magnetometer").label).toBe("Magnetic anomaly");
    expect(describeChannel("coupling").label).toBe("Multiple signals at once");
    expect(describeChannel("contamination").label).toBe("Marked as interference");
    expect(describeChannel("marker").label).toBe("Marker dropped");
    for (const ch of ["acoustic", "infrasound", "magnetometer", "coupling", "marker"]) {
      expect(describeChannel(ch).emoji.length).toBeGreaterThan(0);
    }
  });

  it("falls back to verbatim channel name for unknowns", () => {
    expect(describeChannel("photonic").label).toBe("photonic");
    expect(describeChannel("photonic").emoji).toBe("·");
  });
});

describe("describeSector", () => {
  it("maps sector codes to plain-language directions", () => {
    expect(describeSector("FRONT-L")).toBe("front-left");
    expect(describeSector("FRONT-C")).toBe("front, centred");
    expect(describeSector("FRONT-R")).toBe("front-right");
    expect(describeSector("REAR-L")).toBe("behind-left");
    expect(describeSector("REAR-C")).toBe("behind you");
    expect(describeSector("REAR-R")).toBe("behind-right");
  });

  it("returns empty string for null", () => {
    expect(describeSector(null)).toBe("");
  });

  it("lowercases unknown sectors", () => {
    expect(describeSector("ABOVE")).toBe("above");
  });
});

describe("plainEnglishReason", () => {
  it("strips coherence numbers", () => {
    expect(plainEnglishReason("Acoustic transient at FRONT-R, coh 0.84")).toBe("Acoustic transient at FRONT-R");
  });

  it("strips band counts", () => {
    expect(plainEnglishReason("Wide-spectrum click, 3 bands")).toBe("Wide-spectrum click");
    expect(plainEnglishReason("Single-band, 1 band")).toBe("Single-band");
  });

  it("rephrases 'sustained Ns' as a friendlier duration", () => {
    expect(plainEnglishReason("Pressure pulse sustained 4s")).toBe("Pressure pulse lasting a few seconds");
  });

  it("strips dB-above-baseline figures", () => {
    expect(plainEnglishReason("Infrasound pulse +14.2 dB above baseline")).toBe("Infrasound pulse above baseline");
  });

  it("strips log LR fragments (positive and negative)", () => {
    expect(plainEnglishReason("Magnetometer anomaly log LR +1.85")).toBe("Magnetometer anomaly");
    expect(plainEnglishReason("Contamination tagged log LR -0.40")).toBe("Contamination tagged");
  });

  it("strips contamination window declarations", () => {
    expect(plainEnglishReason("vehicle outside (window 30s)")).toBe("vehicle outside");
  });

  it("collapses leftover empty parens and double whitespace", () => {
    expect(plainEnglishReason("Acoustic ( ) hit")).toBe("Acoustic hit");
    expect(plainEnglishReason("foo  bar   baz")).toBe("foo bar baz");
  });

  it("trims trailing commas and whitespace", () => {
    expect(plainEnglishReason("Acoustic, coh 0.7,")).toBe("Acoustic");
    expect(plainEnglishReason("  Acoustic  ")).toBe("Acoustic");
  });

  it("composes: a real-world likelihood reason becomes amateur-readable", () => {
    const technical = "Acoustic transient at FRONT-R, coh 0.84, 3 bands, log LR +0.95";
    expect(plainEnglishReason(technical)).toBe("Acoustic transient at FRONT-R");
  });
});
