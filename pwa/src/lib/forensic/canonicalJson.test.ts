import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonicalJson";

describe("canonicalJson — primitives", () => {
  it("serialises null", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  it("serialises booleans", () => {
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
  });

  it("serialises numbers", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-1.5)).toBe("-1.5");
  });

  it("serialises strings (with quotes)", () => {
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson("")).toBe('""');
  });
});

describe("canonicalJson — object key ordering", () => {
  it("sorts top-level keys regardless of insertion order", () => {
    const expected = '{"a":2,"b":1}';
    expect(canonicalJson({ b: 1, a: 2 })).toBe(expected);
    expect(canonicalJson({ a: 2, b: 1 })).toBe(expected);
  });

  it("sorts keys at every depth of nesting", () => {
    const v = {
      z: { y: 1, x: { c: 3, a: 1, b: 2 } },
      a: { n: 0, m: 0 },
    };
    expect(canonicalJson(v)).toBe('{"a":{"m":0,"n":0},"z":{"x":{"a":1,"b":2,"c":3},"y":1}}');
  });

  it("treats the empty object as {}", () => {
    expect(canonicalJson({})).toBe("{}");
  });
});

describe("canonicalJson — arrays", () => {
  it("preserves array order (does NOT reorder)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["b", "a", "c"])).toBe('["b","a","c"]');
  });

  it("treats the empty array as []", () => {
    expect(canonicalJson([])).toBe("[]");
  });

  it("preserves order for nested arrays", () => {
    expect(canonicalJson([[3, 2, 1], [6, 5, 4]])).toBe("[[3,2,1],[6,5,4]]");
  });
});

describe("canonicalJson — string escaping matches JSON.stringify", () => {
  // The implementation defers primitive serialisation to JSON.stringify, so
  // every escape sequence MUST be byte-identical to the standard library.
  const samples = [
    'has "quotes"',
    "back\\slash",
    "new\nline",
    "tab\there",
    "carriage\rreturn",
    "control\x01char",
    'mixed "\\\n\t',
    "unicode → café",
  ];
  for (const s of samples) {
    it(`encodes ${JSON.stringify(s)} the same as JSON.stringify`, () => {
      expect(canonicalJson(s)).toBe(JSON.stringify(s));
    });
  }
});

describe("canonicalJson — mixed nesting", () => {
  it("sorts object keys but preserves array order in arrays-of-objects", () => {
    const v = {
      events: [
        { ts: 3, kind: "b" },
        { kind: "a", ts: 1 },
        { ts: 2, kind: "c" },
      ],
      meta: { z: 1, a: 2 },
    };
    // Array element order preserved; each object's keys sorted; "events" sorts before "meta".
    expect(canonicalJson(v)).toBe(
      '{"events":[{"kind":"b","ts":3},{"kind":"a","ts":1},{"kind":"c","ts":2}],"meta":{"a":2,"z":1}}',
    );
  });
});

describe("canonicalJson — determinism under key shuffling", () => {
  // Generate a reference object with N keys, then build 100 variants where
  // the keys are inserted in random orders. All 100 outputs must be byte-
  // identical. Same applies to a nested structure.
  function shuffle<T>(arr: T[], seed: number): T[] {
    // Simple LCG for reproducibility — we don't care about cryptographic
    // quality, just that the shuffle actually moves things around.
    const out = arr.slice();
    let s = seed >>> 0;
    for (let i = out.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it("produces byte-identical output for 100 random key insertion orders (flat)", () => {
    const keys = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const values: Record<string, number> = {};
    keys.forEach((k, i) => { values[k] = i; });

    const reference = canonicalJson(values);
    for (let trial = 0; trial < 100; trial++) {
      const shuffledKeys = shuffle(keys, trial + 1);
      const obj: Record<string, number> = {};
      for (const k of shuffledKeys) obj[k] = values[k];
      expect(canonicalJson(obj)).toBe(reference);
    }
  });

  it("produces byte-identical output for 100 random key insertion orders (nested)", () => {
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    const buildNested = (order: string[]) => {
      const inner: Record<string, unknown> = {};
      for (const k of order) inner[k] = { val: k.length, name: k };
      const outer: Record<string, unknown> = {};
      for (const k of order) outer[k] = inner;
      return outer;
    };

    const reference = canonicalJson(buildNested(keys));
    for (let trial = 0; trial < 100; trial++) {
      const shuffled = shuffle(keys, trial + 1);
      expect(canonicalJson(buildNested(shuffled))).toBe(reference);
    }
  });
});

describe("sha256Hex — known vectors", () => {
  it("hashes the empty string to the canonical SHA-256 of empty input", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to the NIST FIPS 180-4 example digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns a 64-character lowercase hex string", async () => {
    const out = await sha256Hex("anything");
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("unicode stability", () => {
  // No encoding drift: canonical output and digest must be reproducible
  // across runs for non-ASCII content. JSON.stringify preserves the literal
  // characters (it does not auto-escape printable Unicode), and TextEncoder
  // gives us deterministic UTF-8 bytes.
  it("encodes café using the same bytes JSON.stringify would", () => {
    expect(canonicalJson("café")).toBe(JSON.stringify("café"));
  });

  it("hashes café to a stable digest (UTF-8 bytes)", async () => {
    // Pre-computed: SHA-256 of the UTF-8 bytes of "café"
    // (c=0x63, a=0x61, f=0x66, é=0xC3 0xA9).
    const expected = "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e";
    expect(await sha256Hex("café")).toBe(expected);
  });

  it("round-trips a unicode-heavy object deterministically", () => {
    const a = { "α": 1, "β": "ε", "γ": ["δ", "ζ"] };
    const b = { "γ": ["δ", "ζ"], "α": 1, "β": "ε" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
