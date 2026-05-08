/**
 * Cloud AI router (Step 10 — scaffold).
 *
 * **Status: scaffold with privacy guardrails enforced.** Multi-provider
 * routing (Anthropic / OpenAI / Gemini) for: question generation, auto-
 * debunker, report writer, AI second-blind-reviewer.
 *
 * V1 commitments (decided 2026-05-08):
 *   - Cloud AI is **disabled by default**. Users supply their own API keys
 *     in Settings → AI assistance. Steve never holds keys.
 *   - Hard-coded refusal at the router layer for any case flagged
 *     `culturallySensitive: true`. The flag is checked here, not in the UI,
 *     so a buggy UI cannot leak audio.
 *   - On-device fallbacks (Phi-3-mini via WebLLM) plug in here when the
 *     user has no key OR when the case is sensitive.
 *
 * Bring-up checklist:
 *   1. Add IndexedDB-backed key store (origin-bound, never synced).
 *   2. Add per-provider clients (anthropic.ts / openai.ts / gemini.ts).
 *   3. Expose React hooks: `useQuestionSuggestions`, `useAutoDebunker`,
 *      `useReportWriter`.
 *   4. Wire WebLLM with Phi-3-mini Q4 (~2.2 GB) for offline fallback.
 *   5. Audit-log every cloud call (`prompt_hash`, `provider`, `model`,
 *      `latency_ms`, `tokens`) — never the prompt or response.
 */

export type CloudProvider = "anthropic" | "openai" | "gemini";

export interface CloudKey {
  provider: CloudProvider;
  apiKey: string;
  preferredModel?: string;
}

export interface CloudCallContext {
  /** Investigation ID. */
  investigationId: string;
  /** True if the case is flagged culturally sensitive — REFUSED at router. */
  culturallySensitive: boolean;
}

export class CloudGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudGuardError";
  }
}

export async function ensureRoutable(ctx: CloudCallContext): Promise<void> {
  if (ctx.culturallySensitive) {
    throw new CloudGuardError(
      "Cloud AI is refused for culturally-sensitive cases. Audio and notes from this case cannot leave the device. Use on-device tools instead.",
    );
  }
}

export async function generateQuestion(
  _context: { siteContext?: string; tone?: "respectful" | "forensic" | "bold"; priorQuestions?: string[] },
  ctx: CloudCallContext,
): Promise<string[]> {
  await ensureRoutable(ctx);
  throw new Error("cloudAi.generateQuestion() is a scaffold — provider wiring lands in step 10 build.");
}

export async function autoDebunk(
  _input: { transcript: string; sensorSummary: string; contaminationMarkers: string[] },
  ctx: CloudCallContext,
): Promise<{ explanations: { hypothesis: string; plausibility: number; reasoning: string }[] }> {
  await ensureRoutable(ctx);
  throw new Error("cloudAi.autoDebunk() is a scaffold — provider wiring lands in step 10 build.");
}

export async function writeReport(
  _input: { caseSummary: string; tone?: "client" | "technical" | "academic" },
  ctx: CloudCallContext,
): Promise<string> {
  await ensureRoutable(ctx);
  throw new Error("cloudAi.writeReport() is a scaffold — provider wiring lands in step 10 build.");
}
