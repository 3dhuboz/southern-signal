/**
 * Minimal OPFS (Origin Private File System) wrapper.
 *
 * Browser support: iOS Safari 16+, Chrome 102+, Firefox 111+. Falls back to
 * throwing on unsupported environments — caller should feature-detect via
 * `isOpfsSupported()` first.
 *
 * iOS Safari quirk: OPFS storage caps near 1 GiB without `navigator.storage.persist()`.
 * The Storage Standard says persist() succeeds only when:
 *   - a secure context (HTTPS or localhost) is active,
 *   - a user gesture is "still active" (per browser heuristics), and
 *   - the browser is willing to grant — Chromium uses a heuristic that
 *     includes "site has stored data" and "PWA installed".
 *
 * Call `requestPersistentStorage()` from a button-gesture handler that
 * also creates the first stored asset (so the heuristic is satisfied).
 */

const PERSIST_DECIDED_KEY = "ss:persist-decided";

export function isOpfsSupported(): boolean {
  return typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage;
}

/**
 * Whether the browser has already granted persistent-storage to this
 * origin. Safe to call any time; returns false if the API is missing.
 *
 * This is the spec'd `navigator.storage.persisted()` (past-tense, a
 * read) — distinct from `persist()` (present-tense, a request). We
 * check it before re-asking so we don't burn a permission prompt on
 * Chrome desktop, where re-asking after a "no" can be ignored.
 */
export async function isStoragePersisted(): Promise<boolean> {
  if (!("storage" in navigator) || !("persisted" in navigator.storage)) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Ask the browser to mark this origin's storage as persistent.
 *
 * - Returns the new persistence state (true if granted now OR already).
 * - Idempotent: if already persisted, short-circuits without a re-ask.
 * - Caches the decision in localStorage so subsequent app launches
 *   don't re-issue the prompt every time `handleBegin` fires. The cache
 *   stores both grants AND denials — a user who said "no" once
 *   shouldn't be re-asked on every session (the storage spec doesn't
 *   promise the prompt's UX is the same on every browser, and on iOS
 *   it shows up as a dotted-line indicator the user already chose).
 *
 * Best called from a button-gesture handler that ALSO performs the
 * first meaningful storage write (creates the day's investigation row).
 * Browser heuristics weight gesture + recent storage activity heavily.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!("storage" in navigator) || !("persist" in navigator.storage)) return false;

  // Cheapest exit: persisted() is read-only, never prompts, and short-
  // circuits on the second + nth Begin tap once we've already been granted.
  if (await isStoragePersisted()) {
    rememberDecision("granted");
    return true;
  }

  // Skip the re-ask if a prior call already got a final answer this session.
  // We don't want a "no" to silently keep prompting on each Begin tap.
  const prior = readDecision();
  if (prior === "denied") return false;

  try {
    const granted = await navigator.storage.persist();
    rememberDecision(granted ? "granted" : "denied");
    return granted;
  } catch {
    // Don't poison the cache on a transient throw — leave the door open
    // for a retry next time (some Safari versions throw on first call
    // before storage is ready, then succeed on a follow-up).
    return false;
  }
}

function readDecision(): "granted" | "denied" | null {
  try {
    const v = globalThis.localStorage?.getItem(PERSIST_DECIDED_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function rememberDecision(decision: "granted" | "denied"): void {
  try { globalThis.localStorage?.setItem(PERSIST_DECIDED_KEY, decision); } catch { /* private mode */ }
}

export async function getStorageEstimate(): Promise<{ usage?: number; quota?: number }> {
  if (!("storage" in navigator) || !("estimate" in navigator.storage)) return {};
  try {
    return await navigator.storage.estimate();
  } catch {
    return {};
  }
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) throw new Error("OPFS is not supported in this browser");
  return navigator.storage.getDirectory();
}

/** Resolve a directory by slash-separated path. Creates segments as needed when `create` is true. */
export async function getDirectory(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await getRoot();
  if (!path) return dir;
  for (const segment of path.split("/").filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

/** Resolve (or optionally create) a file at a slash-separated path. */
export async function getFile(path: string, create = false): Promise<FileSystemFileHandle> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("File path is empty");
  const fileName = segments.pop()!;
  const dir = await getDirectory(segments.join("/"), create);
  return dir.getFileHandle(fileName, { create });
}

export async function readFile(path: string): Promise<File> {
  const handle = await getFile(path);
  return handle.getFile();
}

export async function readText(path: string): Promise<string> {
  const file = await readFile(path);
  return file.text();
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

export async function writeBytes(path: string, data: ArrayBuffer | Uint8Array | Blob): Promise<void> {
  const handle = await getFile(path, true);
  const writable = await handle.createWritable();
  try {
    // FileSystemWritableFileStream.write accepts Blob | BufferSource | string;
    // narrow Uint8Array views to a fresh ArrayBuffer to satisfy the stricter
    // BufferSource type in some lib.dom.d.ts versions.
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      await writable.write(copy.buffer);
    } else {
      await writable.write(data);
    }
  } finally {
    await writable.close();
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  await writeBytes(path, new Blob([text], { type: "text/plain" }));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2));
}

export async function deletePath(path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return;
  const last = segments.pop()!;
  const dir = await getDirectory(segments.join("/"));
  await dir.removeEntry(last, { recursive: true });
}

export async function listDirectory(path: string): Promise<{ name: string; kind: "file" | "directory" }[]> {
  const dir = await getDirectory(path);
  const entries: { name: string; kind: "file" | "directory" }[] = [];
  // FileSystemDirectoryHandle implements AsyncIterable<FileSystemHandle> via .values()
  // (and entries()/keys()), available in lib.dom.d.ts ≥ 2024.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    entries.push({ name: entry.name, kind: entry.kind });
  }
  return entries;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await getFile(path);
    return true;
  } catch {
    try {
      await getDirectory(path);
      return true;
    } catch {
      return false;
    }
  }
}
