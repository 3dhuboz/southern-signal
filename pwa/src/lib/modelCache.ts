/**
 * Cache AI model files (Whisper, VAD, embeddings) in OPFS so they survive
 * page reloads and work offline.
 *
 * First-load downloads from the configured URL. Subsequent loads stream from
 * OPFS. Optional integrity check via SubtleCrypto SHA-256.
 */

import { exists, readFile, writeBytes } from "./opfs";
import { sha256HexBytes } from "./forensic/canonicalJson";

export interface ModelDescriptor {
  /** Stable identifier — also the OPFS path under /models/. */
  id: string;
  /** Source URL (CDN, hosted weights, etc.) for first-time fetch. */
  url: string;
  /** Optional SHA-256 hex of the expected bytes for integrity check. */
  sha256?: string;
  /** Approximate size in MB, for UX progress messaging. */
  approxSizeMb?: number;
}

export async function ensureModel(
  desc: ModelDescriptor,
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<File> {
  const path = `models/${desc.id}`;
  if (await exists(path)) {
    const cached = await readFile(path);
    if (desc.sha256) {
      const buf = await cached.arrayBuffer();
      const hex = await sha256HexBytes(buf);
      if (hex !== desc.sha256) {
        // Cache poisoned somehow — re-download.
        return downloadAndCache(desc, onProgress);
      }
    }
    return cached;
  }
  return downloadAndCache(desc, onProgress);
}

async function downloadAndCache(
  desc: ModelDescriptor,
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<File> {
  const response = await fetch(desc.url);
  if (!response.ok) throw new Error(`Failed to fetch ${desc.id}: HTTP ${response.status}`);
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : null;

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not streamable");

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  }

  const merged = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }

  if (desc.sha256) {
    const hex = await sha256HexBytes(merged.buffer);
    if (hex !== desc.sha256) throw new Error(`${desc.id} integrity check failed (got ${hex.slice(0, 16)}…)`);
  }

  await writeBytes(`models/${desc.id}`, merged);
  return readFile(`models/${desc.id}`);
}

export async function clearModelCache(): Promise<void> {
  // Walk /models and delete each entry.
  const { listDirectory, deletePath } = await import("./opfs");
  try {
    const entries = await listDirectory("models");
    for (const e of entries) await deletePath(`models/${e.name}`);
  } catch {
    /* models dir doesn't exist — that's fine */
  }
}
