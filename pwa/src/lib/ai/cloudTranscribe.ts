/**
 * Client wrapper for the server-side `/api/ai/transcribe` Pages Function.
 *
 * Sends a WAV (or any audio Blob the upstream Whisper accepts) and gets
 * back transcription text + timestamped segments. The OPENROUTER /
 * OPENAI key is held server-side — never exposed to the client.
 */

import { CloudGuardError, ensureRoutable, type CloudCallContext } from "./cloudAi";

const TRANSCRIBE_PATH = "/api/ai/transcribe";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
  duration: number | null;
  model: string;
}

export class TranscribeUnavailableError extends Error {
  constructor() {
    super("Cloud transcription is not configured on this deployment.");
    this.name = "TranscribeUnavailableError";
  }
}

export async function transcribeAudio(
  audio: Blob,
  ctx: CloudCallContext,
  opts?: { language?: string; prompt?: string; filename?: string },
): Promise<TranscriptionResult> {
  await ensureRoutable(ctx);

  const form = new FormData();
  form.append("file", audio, opts?.filename ?? "audio.wav");
  if (opts?.language) form.append("language", opts.language);
  if (opts?.prompt) form.append("prompt", opts.prompt);

  const resp = await fetch(TRANSCRIBE_PATH, { method: "POST", body: form });
  if (resp.status === 503) {
    throw new TranscribeUnavailableError();
  }
  if (resp.status === 402) {
    throw new Error("Out of cloud-transcription credits. Top up at openrouter.ai/settings/credits.");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Upstream rejected the key — check OPENROUTER_API_KEY / OPENAI_API_KEY in Cloudflare Pages env.");
  }
  if (resp.status === 413) {
    throw new Error("Audio is too large for the transcription endpoint (25 MB cap).");
  }
  if (resp.status === 429) {
    throw new Error("Rate-limited. Wait a moment and try again.");
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Transcribe ${resp.status}: ${detail.slice(0, 240)}`);
  }
  const data = await resp.json() as Partial<TranscriptionResult>;
  if (typeof data.text !== "string") throw new Error("Upstream returned no text.");

  return {
    text: data.text,
    segments: data.segments ?? [],
    language: data.language ?? "en",
    duration: data.duration ?? null,
    model: data.model ?? "whisper-1",
  };
}

export { CloudGuardError };
