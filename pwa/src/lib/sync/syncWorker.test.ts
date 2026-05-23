import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseSameOriginEndpoint } from "./syncWorker";

describe("sync endpoint safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises same-origin endpoints to path-only URLs", () => {
    vi.stubGlobal("location", { origin: "https://southern-signal.pages.dev" });

    expect(normaliseSameOriginEndpoint("/api/sync/upload")).toEqual({ endpoint: "/api/sync/upload" });
    expect(normaliseSameOriginEndpoint("https://southern-signal.pages.dev/api/sync/upload?batch=1")).toEqual({
      endpoint: "/api/sync/upload?batch=1",
    });
  });

  it("refuses to send sync payloads to a different origin", () => {
    vi.stubGlobal("location", { origin: "https://southern-signal.pages.dev" });

    expect(normaliseSameOriginEndpoint("https://attacker.example/api/sync/upload")).toEqual({
      skippedReason: "sync endpoint must be same-origin",
    });
  });
});
