/**
 * OpenRouter client — OpenAI-compatible chat completions endpoint.
 * Same call shape as the Anthropic path, different transport.
 *
 *   POST https://openrouter.ai/api/v1/chat/completions
 *   Authorization: Bearer <user-key>
 *
 * Per OpenRouter docs the optional HTTP-Referer + X-Title headers help
 * with attribution and ranking. We send our origin + product name.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export async function openRouterChat(req: OpenRouterRequest): Promise<string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${req.apiKey}`,
    "Content-Type": "application/json",
  };
  // OpenRouter ranking metadata — best-effort.
  if (typeof window !== "undefined") {
    headers["HTTP-Referer"] = window.location.origin;
    headers["X-Title"] = "Southern Signal";
  }

  const body = {
    model: req.model,
    max_tokens: req.maxTokens ?? 768,
    temperature: req.temperature ?? 0.7,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ] as OpenRouterMessage[],
  };

  const resp = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail: string;
    try {
      const j = await resp.json();
      detail = j?.error?.message || JSON.stringify(j);
    } catch {
      detail = await resp.text().catch(() => "");
    }
    throw new Error(`OpenRouter ${resp.status}: ${detail || resp.statusText}`);
  }
  const data = await resp.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned no content");
  return text;
}
