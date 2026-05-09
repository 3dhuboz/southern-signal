/**
 * Cloudflare Pages Function — server-side audio transcription proxy.
 *
 *   POST /api/ai/transcribe
 *     Content-Type: multipart/form-data
 *     file:        the WAV/MP3/FLAC blob
 *     language?:   ISO-639-1 (e.g. "en")
 *     prompt?:     short biasing prompt
 *
 * Server-side OPENROUTER_API_KEY (or OPENAI_API_KEY) handles upstream
 * Whisper-1. End users never see a key.
 *
 * Optional env:
 *   TRANSCRIBE_MODEL  — defaults to "openai/whisper-1"
 *   OPENAI_API_KEY    — direct OpenAI key (bypasses OpenRouter when set)
 */

interface Env {
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  TRANSCRIBE_MODEL?: string;
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next: (input?: Request | string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

const FALLBACK_MODEL = "openai/whisper-1";
const MAX_AUDIO_BYTES = 25_000_000; // OpenAI Whisper hard cap is 25 MB
const ALLOWED_ORIGIN_DEFAULT = "*";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN_DEFAULT,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN_DEFAULT,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
};

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  const useOpenAI = !!env.OPENAI_API_KEY;
  const useOpenRouter = !!env.OPENROUTER_API_KEY;
  if (!useOpenAI && !useOpenRouter) {
    return jsonResponse({ error: "Transcription is not configured on this deployment." }, 503);
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_AUDIO_BYTES) {
    return jsonResponse({ error: `Audio over the ${(MAX_AUDIO_BYTES / 1_000_000) | 0} MB cap.` }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid multipart form-data." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return jsonResponse({ error: "Missing 'file' part." }, 400);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return jsonResponse({ error: `Audio over the ${(MAX_AUDIO_BYTES / 1_000_000) | 0} MB cap.` }, 413);
  }

  const language = (form.get("language") as string | null) ?? "en";
  const prompt = (form.get("prompt") as string | null) ?? undefined;
  const model = env.TRANSCRIBE_MODEL || FALLBACK_MODEL;

  // OpenAI direct path is preferred when configured because OpenRouter routes
  // /v1/audio/transcriptions through the same provider but with its own quirks.
  const upstreamUrl = useOpenAI
    ? "https://api.openai.com/v1/audio/transcriptions"
    : "https://openrouter.ai/api/v1/audio/transcriptions";
  const upstreamKey = useOpenAI ? env.OPENAI_API_KEY! : env.OPENROUTER_API_KEY!;

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, (file as File).name || "audio.wav");
  upstreamForm.append("model", useOpenAI ? "whisper-1" : model);
  upstreamForm.append("language", language);
  upstreamForm.append("response_format", "verbose_json");
  if (prompt) upstreamForm.append("prompt", prompt);

  const origin = (() => { try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; } })();

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${upstreamKey}`,
      ...(useOpenRouter ? { "HTTP-Referer": origin, "X-Title": "Southern Signal" } : {}),
    },
    body: upstreamForm,
  });

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse({ error: `Upstream ${upstream.status}`, detail: upstreamText.slice(0, 800) }, upstream.status);
  }

  let parsed: { text?: string; segments?: { start: number; end: number; text: string; avg_logprob?: number }[]; language?: string; duration?: number };
  try {
    parsed = JSON.parse(upstreamText);
  } catch {
    return jsonResponse({ error: "Upstream returned non-JSON.", detail: upstreamText.slice(0, 200) }, 502);
  }
  if (typeof parsed.text !== "string") {
    return jsonResponse({ error: "Upstream returned no text." }, 502);
  }

  return jsonResponse({
    text: parsed.text,
    segments: parsed.segments ?? [],
    language: parsed.language ?? language,
    duration: parsed.duration ?? null,
    model: useOpenAI ? "whisper-1" : model,
  }, 200);
};
