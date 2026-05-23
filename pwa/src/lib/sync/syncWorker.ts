/**
 * Background sync worker — drains the local sync_queue to /api/sync/upload.
 *
 * Trigger conditions (any of):
 *   - bootstrap (after recoverInFlight)
 *   - 'online' window event
 *   - tab becomes visible (visibilitychange → 'visible')
 *   - 60s interval while visible + online
 *   - manual flush (Setup UI button)
 *
 * Concurrency: at most one drain in flight per tab. Cross-tab races are
 * tolerated — the server uses INSERT OR IGNORE so duplicates are no-ops.
 *
 * Defense in depth:
 *   - cultural-sensitivity flag (global) hard-blocks ALL outbound sync
 *   - sync.enabled pref must be true
 *   - sync.endpoint must be set
 */

import { readFile } from "../opfs";
import { getPreferences } from "../preferences";
import { signedMultipart, type MultipartPart } from "../ai/signedFetch";
import { listDueForUpload, markDone, markFailed, markInFlight, recoverInFlight, getStats } from "./queue";
import type { SyncItem, SyncStats, UploadItem, UploadResponse } from "./types";

const BATCH_SIZE = 16;
const POLL_INTERVAL_MS = 60_000;

let inFlightDrain: Promise<DrainResult> | null = null;
let intervalHandle: number | null = null;
let registered = false;

export interface DrainResult {
  ranAt: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skippedReason?: string;
  stats: SyncStats;
}

interface SyncSettings {
  endpoint: string;
  token: string | null;
}

type SyncSettingsResult = SyncSettings | { skippedReason: string };

export function normaliseSameOriginEndpoint(endpoint: string): { endpoint: string } | { skippedReason: string } {
  if (typeof location === "undefined") return { endpoint };
  try {
    const url = new URL(endpoint, location.origin);
    if (url.origin !== location.origin) {
      return { skippedReason: "sync endpoint must be same-origin" };
    }
    return { endpoint: `${url.pathname}${url.search}${url.hash}` };
  } catch {
    return { skippedReason: "sync endpoint URL is invalid" };
  }
}

function readSettings(): SyncSettingsResult | null {
  const prefs = getPreferences();
  if (!prefs.sync?.enabled) return null;
  if (prefs.globalCulturalSensitivityFlag) return null;
  const endpoint = prefs.sync?.endpoint?.trim();
  if (!endpoint) return null;
  const sameOrigin = normaliseSameOriginEndpoint(endpoint);
  if ("skippedReason" in sameOrigin) return sameOrigin;
  return { endpoint: sameOrigin.endpoint, token: prefs.sync?.token ?? null };
}

function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

async function uploadBatch(items: SyncItem[], settings: SyncSettings): Promise<UploadResponse> {
  // For media_blob items, we send multipart with file blobs. Build the
  // multipart bytes ourselves so the device signature covers the exact body
  // the server receives.
  const parts: MultipartPart[] = [];
  const wireItems: UploadItem[] = [];

  for (const item of items) {
    const payload = JSON.parse(item.payload_json) as Record<string, unknown>;
    const wire: UploadItem = { kind: item.kind, ref_id: item.ref_id, payload };
    if (item.kind === "media_blob" && item.file_path) {
      try {
        const file = await readFile(item.file_path);
        wire.byte_length = file.size;
        wire.r2_key = `media/${(payload.investigation_id as string) ?? "unknown"}/${item.ref_id}`;
        parts.push({ name: `file:${item.ref_id}`, blob: file, filename: item.ref_id });
      } catch (err) {
        // File is gone (deleted before sync). Treat as a soft fail — server
        // never sees it; client will mark this item failed with a clear msg.
        console.warn(`[sync] media_blob ${item.ref_id} missing locally`, err);
        throw new Error(`local file missing: ${item.file_path}`, { cause: err });
      }
    }
    wireItems.push(wire);
  }

  parts.unshift({ name: "items", value: JSON.stringify(wireItems) });

  const headers: Record<string, string> = {};
  if (settings.token) headers["Authorization"] = `Bearer ${settings.token}`;
  const resp = await signedMultipart(settings.endpoint, parts, { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return await resp.json() as UploadResponse;
}

async function runDrain(): Promise<DrainResult> {
  const ranAt = new Date().toISOString();
  const settings = readSettings();
  if (!settings) {
    return { ranAt, attempted: 0, succeeded: 0, failed: 0, skippedReason: "sync disabled", stats: await getStats() };
  }
  if ("skippedReason" in settings) {
    return { ranAt, attempted: 0, succeeded: 0, failed: 0, skippedReason: settings.skippedReason, stats: await getStats() };
  }
  if (!isOnline()) {
    return { ranAt, attempted: 0, succeeded: 0, failed: 0, skippedReason: "offline", stats: await getStats() };
  }

  let succeeded = 0;
  let failed = 0;
  let attempted = 0;

  // Drain until no more pending or the batch fails.
  for (let pass = 0; pass < 8; pass += 1) {
    const items = await listDueForUpload(BATCH_SIZE);
    if (items.length === 0) break;
    attempted += items.length;
    await markInFlight(items.map((i) => i.id));

    try {
      const resp = await uploadBatch(items, settings);
      const acceptedSet = new Set(resp.accepted);
      const rejectedMap = new Map(resp.rejected.map((r) => [r.ref_id, r.reason] as const));
      const okIds: number[] = [];
      for (const item of items) {
        if (acceptedSet.has(item.ref_id)) {
          okIds.push(item.id);
          succeeded += 1;
        } else {
          const reason = rejectedMap.get(item.ref_id) ?? "unknown reason";
          await markFailed(item.id, reason, item.attempts + 1);
          failed += 1;
        }
      }
      await markDone(okIds);
    } catch (err) {
      // Whole batch failed (network/auth/server). Mark each individually so
      // backoff applies per item.
      const msg = err instanceof Error ? err.message : String(err);
      for (const item of items) {
        await markFailed(item.id, msg, item.attempts + 1);
        failed += 1;
      }
      // Stop draining — likely network issue, no point hammering.
      break;
    }
  }

  return { ranAt, attempted, succeeded, failed, stats: await getStats() };
}

/** Public: trigger a drain. Coalesces concurrent calls into one in-flight drain. */
export async function flushSync(): Promise<DrainResult> {
  if (inFlightDrain) return inFlightDrain;
  inFlightDrain = runDrain().finally(() => { inFlightDrain = null; });
  return inFlightDrain;
}

/** One-time setup: recover stuck rows, attach event listeners, kick off interval. */
export async function startSyncWorker(): Promise<void> {
  if (registered) return;
  registered = true;
  await recoverInFlight().catch((err) => console.warn("[sync] recoverInFlight failed", err));

  // Drain on online + visibility events.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { void flushSync(); });
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void flushSync();
    });
  }

  // Periodic drain while tab is visible + online.
  if (typeof window !== "undefined" && intervalHandle == null) {
    intervalHandle = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!isOnline()) return;
      void flushSync();
    }, POLL_INTERVAL_MS);
  }

  // Kick off an initial drain (don't await — bootstrap shouldn't block on it).
  void flushSync();
}
