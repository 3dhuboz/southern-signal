/**
 * Minimal OPFS (Origin Private File System) wrapper.
 *
 * Browser support: iOS Safari 16+, Chrome 102+, Firefox 111+. Falls back to
 * throwing on unsupported environments — caller should feature-detect via
 * `isOpfsSupported()` first.
 *
 * iOS Safari quirk: OPFS storage caps near 1 GiB without `navigator.storage.persist()`.
 * Call `requestPersistentStorage()` early in onboarding.
 */

export function isOpfsSupported(): boolean {
  return typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!("storage" in navigator) || !("persist" in navigator.storage)) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
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
