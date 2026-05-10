/**
 * Cloudflare Pages Function — server-side audio transcription proxy.
 *
 *   POST /api/ai/transcribe
 *     Content-Type: multipart/form-data
 *     file:        the WAV/MP3/FLAC blob
 *     language?:   ISO-639-1 (e.g. "en")
 *     prompt?:     short biasing prompt
 *
 * Provider order (first match wins):
 *
 *   GROQ_API_KEY        → Groq's whisper-large-v3-turbo (fast, generous free tier)
 *                          POST https://api.groq.com/openai/v1/audio/transcriptions
 *   OPENAI_API_KEY      → OpenAI's whisper-1 directly
 *                          POST https://api.openai.com/v1/audio/transcriptions
 *   OPENROUTER_API_KEY  → ONLY when ALLOW_OPENROUTER_AUDIO is set, because
 *                          OpenRouter's audio path is currently broken: their
 *                          gateway JSON-parses the body instead of accepting
 *                          multipart, returning 400 "No number after minus
 *                          sign in JSON at position 1" for every request.
 *
 * If none of GROQ_API_KEY / OPENAI_API_KEY / (allowed) OPENROUTER_API_KEY
 * are set, the operator sees a 503 with a pointer to either set one or
 * enable on-device transcription in Setup.
 *
 * Optional env:
 *   TRANSCRIBE_MODEL          — explicit upstream model id (overrides defaults)
 *   ALLOW_OPENROUTER_AUDIO    — "1" / "true" to opt into the broken OR path
 */

interface Env {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  TRANSCRIBE_MODEL?: string;
  ALLOW_OPENROUTER_AUDIO?: string;
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

type ProviderKey = "groq" | "openai" | "openrouter";

interface Provider {
  key: ProviderKey;
  url: string;
  authKey: string;
  defaultModel: string;
  extraHeaders: Record<string, string>;
}

function pickProvider(env: Env, origin: string): Provider | null {
  if (env.GROQ_API_KEY) {
    return {
      key: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      authKey: env.GROQ_API_KEY,
      defaultModel: "whisper-large-v3-turbo",
      extraHeaders: {},
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      key: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      authKey: env.OPENAI_API_KEY,
      defaultModel: "whisper-1",
      extraHeaders: {},
    };
  }
  if (env.OPENROUTER_API_KEY && /^(1|true|yes)$/i.test(env.ALLOW_OPENROUTER_AUDIO ?? "")) {
    return {
      key: "openrouter",
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      authKey: env.OPENROUTER_API_KEY,
      defaultModel: FALLBACK_MODEL,
      extraHeaders: { "HTTP-Referer": origin, "X-Title": "Southern Signal" },
    };
  }
  return null;
}

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  const origin = (() => { try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; } })();
  const provider = pickProvider(env, origin);

  if (!provider) {
    // Distinguish "OpenRouter is set but blocked" from "nothing is set" — the
    // first is the most common deployment of southern-signal.pages.dev so we
    // give it a tailored hint about the on-device path.
    if (env.OPENROUTER_API_KEY) {
      return jsonResponse({
        error: "Cloud transcription is not available on this deployment.",
        detail:
          "OPENROUTER_API_KEY is set but OpenRouter's audio endpoint is currently broken (it returns 400 because the gateway JSON-parses the multipart body). Set GROQ_API_KEY (free, fast) or OPENAI_API_KEY in Cloudflare Pages → Settings → Environment variables — or enable on-device transcription in the app's Setup screen for a fully local path.",
      }, 503);
    }
    return jsonResponse({
      error: "Cloud transcription is not configured on this deployment.",
      detail: "Set GROQ_API_KEY or OPENAI_API_KEY in Cloudflare Pages env, or enable on-device transcription in Setup.",
    }, 503);
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
  const model = env.TRANSCRIBE_MODEL || provider.defaultModel;

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, (file as File).name || "audio.wav");
  upstreamForm.append("model", model);
  upstreamForm.append("language", language);
  upstreamForm.append("response_format", "verbose_json");
  if (prompt) upstreamForm.append("prompt", prompt);

  const upstream = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.authKey}`,
      ...provider.extraHeaders,
    },
    body: upstreamForm,
  });

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse({
      error: `Upstream ${upstream.status}`,
      provider: provider.key,
      detail: upstreamText.slice(0, 800),
    }, upstream.status);
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
    model,
    provider: provider.key,
  }, 200);
};
