import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the forensic signing key store so the streaming wrapper can sign
// requests without reaching into IndexedDB (Node test env has none).
// Returns a deterministic dummy keypair shape — the test fetch mock
// doesn't actually verify signatures, only that the headers are present
// and the request body matches.
vi.mock("../forensic/signingKeyStore", () => ({
  getOrCreateSigningKey: vi.fn(async () => ({
    publicKeyHex: "00".repeat(32),
    privateKey: {} as unknown as CryptoKey,
  })),
  signBytes: vi.fn(async () => new Uint8Array(64)),
}));

// Same stubGlobal("localStorage") pattern as sessionBaseline.test.ts —
// the soft-cap helpers in api.ts touch localStorage and vitest's
// default environment is node, which doesn't provide one.
const { storage } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.has(key) ? (map.get(key) as string) : null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, String(value)); },
  };
  return { storage };
});
vi.stubGlobal("localStorage", storage);

import { streamResearch } from "./stream";
import { ResearchRateLimitError, type ResearchResult } from "./api";

function sseEncode(payloads: Array<Record<string, unknown>>): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(""));
}

function streamFromBytes(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function mkResult(partial: Partial<ResearchResult> = {}): ResearchResult {
  return {
    findings: [],
    suggestions: [],
    search_terms_used: [],
    citations_raw: [],
    model: "test/mock",
    warnings: [],
    ...partial,
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Each test gets a fresh localStorage so the soft-cap doesn't carry over.
  try { localStorage.removeItem("ss-research-runs-v1"); } catch { /* */ }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("streamResearch — happy path", () => {
  it("dispatches stage → chunk → final in order and resolves with the payload", async () => {
    const finalResult = mkResult({
      findings: [{ tier: "HERITAGE", title: "Built 1894", body: "Foundation date.", sources: [] }],
    });
    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(sseEncode([
      { type: "stage", label: "Walking the archives…", elapsed_ms: 0 },
      { type: "chunk", chunks: 5, chars: 200 },
      { type: "stage", label: "Pulling state heritage register entries…", elapsed_ms: 2000 },
      { type: "chunk", chunks: 10, chars: 500 },
      { type: "final", payload: finalResult, elapsed_ms: 4000 },
    ])), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;

    const stages: string[] = [];
    const chunks: number[] = [];
    let final: ResearchResult | null = null;

    const handle = streamResearch(
      { venueName: "Old Court House", region: "AU" },
      {
        onStage: (label) => stages.push(label),
        onChunk: (_, chars) => chunks.push(chars),
        onFinal: (r) => { final = r; },
      },
    );
    await handle.done;

    expect(stages).toEqual(["Walking the archives…", "Pulling state heritage register entries…"]);
    expect(chunks).toEqual([200, 500]);
    expect(final).not.toBeNull();
    expect(final!.findings).toHaveLength(1);
  });

  it("records a run in the localStorage soft-cap log on successful final", async () => {
    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(sseEncode([
      { type: "final", payload: mkResult(), elapsed_ms: 100 },
    ])), { status: 200 })) as unknown as typeof fetch;
    await streamResearch({ venueName: "Venue", region: "AU" }, { onFinal: () => {} }).done;
    const log = JSON.parse(localStorage.getItem("ss-research-runs-v1") ?? "[]") as number[];
    expect(log).toHaveLength(1);
    expect(typeof log[0]).toBe("number");
  });

  it("handles SSE records split across multiple read() chunks", async () => {
    // The protocol allows record boundaries to land mid-buffer. Split the
    // payload into byte chunks that bisect a `data: ` record so the parser's
    // buffer-and-split logic gets exercised.
    const encoder = new TextEncoder();
    const full = sseEncode([
      { type: "stage", label: "stage-1", elapsed_ms: 0 },
      { type: "final", payload: mkResult({ model: "split-test" }), elapsed_ms: 200 },
    ]);
    const half = Math.floor(full.length / 2);
    const part1 = encoder.encode(""); // empty chunk — parser must handle
    const part2 = full.slice(0, half);
    const part3 = full.slice(half);

    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(part1, part2, part3), { status: 200 })) as unknown as typeof fetch;

    let final: ResearchResult | null = null;
    await streamResearch({ venueName: "V", region: "AU" }, { onFinal: (r) => { final = r; } }).done;
    expect(final).not.toBeNull();
    expect(final!.model).toBe("split-test");
  });
});

