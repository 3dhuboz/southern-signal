/**
 * Cloudflare Pages Function — GET /api/sync/status
 *
 * Reports whether the deployment has SYNC_TOKEN + bindings configured, plus
 * row counts in D1 (best-effort). Used by the client SyncPanel to confirm
 * the operator wired up the backend before showing "online" UI.
 *
 * No auth required (status endpoint reveals only counts, not data).
 */

interface Env {
  SYNC_TOKEN?: string;
  SYNC_DB?: D1Database;
  MEDIA_BUCKET?: R2Bucket;
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

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface D1PreparedStatement {
  all(): Promise<{ results: { n: number }[] }>;
}
interface R2Bucket {
  head(key: string): Promise<unknown | null>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  },
});

async function tryCount(db: D1Database, table: string): Promise<number> {
  try {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
    return r.results[0]?.n ?? 0;
  } catch { return 0; }
}

export const onRequestGet: PagesFn<Env> = async ({ env }) => {
  const configured = !!env.SYNC_TOKEN && !!env.SYNC_DB && !!env.MEDIA_BUCKET;
  const status: Record<string, unknown> = {
    configured,
    has_token: !!env.SYNC_TOKEN,
    has_d1: !!env.SYNC_DB,
    has_r2: !!env.MEDIA_BUCKET,
  };
  if (env.SYNC_DB) {
    status.counts = {
      investigations: await tryCount(env.SYNC_DB, "investigations"),
      events: await tryCount(env.SYNC_DB, "evidence_events"),
      media: await tryCount(env.SYNC_DB, "media_assets"),
      audit: await tryCount(env.SYNC_DB, "audit_log"),
      transcripts: await tryCount(env.SYNC_DB, "transcripts"),
    };
  }
  return jsonResponse(status, 200);
};
