/**
 * Streaming variant of runResearch. Posts to /api/ai/research/stream
 * (Server-Sent Events) and surfaces three event kinds to the caller:
 *
 *   onStage(label, elapsedMs)  synthetic stage milestone from the server
 *   onChunk(chunks, chars)     upstream token slices have arrived
 *   onFinal(result)            validated ResearchResult — same shape as
 *                              runResearch returns
 *
 * Plus a single rejection for unrecoverable errors.
 *
 * The non-streaming endpoint is the canonical source for cap state /
 * cultural blocks; this wrapper enforces the same client soft-cap
 * before reaching the wire, and lifts a 429 / 403 into the same error
 * types runResearch throws.
 */

import { ResearchRateLimitError, RATE_LIMIT_CAP, getResearchRateState, type ResearchRequest, type ResearchResult } from "./api";

export interface StreamCallbacks {
  onStage?: (label: string, elapsedMs: number) => void;
  onChunk?: (chunks: number, chars: number) => void;
  onFinal: (result: ResearchResult) => void;
}

export interface StreamHandle {
  /** Abort the in-flight stream — server stops reading upstream, no
   *  rate-limit slot is burned (server only records on final). */
  abort(): void;
  /** Promise resolves when onFinal has been called or rejects on error. */
  done: Promise<void>;
}

/**
 * Record a successful run in the same localStorage soft-cap log the
 * non-streaming flow uses. Exported separately because the SSE flow
 * has to know when "final" arrives — see the consumer below.
 */
function recordRun(): void {
  try {
    const KEY = "ss-research-runs-v1";
    const raw = localStorage.getItem(KEY);
    const log = raw ? JSON.parse(raw) as number[] : [];
    const now = Date.now();
    const fresh = log.filter((t) => now - t < 24 * 60 * 60 * 1000);
    fresh.push(now);
    localStorage.setItem(KEY, JSON.stringify(fresh));
  } catch { /* */ }
}

export function streamResearch(req: ResearchRequest, callbacks: StreamCallbacks): StreamHandle {
  const controller = new AbortController();

  const done = (async () => {
    // Client soft-cap check — same gate runResearch enforces.
    const state = getResearchRateState();
    if (state.used >= state.cap) {
      const oldest = state.nextResetMs == null
        ? Date.now()
        : Date.now() + state.nextResetMs - 24 * 60 * 60 * 1000;
      throw new ResearchRateLimitError(state.used, state.cap, Date.now() - oldest);
    }

    let res: Response;
    try {
      res = await fetch("/api/ai/research/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({
          venueName: req.venueName,
          locationHint: req.locationHint,
          region: req.region ?? "AU",
          culturallySensitive: req.culturallySensitive ?? false,
          followup: req.followup,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`Stream request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      // Same JSON shape as the non-streaming endpoint for errors.
      const detail = await res.text().catch(() => "");
      let parsed: { error?: string; detail?: string; retry_after_seconds?: number } | null = null;
      try { parsed = JSON.parse(detail); } catch { /* */ }
      if (res.status === 429) {
        const resetSec = parsed?.retry_after_seconds
          ?? parseInt(res.headers.get("X-RateLimit-Reset-Seconds") ?? "0", 10);
        throw new ResearchRateLimitError(
          RATE_LIMIT_CAP,
          RATE_LIMIT_CAP,
          Math.max(0, 24 * 3600 * 1000 - resetSec * 1000),
          true,
        );
      }
      const msg = parsed?.error
        ? `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ""}`
        : `Stream ${res.status}: ${detail.slice(0, 200)}`;
      throw new Error(msg);
    }

    if (!res.body) {
      throw new Error("Stream had no body.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ResearchResult | null = null;
    let streamError: string | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split("\n\n");
      buffer = records.pop() ?? "";
      for (const record of records) {
        const line = record.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const obj = JSON.parse(data) as {
            type?: string;
            label?: string;
            elapsed_ms?: number;
            chunks?: number;
            chars?: number;
            payload?: ResearchResult;
            message?: string;
            detail?: string;
          };
          switch (obj.type) {
            case "stage":
              if (typeof obj.label === "string") {
                callbacks.onStage?.(obj.label, obj.elapsed_ms ?? 0);
              }
              break;
            case "chunk":
              callbacks.onChunk?.(obj.chunks ?? 0, obj.chars ?? 0);
              break;
            case "final":
              if (obj.payload) final = obj.payload;
              break;
            case "error":
              streamError = `${obj.message ?? "stream error"}${obj.detail ? `: ${obj.detail}` : ""}`;
              break;
          }
        } catch { /* drop malformed SSE record */ }
      }
    }

    if (streamError) throw new Error(streamError);
    if (!final) throw new Error("Stream ended without a final payload.");

    // Server recorded the rate-limit slot already; mirror locally so
    // the UI's localStorage cap stays in sync.
    recordRun();
    callbacks.onFinal(final);
  })();

  return {
    abort: () => controller.abort(),
    done,
  };
}