describe("streamResearch — error paths", () => {
  it("lifts a 429 into ResearchRateLimitError with fromServer=true", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: "Daily research cap reached on this network.",
      retry_after_seconds: 3600,
    }), {
      status: 429,
      headers: { "X-RateLimit-Limit": "5", "X-RateLimit-Reset-Seconds": "3600" },
    })) as unknown as typeof fetch;

    await expect(
      streamResearch({ venueName: "V", region: "AU" }, { onFinal: () => {} }).done,
    ).rejects.toBeInstanceOf(ResearchRateLimitError);
  });

  it("surfaces error events as a rejection", async () => {
    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(sseEncode([
      { type: "stage", label: "starting", elapsed_ms: 0 },
      { type: "error", message: "Upstream 502", detail: "bad gateway" },
    ])), { status: 200 })) as unknown as typeof fetch;

    await expect(
      streamResearch({ venueName: "V", region: "AU" }, { onFinal: () => {} }).done,
    ).rejects.toThrow(/Upstream 502.*bad gateway/);
  });

  it("rejects when the stream ends without a final payload", async () => {
    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(sseEncode([
      { type: "stage", label: "starting", elapsed_ms: 0 },
      { type: "chunk", chunks: 1, chars: 50 },
      // no final, no error
    ])), { status: 200 })) as unknown as typeof fetch;

    await expect(
      streamResearch({ venueName: "V", region: "AU" }, { onFinal: () => {} }).done,
    ).rejects.toThrow(/ended without a final/);
  });

  it("drops malformed SSE records without crashing", async () => {
    const encoder = new TextEncoder();
    // First record is valid stage, second is malformed JSON, third is final.
    const blob = encoder.encode(
      `data: ${JSON.stringify({ type: "stage", label: "ok", elapsed_ms: 0 })}\n\n`
      + `data: {not valid json}\n\n`
      + `data: ${JSON.stringify({ type: "final", payload: mkResult({ model: "ok-final" }), elapsed_ms: 100 })}\n\n`,
    );
    globalThis.fetch = vi.fn(async () => new Response(streamFromBytes(blob), { status: 200 })) as unknown as typeof fetch;

    const stages: string[] = [];
    let final: ResearchResult | null = null;
    await streamResearch({ venueName: "V", region: "AU" }, {
      onStage: (label) => stages.push(label),
      onFinal: (r) => { final = r; },
    }).done;

    expect(stages).toEqual(["ok"]);
    expect(final).not.toBeNull();
    expect(final!.model).toBe("ok-final");
  });
});

describe("streamResearch — soft-cap enforcement", () => {
  it("throws ResearchRateLimitError before reaching the network when the soft cap is full", async () => {
    // Fill the soft-cap log with 3 recent runs.
    const now = Date.now();
    localStorage.setItem("ss-research-runs-v1", JSON.stringify([now - 1000, now - 2000, now - 3000]));
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      streamResearch({ venueName: "V", region: "AU" }, { onFinal: () => {} }).done,
    ).rejects.toBeInstanceOf(ResearchRateLimitError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("streamResearch — abort", () => {
  it("threads the AbortController.signal through fetch and rejects on abort", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const handle = streamResearch({ venueName: "V", region: "AU" }, { onFinal: () => {} });
    // Tiny delay to let the wrapper kick off the fetch and capture the signal.
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    handle.abort();
    expect(capturedSignal!.aborted).toBe(true);
    await expect(handle.done).rejects.toThrow();
  });
});
