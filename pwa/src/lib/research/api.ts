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
}

export class ResearchRateLimitError extends Error {
  // Explicit field declarations + assignments — the project's tsconfig
  // enforces `erasableSyntaxOnly`, which forbids parameter-property
  // shorthand (`constructor(public foo: number) {}`).
  runsToday: number;
  capPerDay: number;
  oldestRunMsAgo: number;
  constructor(runsToday: number, capPerDay: number, oldestRunMsAgo: number) {
    super(`Daily research cap reached (${runsToday}/${capPerDay}). Resets ${Math.round((24 - oldestRunMsAgo / 3_600_000) * 10) / 10}h from now.`);
    this.name = "ResearchRateLimitError";
    this.runsToday = runsToday;
    this.capPerDay = capPerDay;
    this.oldestRunMsAgo = oldestRunMsAgo;
  }
}

const RATE_LIMIT_KEY = "ss-research-runs-v1";
const RATE_LIMIT_CAP = 3;
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

/** Record a successful run (after the server responds OK). Called by
 *  runResearch on success; exported separately for tests. */
function recordRun(): void {
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

  const res = await fetch("/api/ai/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      venueName: req.venueName,
      locationHint: req.locationHint,
      region: req.region ?? "AU",
      culturallySensitive: req.culturallySensitive ?? false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let parsed: { error?: string; detail?: string } | null = null;
    try { parsed = JSON.parse(detail); } catch { /* fall through */ }
    const msg = parsed?.error ? `${parsed.error}${parsed.detail ? `: ${parsed.detail}` : ""}` : `Research ${res.status}: ${detail.slice(0, 200)}`;
    throw new Error(msg);
  }

  const json = await res.json() as ResearchResult;
  // Record only on a 2xx success so users aren't burned for failures.
  recordRun();
  return json;
}
