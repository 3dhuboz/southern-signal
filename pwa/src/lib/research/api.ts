/**
 * Client wrapper for the /api/ai/research endpoint.
 *
 * Mirrors the shape returned by the server. Includes a localStorage-
 * backed soft rate-limit (3 runs per device per 24h) — bypassable by
 * clearing storage but enough to keep an enthusiastic operator from
 * burning the cloud-AI budget in one session.
 */

export type ResearchTier =
  | "HERITAGE"
  | "DOCUMENTED_INCIDENT"
  | "CULTURAL_SIGNIFICANCE"
  | "FOLKLORE"
  | "SYNTHESIS";

export interface ResearchSource {
  label: string;
  url: string;
}

export interface ResearchFinding {
  tier: ResearchTier;
  title: string;
  body: string;
  sources: ResearchSource[];
}

export interface ResearchResult {
  findings: ResearchFinding[];
  suggestions: string[];
  search_terms_used: string[];
  citations_raw: string[];
  model: string;
  warnings: string[];
}

export interface ResearchRequest {
  venueName: string;
  locationHint?: string;
  region?: "AU" | "GLOBAL";
  culturallySensitive?: boolean;
  /** Optional drill-down on a prior finding. When set, the server biases
   *  the prompt to extend the parent finding rather than reopening the
   *  venue at the top level. Still counts against rate limits. */
  followup?: {
    parentTitle: string;
    parentBody: string;
    parentSources: ResearchSource[];
    question: string;
  };
}

export class ResearchRateLimitError extends Error {
  // Explicit field declarations + assignments — the project's tsconfig
  // enforces `erasableSyntaxOnly`, which forbids parameter-property
  // shorthand (`constructor(public foo: number) {}`).
  runsToday: number;
  capPerDay: number;
  oldestRunMsAgo: number;
  /** True when the cap was enforced by the server (429), false when it
   *  came from the client-side localStorage soft cap. Lets the UI tell
   *  the operator "the network is over its budget — clearing storage
   *  won't help" vs "your device has burned its share — clear storage
   *  if you have to". */
  fromServer: boolean;
  constructor(runsToday: number, capPerDay: number, oldestRunMsAgo: number, fromServer = false) {
    super(`Daily research cap reached (${runsToday}/${capPerDay}). Resets ${Math.round((24 - oldestRunMsAgo / 3_600_000) * 10) / 10}h from now.`);
    this.name = "ResearchRateLimitError";
    this.runsToday = runsToday;
    this.capPerDay = capPerDay;
    this.oldestRunMsAgo = oldestRunMsAgo;
    this.fromServer = fromServer;
  }
}

const RATE_LIMIT_KEY = "ss-research-runs-v1";
export const RATE_LIMIT_CAP = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function readRunLog(): number[] {
  try {
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((n): n is number => typeof n === "number");
  } catch {
    return [];
  }
}

function writeRunLog(log: number[]): void {
  try { localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(log)); } catch { /* ignore */ }
}

/** Returns { used, cap, resetMs } describing the current rate-limit state.
 *  Used by the UI to show "2 of 3 runs used today". */
export function getResearchRateState(): { used: number; cap: number; nextResetMs: number | null } {
  const now = Date.now();
  const log = readRunLog().filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  const oldest = log[0] ?? null;
  return {
    used: log.length,
    cap: RATE_LIMIT_CAP,
    nextResetMs: oldest == null ? null : oldest + RATE_LIMIT_WINDOW_MS - now,
  };
}

/** Record a successful run in the localStorage soft-cap log. Called
 *  by both the one-shot (runResearch) and the streaming wrapper on
 *  successful completion. */
export function recordResearchRun(): void {
  const now = Date.now();
  const log = [...readRunLog().filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS), now];
  writeRunLog(log);
}

export async function runResearch(req: ResearchRequest): Promise<ResearchResult> {
  // Client-side rate check before we even leave the device. Server has no
  // counter in V1 — this is the soft limit. Clearing localStorage bypasses
  // it; the operator pays the cloud cost themselves at that point.
  const state = getResearchRateState();
  if (state.used >= state.cap) {
    const log = readRunLog();
    const oldest = log[0] ?? Date.now();
    throw new ResearchRateLimitError(state.used, state.cap, Date.now() - oldest);
  }

  const { signedJson } = await import("../ai/signedFetch");
  const res = await signedJson("/api/ai/research", {
    venueName: req.venueName,
    locationHint: req.locationHint,
    region: req.region ?? "AU",
    culturallySensitive: req.culturallySensitive ?? false,
    followup: req.followup,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let parsed: { error?: string; detail?: string; retry_after_seconds?: number } | null = null;
    try { parsed = JSON.parse(detail); } catch { /* fall through */ }

    // 429 from the server-side rate limit: lift it into the same
    // ResearchRateLimitError type the client uses, but tagged
    // fromServer=true so the UI can show "network is over its budget"
    // copy rather than "your device is".
    if (res.status === 429) {
      const limitHeader = parseInt(res.headers.get("X-RateLimit-Limit") ?? "0", 10);
      const resetSec = parsed?.retry_after_seconds ?? parseInt(res.headers.get("X-RateLimit-Reset-Seconds") ?? "0", 10);
      throw new ResearchRateLimitError(
        limitHeader || RATE_LIMIT_CAP,
        limitHeader || RATE_LIMIT_CAP,
        Math.max(0, 24 * 3600 * 1000 - resetSec * 1000),
        true,
      );
    }

    // 404 = the route isn't on the build. Typically a stale Cloudflare
    // Pages deploy that predates this endpoint — point operators at the
    // re-deploy command instead of a cryptic "Research 404:".
    if (res.status === 404) {
      throw new Error(
        "AI Investigator isn't on this build — the /api/ai/research route 404'd. The Cloudflare Pages deploy is older than this feature. Re-deploy with `npx wrangler pages deploy dist --project-name=southern-signal` or push to the connected git remote so Cloudflare auto-builds.",
      );
    }

    const msg = parsed?.error ? `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ""}` : `Research ${res.status}: ${detail.slice(0, 200)}`;
    throw new Error(msg);
  }

  const json = await res.json() as ResearchResult;
  // Only on a 2xx — failures don't burn the user's budget.
  recordResearchRun();
  return json;
}
