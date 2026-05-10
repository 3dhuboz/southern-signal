/**
 * Client wrapper for the server-side `/api/ai/transcribe` Pages Function.
 *
 * Sends a WAV (or any audio Blob the upstream Whisper accepts) and gets
 * back transcription text + timestamped segments. The OPENROUTER /
 * OPENAI key is held server-side — never exposed to the client.
 */

import { CloudGuardError, ensureRoutable, isInvestigationSensitive, type CloudCallContext } from "./cloudAi";

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
  constructor(detail?: string) {
    super(detail || "Cloud transcription is not configured on this deployment. Enable on-device transcription in Setup.");
    this.name = "TranscribeUnavailableError";
  }
}

interface TranscribeErrorBody {
  error?: string;
  detail?: string;
  provider?: string;
}

async function readErrorBody(resp: Response): Promise<TranscribeErrorBody> {
  try {
    const text = await resp.text();
    try { return JSON.parse(text) as TranscribeErrorBody; } catch { return { detail: text }; }
  } catch { return {}; }
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
    const body = await readErrorBody(resp);
    throw new TranscribeUnavailableError(body.detail ?? body.error);
  }
  if (resp.status === 402) {
    throw new Error("Out of cloud-transcription credits. Top up with the upstream provider (OpenAI / Groq / OpenRouter), or use on-device transcription.");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Upstream rejected the key — check the API key in Cloudflare Pages env (GROQ_API_KEY / OPENAI_API_KEY).");
  }
  if (resp.status === 413) {
    throw new Error("Audio is too large for the transcription endpoint (25 MB cap). Trim the selection and try again.");
  }
  if (resp.status === 429) {
    throw new Error("Upstream rate-limited the request. Wait a moment and try again, or use on-device transcription.");
  }
  if (!resp.ok) {
    const body = await readErrorBody(resp);
    // Detect the OpenRouter-audio-broken signature so the operator gets
    // actionable guidance instead of a raw upstream JSON dump.
    const detail = body.detail ?? "";
    if (body.provider === "openrouter" && /No number after minus sign in JSON/i.test(detail)) {
      throw new Error(
        "OpenRouter's audio endpoint is currently broken (it JSON-parses the multipart body). Set GROQ_API_KEY (free, fast) or OPENAI_API_KEY in Cloudflare Pages env, or enable on-device transcription in Setup.",
      );
    }
    const summary = body.error || `Transcribe ${resp.status}`;
    throw new Error(`${summary}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
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

export { CloudGuardError, isInvestigationSensitive };
