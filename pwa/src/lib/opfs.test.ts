import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory OPFS shim. The real FileSystem* handles live in lib.dom.d.ts and
// are only available in browsers — under vitest's node env we need a Map-
// backed tree that mimics getDirectoryHandle / getFileHandle / removeEntry /
// values() / createWritable() / getFile(). This shim is intentionally small:
// it covers the cases this module exercises and nothing else.
// ---------------------------------------------------------------------------

interface FakeFile {
  kind: "file";
  name: string;
  data: Uint8Array;
}

interface FakeDirectory {
  kind: "directory";
  name: string;
  children: Map<string, FakeFile | FakeDirectory>;
}

function mkDir(name: string): FakeDirectory {
  return { kind: "directory", name, children: new Map() };
}

class FakeFileHandle {
  kind: "file" = "file";
  // No `private` modifier — tsconfig has erasableSyntaxOnly which rejects
  // TS-only access modifiers. Test fakes don't need access control anyway.
  node: FakeFile;
  constructor(node: FakeFile) { this.node = node; }
  get name() { return this.node.name; }
  async getFile() {
    const u8 = this.node.data;
    return {
      name: this.node.name,
      size: u8.byteLength,
      type: "",
      text: async () => new TextDecoder().decode(u8),
      arrayBuffer: async () => {
        const copy = new Uint8Array(u8.byteLength);
        copy.set(u8);
        return copy.buffer;
      },
    } as unknown as File;
  }
  async createWritable() {
    let buffer = new Uint8Array(0);
    const node = this.node;
    return {
      async write(chunk: ArrayBuffer | Uint8Array | Blob) {
        let bytes: Uint8Array;
        if (chunk instanceof Uint8Array) bytes = chunk;
        else if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
        else {
          // Treat as Blob — use arrayBuffer() if present.
          const blobLike = chunk as { arrayBuffer?: () => Promise<ArrayBuffer>; text?: () => Promise<string> };
          if (typeof blobLike.arrayBuffer === "function") {
            bytes = new Uint8Array(await blobLike.arrayBuffer());
          } else if (typeof blobLike.text === "function") {
            bytes = new TextEncoder().encode(await blobLike.text());
          } else {
            bytes = new Uint8Array(0);
          }
        }
        // Append behaviour — close commits to the node.
        const next = new Uint8Array(buffer.byteLength + bytes.byteLength);
        next.set(buffer);
        next.set(bytes, buffer.byteLength);
        buffer = next;
      },
      async close() {
        node.data = buffer;
      },
    };
  }
}

class FakeDirHandle {
  kind: "directory" = "directory";
  node: FakeDirectory;
  constructor(node: FakeDirectory) { this.node = node; }
  get name() { return this.node.name; }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let existing = this.node.children.get(name);
    if (!existing && opts?.create) {
      existing = mkDir(name);
      this.node.children.set(name, existing);
    }
    if (!existing) throw new Error(`NotFoundError: ${name}`);
    if (existing.kind !== "directory") throw new Error(`TypeMismatchError: ${name} is a file`);
    return new FakeDirHandle(existing);
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let existing = this.node.children.get(name);
    if (!existing && opts?.create) {
      existing = { kind: "file", name, data: new Uint8Array(0) } as FakeFile;
      this.node.children.set(name, existing);
    }
    if (!existing) throw new Error(`NotFoundError: ${name}`);
    if (existing.kind !== "file") throw new Error(`TypeMismatchError: ${name} is a directory`);
    return new FakeFileHandle(existing);
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.node.children.has(name)) throw new Error(`NotFoundError: ${name}`);
    this.node.children.delete(name);
  }

  async *values() {
    for (const child of this.node.children.values()) {
      yield child.kind === "directory" ? new FakeDirHandle(child) : new FakeFileHandle(child);
    }
  }
}

// ---------------------------------------------------------------------------
// Test harness. Fresh root + navigator on each test.
// ---------------------------------------------------------------------------

const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
let root: FakeDirectory;

beforeEach(() => {
  root = mkDir("");
  const rootHandle = new FakeDirHandle(root);
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => rootHandle,
      persist: async () => true,
      estimate: async () => ({ usage: 100, quota: 1000 }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNavigator !== undefined) {
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

import {
  deletePath,
  exists,
  getDirectory,
  getStorageEstimate,
  isOpfsSupported,
  listDirectory,
  readJson,
  readText,
  requestPersistentStorage,
  writeBytes,
  writeJson,
  writeText,
} from "./opfs";

describe("OPFS feature detection", () => {
  it("isOpfsSupported returns true when navigator.storage.getDirectory exists", () => {
    expect(isOpfsSupported()).toBe(true);
  });

  it("isOpfsSupported returns false when navigator.storage.getDirectory is absent", () => {
    vi.stubGlobal("navigator", { storage: {} });
    expect(isOpfsSupported()).toBe(false);
  });
});

describe("requestPersistentStorage", () => {
  it("delegates to navigator.storage.persist", async () => {
    expect(await requestPersistentStorage()).toBe(true);
  });

  it("returns false when navigator.storage.persist is missing", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => new FakeDirHandle(root) } });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("returns false when persist() throws", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => new FakeDirHandle(root),
        persist: async () => { throw new Error("denied"); },
      },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });
});

