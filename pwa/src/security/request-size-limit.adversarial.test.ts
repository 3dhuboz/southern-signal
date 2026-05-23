import { describe, expect, it } from "vitest";
import { readLimitedBytes, readLimitedJson } from "../../functions/api/_body";

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("https://southern-signal.pages.dev/api/test", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("request body size limits", () => {
  it("rejects an oversized streamed body even when Content-Length is absent", async () => {
    const req = streamRequest([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const result = await readLimitedBytes(req, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it("rejects an oversized body even when Content-Length lies low", async () => {
    const req = streamRequest([new Uint8Array([1, 2, 3, 4])], { "Content-Length": "1" });
    const result = await readLimitedBytes(req, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it("accepts a body exactly at the byte cap", async () => {
    const req = streamRequest([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const result = await readLimitedBytes(req, 3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it("parses JSON only after the byte cap is enforced", async () => {
    const req = streamRequest([new TextEncoder().encode('{"ok":true}')]);
    const result = await readLimitedJson<{ ok?: boolean }>(req, 16);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ok).toBe(true);
  });
});
