/**
 * Cloud AI router.
 *
 * Architecture (2026-05-09): the operator wires AI in via a server-side
 * Cloudflare Pages Function at /api/ai/chat that proxies to OpenRouter.
 * The OPENROUTER_API_KEY lives as a Pages environment secret — end users
 * never see it. This is the default, recommended, and only-visible path.
 *
 * BYOK is preserved as a developer escape hatch (Anthropic SDK path) for
 * local hacking when no proxy is reachable.
 *
 * Privacy guardrails (still enforced here, NOT at the UI):
 *   - Hard-coded refusal for any case flagged `culturallySensitive: true`.
 *   - Hard-coded refusal when the global culturalSensitivity flag is on.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getApiKey } from "./keyStore";
import { getPreferences } from "../preferences";
import { query } from "../db/db";

export type CloudProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "proxy";

const PROXY_PATH = "/api/ai/chat";

export interface CloudCallContext {
  /** Investigation ID. */
  investigationId: string;
  /** True if this case is flagged culturally sensitive. */
  culturallySensitive: boolean;
}

export class CloudGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudGuardError";
  }
}

export class CloudKeyMissingError extends Error {
  provider: CloudProvider;
  constructor(provider: CloudProvider) {
    super(`No ${provider} API key configured. Add one in Settings → AI assistance.`);
    this.name = "CloudKeyMissingError";
    this.provider = provider;
  }
}

/**
 * Authoritative DB-backed check for the per-case cultural-sensitivity flag.
 *
 * Callers should prefer this over trusting `CloudCallContext.culturallySensitive`
 * alone — the context flag may be stale if the user toggled it between
 * call-time and now. We OR the two so either wins.
 */
export async function isInvestigationSensitive(investigationId: string): Promise<boolean> {
  try {
    const rows = await query<{ culturally_sensitive: number | bigint }>(
      "SELECT culturally_sensitive FROM investigations WHERE id = ?",
      [investigationId],
    );
    const raw = rows[0]?.culturally_sensitive ?? 0;
    return Number(raw) === 1;
  } catch {
    // Fail closed: if we can't read the flag, refuse cloud routing.
    return true;
  }
}

export async function ensureRoutable(ctx: CloudCallContext): Promise<void> {
  const prefs = getPreferences();
  // DB check is authoritative; ctx flag and global pref are belt-and-braces.
  const dbSensitive = await isInvestigationSensitive(ctx.investigationId);
  if (dbSensitive || ctx.culturallySensitive || prefs.globalCulturalSensitivityFlag) {
    throw new CloudGuardError(
      "Cloud AI is refused for culturally-sensitive cases. Audio and notes from this case cannot leave the device. Use on-device tools.",
    );
  }
}

async function callProxy(opts: { system: string; user: string; maxTokens?: number; temperature?: number; model?: string }): Promise<string | null> {
  try {
    const resp = await fetch(PROXY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: opts.system,
        user: opts.user,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        model: opts.model,
      }),
    });
    if (resp.status === 503) {
      // Proxy reachable but the operator hasn't set OPENROUTER_API_KEY in their
      // Cloudflare Pages env. Surface this directly — don't silently fall
      // through to BYOK, since BYOK has no UI in V1 and the user would just
      // see "add your API key" pointing at a nonexistent section.
      throw new CloudGuardError(
        "AI proxy isn't configured on this deployment. The operator needs to set OPENROUTER_API_KEY in Cloudflare dashboard → Pages → southern-signal → Settings → Environment variables.",
      );
    }
    if (resp.status === 402) {
      throw new Error("Out of OpenRouter credits. Top up at openrouter.ai/settings/credits, or switch to a cheaper model in your Cloudflare env (try anthropic/claude-haiku-4.5).");
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("OpenRouter rejected the key — check the OPENROUTER_API_KEY value in your Cloudflare Pages env.");
    }
    if (resp.status === 429) {
      throw new Error("OpenRouter rate-limited the request. Wait a moment and try again.");
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`AI proxy ${resp.status}: ${detail.slice(0, 240)}`);
    }
    const data = await resp.json() as { text?: string };
    if (!data.text) throw new Error("Proxy returned no text.");
    return data.text;
  } catch (err) {
    // True network failure (user offline, no functions running locally) →
    // fall through to BYOK if a developer has set an Anthropic key. Real
    // proxy errors (CloudGuardError, server status errors) re-throw.
    if (err instanceof TypeError) return null;
    throw err;
  }
}

