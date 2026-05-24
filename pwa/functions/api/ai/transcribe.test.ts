import { describe, expect, it, vi } from "vitest";
import { onRequestPost } from "./transcribe";

function mkRequest(): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "clip.wav");
  form.append("language", "en");
  return new Request("https://example.test/api/ai/transcribe", {
    method: "POST",
    headers: { Origin: "https://example.test" },
    body: form,
  });
}

function mkCtx(env: Record<string, unknown>): Parameters<typeof onRequestPost>[0] {
  return {
    request: mkRequest(),
    env: {
      AI_RATE_LIMIT: { get: async () => null, put: async () => undefined },
      AI_RELAY_ALLOW_UNSIGNED: "1",
      ...env,
    },
    params: {},
    data: {},
    next: async () => new Response(null),
    waitUntil: () => undefined,
  } as Parameters<typeof onRequestPost>[0];
}

describe("POST /api/ai/transcribe", () => {
  it("uses Cloudflare Workers AI when no dedicated transcription key is set", async () => {
    const run = vi.fn(async () => ({
      text: "hello from the room",
      words: [{ word: "hello", start: 0, end: 0.4 }],
    }));

    const res = await onRequestPost(mkCtx({ AI: { run } }));
    const body = await res.json() as {
      text: string;
      provider: string;
      model: string;
      segments: { text: string; start: number; end: number }[];
    };

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith("@cf/openai/whisper", { audio: [1, 2, 3] });
    expect(body).toMatchObject({
      text: "hello from the room",
      provider: "workers-ai",
      model: "@cf/openai/whisper",
      segments: [{ text: "hello", start: 0, end: 0.4 }],
    });
  });

  it("keeps Groq ahead of the Workers AI fallback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "groq wins", segments: [] }), { status: 200 }),
    );
    const run = vi.fn();

    const res = await onRequestPost(mkCtx({
      GROQ_API_KEY: "gsk-test",
      AI: { run },
    }));
    const body = await res.json() as { provider: string; text: string };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ provider: "groq", text: "groq wins" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.groq.com/openai/v1/audio/transcriptions", expect.any(Object));
    expect(run).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