describe("getStorageEstimate", () => {
  it("forwards navigator.storage.estimate output", async () => {
    expect(await getStorageEstimate()).toEqual({ usage: 100, quota: 1000 });
  });

  it("returns empty object when estimate API is missing", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => new FakeDirHandle(root) } });
    expect(await getStorageEstimate()).toEqual({});
  });

  it("returns empty object when estimate() throws", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: async () => new FakeDirHandle(root),
        estimate: async () => { throw new Error("opaque"); },
      },
    });
    expect(await getStorageEstimate()).toEqual({});
  });
});

describe("writeBytes / readText / readJson — path semantics", () => {
  it("writes bytes at a slash-separated path, creating intermediate dirs", async () => {
    await writeBytes("cases/case-A/recording.wav", new Uint8Array([1, 2, 3, 4]));
    // Verify the tree structure.
    const cases = root.children.get("cases") as FakeDirectory;
    expect(cases?.kind).toBe("directory");
    const caseA = cases.children.get("case-A") as FakeDirectory;
    expect(caseA?.kind).toBe("directory");
    const file = caseA.children.get("recording.wav") as FakeFile;
    expect(file?.kind).toBe("file");
    expect(Array.from(file.data)).toEqual([1, 2, 3, 4]);
  });

  it("writeText round-trips through readText", async () => {
    await writeText("cases/case-A/notes.txt", "hello world");
    expect(await readText("cases/case-A/notes.txt")).toBe("hello world");
  });

  it("writeJson round-trips through readJson", async () => {
    await writeJson("cases/case-A/meta.json", { a: 1, b: [2, 3] });
    expect(await readJson("cases/case-A/meta.json")).toEqual({ a: 1, b: [2, 3] });
  });

  it("writeBytes accepts ArrayBuffer input", async () => {
    const buf = new Uint8Array([9, 8, 7]).buffer;
    await writeBytes("dir/file.bin", buf);
    const dir = root.children.get("dir") as FakeDirectory;
    const file = dir.children.get("file.bin") as FakeFile;
    expect(Array.from(file.data)).toEqual([9, 8, 7]);
  });
});

describe("getDirectory", () => {
  it("returns the root when path is empty", async () => {
    const dir = await getDirectory("");
    // Root is the unnamed top-level directory.
    expect((dir as unknown as FakeDirHandle).name).toBe("");
  });

  it("throws when an intermediate segment doesn't exist and create=false", async () => {
    await expect(getDirectory("missing/sub")).rejects.toThrow(/NotFoundError/);
  });

  it("creates intermediate segments when create=true", async () => {
    await getDirectory("a/b/c", true);
    const a = root.children.get("a") as FakeDirectory;
    expect(a.children.get("b")).toBeDefined();
    expect(((a.children.get("b") as FakeDirectory).children.get("c"))).toBeDefined();
  });
});

describe("listDirectory", () => {
  it("lists files and subdirs by kind", async () => {
    await writeText("cases/case-A/a.txt", "a");
    await writeText("cases/case-A/b.txt", "b");
    await getDirectory("cases/case-A/subdir", true);
    const entries = await listDirectory("cases/case-A");
    const names = entries.map((e) => `${e.kind}:${e.name}`).sort();
    expect(names).toEqual(["directory:subdir", "file:a.txt", "file:b.txt"]);
  });

  it("returns an empty array for an empty directory", async () => {
    await getDirectory("cases/empty", true);
    expect(await listDirectory("cases/empty")).toEqual([]);
  });
});

describe("deletePath", () => {
  it("removes a single file from its parent directory", async () => {
    await writeText("cases/case-A/x.txt", "hi");
    await deletePath("cases/case-A/x.txt");
    expect(await listDirectory("cases/case-A")).toEqual([]);
  });

  it("removes a directory recursively", async () => {
    await writeText("cases/case-A/x.txt", "hi");
    await writeText("cases/case-A/sub/y.txt", "yo");
    await deletePath("cases/case-A");
    expect((root.children.get("cases") as FakeDirectory).children.has("case-A")).toBe(false);
  });

  it("is a no-op when the path is empty", async () => {
    await expect(deletePath("")).resolves.toBeUndefined();
  });
});

describe("exists", () => {
  it("returns true for an existing file", async () => {
    await writeText("a.txt", "x");
    expect(await exists("a.txt")).toBe(true);
  });

  it("returns true for an existing directory", async () => {
    await getDirectory("cases/case-A", true);
    expect(await exists("cases/case-A")).toBe(true);
  });

  it("returns false for a non-existent path", async () => {
    expect(await exists("nope/notreal")).toBe(false);
  });
});