async function callAnthropicBYOK(opts: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const apiKey = await getApiKey("anthropic");
  if (!apiKey) throw new CloudKeyMissingError("anthropic");
  const prefs = getPreferences();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.messages.create({
    model: prefs.ai.anthropicModel,
    max_tokens: opts.maxTokens ?? 768,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Provider-agnostic chat runner. Returns the assistant's text body.
 * Order: server proxy (default) → Anthropic BYOK (dev fallback).
 */
async function runChat(opts: { system: string; user: string; maxTokens?: number; temperature?: number }): Promise<string> {
  const proxied = await callProxy(opts);
  if (proxied != null) return proxied;
  return callAnthropicBYOK(opts);
}

const QUESTION_SYSTEM_PROMPT = `You are a thoughtful, respectful research assistant for a paranormal investigator.

The investigator is using ITC-style techniques (EVP recording, spirit box, Ovilus) to attempt communication with the deceased. They take this work seriously. Your job is to suggest QUESTIONS the investigator could ask out loud during a session.

Principles for the questions:
- Respectful, never goading. Treat the deceased as a person, not a subject.
- Open-ended. Avoid yes/no when possible — invite description.
- Specific to context when context is provided. Generic when not.
- One sentence each, conversational tone.
- Australian context: avoid sacred-site language; if the user mentions Country, acknowledge it without performing.
- Neutral on theology — investigators come from all traditions.

Output format: a JSON array of 5 strings. No preamble, no commentary, just the array. Example:
["What is your name, if you'd like to share it?", "Can you describe the room you're in?", "Is there anything you want us to know?", "Were you happy here?", "Is there someone you're waiting for?"]`;

const DEBUNKER_SYSTEM_PROMPT = `You are a forensically-trained skeptical investigator helping a paranormal field team rule out mundane explanations for an event before treating it as evidence.

Given an event description and any sensor / contamination context, propose 3 to 6 mundane explanations to test, ranked by plausibility. Be specific. Suggest a concrete test for each (what to measure or rule out).

Output format: a JSON array of objects { "hypothesis": string, "plausibility": 0..1, "test": string }. Plausibility is your honest estimate that the mundane explanation accounts for the observation.

Be concise. The team is in the field at night.`;

export async function generateQuestions(
  context: { siteContext?: string; tone?: "respectful" | "forensic" | "bold"; priorQuestions?: string[] },
  ctx: CloudCallContext,
): Promise<string[]> {
  await ensureRoutable(ctx);
  const userPrompt = [
    context.siteContext ? `Site context: ${context.siteContext}` : "No site context provided.",
    context.tone ? `Preferred tone: ${context.tone}.` : "",
    context.priorQuestions?.length
      ? `Avoid repeating these prior questions:\n- ${context.priorQuestions.join("\n- ")}`
      : "",
    "Suggest 5 fresh questions.",
  ].filter(Boolean).join("\n\n");

  const text = await runChat({
    system: QUESTION_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 280,
    temperature: 0.85,
  });
  return parseJsonArray(text);
}

export interface DebunkResult {
  hypothesis: string;
  plausibility: number;
  test: string;
}

export async function autoDebunk(
  input: { eventTitle: string; eventDescription?: string; sensorSummary?: string; contaminationMarkers?: string[] },
  ctx: CloudCallContext,
): Promise<DebunkResult[]> {
  await ensureRoutable(ctx);

  const userPrompt = [
    `Event: ${input.eventTitle}`,
    input.eventDescription ? `Description: ${input.eventDescription}` : "",
    input.sensorSummary ? `Sensor summary: ${input.sensorSummary}` : "",
    input.contaminationMarkers?.length
      ? `Contamination markers logged in this session: ${input.contaminationMarkers.join(", ")}`
      : "",
    "List mundane explanations to rule out.",
  ].filter(Boolean).join("\n\n");

  const text = await runChat({
    system: DEBUNKER_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 600,
    temperature: 0.6,
  });
  return parseJsonArray<DebunkResult>(text);
}

function parseJsonArray<T = unknown>(text: string): T[] {
  // Extract first JSON array from the response. Sonnet usually returns it
  // raw, but be defensive.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("AI did not return a JSON array");
  try {
    const parsed = JSON.parse(match[0]) as T[];
    if (!Array.isArray(parsed)) throw new Error("Response was not an array");
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse AI response: ${(err as Error).message}`);
  }
}
