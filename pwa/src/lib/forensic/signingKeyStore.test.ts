import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB shim — covers the subset signingKeyStore.ts
// touches: open() + onupgradeneeded + transaction("readonly"|"readwrite") +
// objectStore.get + .put + req.onsuccess / .onerror. fake-indexeddb is not a
// dep on this project so we mock the surface explicitly via vi.stubGlobal.
// ---------------------------------------------------------------------------

interface IdbStore {
  records: Map<string, unknown>;
}

interface IdbDb {
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(name: string, opts: { keyPath: string }): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): IdbTransaction;
  close(): void;
}

interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  oncomplete: (() => void) | null;
  onerror: ((this: IdbTransaction) => void) | null;
  error: Error | null;
}

interface IdbObjectStore {
  get(key: string): IdbRequest<unknown>;
  put(value: { id: string; [k: string]: unknown }): IdbRequest<string>;
}

interface IdbRequest<T> {
  result: T | undefined;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function makeShim() {
  const stores = new Map<string, IdbStore>();

  function open(_name: string, _version: number) {
    const req: {
      result: IdbDb;
      error: Error | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onupgradeneeded: (() => void) | null;
    } = {
      result: null as unknown as IdbDb,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };

    queueMicrotask(() => {
      const db: IdbDb = {
        objectStoreNames: {
          contains: (n: string) => stores.has(n),
        },
        createObjectStore(name: string, _opts: { keyPath: string }) {
          stores.set(name, { records: new Map() });
          return null;
        },
        transaction(storeName: string, _mode: "readonly" | "readwrite"): IdbTransaction {
          const store = stores.get(storeName);
          if (!store) throw new Error(`No store ${storeName}`);
          const tx: IdbTransaction = {
            objectStore(_n: string): IdbObjectStore {
              return {
                get(key: string): IdbRequest<unknown> {
                  const r: IdbRequest<unknown> = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  queueMicrotask(() => {
                    r.result = store.records.get(key);
                    r.onsuccess?.();
                    tx.oncomplete?.();
                  });
                  return r;
                },
                put(value: { id: string }): IdbRequest<string> {
                  const r: IdbRequest<string> = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  queueMicrotask(() => {
                    store.records.set(value.id, value);
                    r.result = value.id;
                    r.onsuccess?.();
                    tx.oncomplete?.();
                  });
                  return r;
                },
              };
            },
            oncomplete: null,
            onerror: null,
            error: null,
          };
          return tx;
        },
        close() {},
      };
      req.result = db;
      // The module relies on onupgradeneeded firing once for the initial open.
      if (!stores.has("keys")) {
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    });
    return req;
  }

  return {
    open,
    reset() {
      stores.clear();
    },
    /** Force a failure on the next open() — for the "no key generated yet" path. */
    failNext: false,
    snapshot() {
      return new Map([...stores.entries()].map(([k, v]) => [k, new Map(v.records)]));
    },
  };
}

const { shim } = vi.hoisted(() => ({ shim: { current: null as ReturnType<typeof makeShim> | null } }));

beforeEach(() => {
  // Build a fresh shim per-test, swap into globalThis.indexedDB, then reset
  // the module-level singleton in signingKeyStore.
  shim.current = makeShim();
  vi.stubGlobal("indexedDB", { open: shim.current.open });
  vi.resetModules();
});

describe("signingKeyStore — getOrCreateSigningKey", () => {
  it("generates an Ed25519 keypair on first call and persists it", async () => {
    const { getOrCreateSigningKey } = await import("./signingKeyStore");
    const { privateKey, publicKeyHex } = await getOrCreateSigningKey();
    expect(privateKey).toBeDefined();
    expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    // The record should now exist in our shim.
    const snap = shim.current!.snapshot();
    expect(snap.get("keys")?.has("device-ed25519")).toBe(true);
  });

  it("returns the same key on the second call (no regeneration)", async () => {
    const { getOrCreateSigningKey } = await import("./signingKeyStore");
    const first = await getOrCreateSigningKey();
    const second = await getOrCreateSigningKey();
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
    // The module-level promise cache should have returned the same key handle.
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("emits a 64-char (32-byte) lowercase hex public key", async () => {
    const { getOrCreateSigningKey } = await import("./signingKeyStore");
    const { publicKeyHex } = await getOrCreateSigningKey();
    expect(publicKeyHex).toHaveLength(64);
    expect(publicKeyHex).toMatch(/^[0-9a-f]+$/);
  });

  it("re-uses the stored CryptoKey when the module is reloaded (round-trip)", async () => {
    // First module load: generate + persist a non-extractable CryptoKey.
    const first = await (await import("./signingKeyStore")).getOrCreateSigningKey();
    const expectedPub = first.publicKeyHex;

    // Reload the module — module-level promise cache is dropped, but the
    // IndexedDB shim keeps the row. The v2 path stores a CryptoKey
    // reference directly (no JWK round-trip), so the same pubkey hex
    // surfaces on the second load.
    vi.resetModules();
    const second = await (await import("./signingKeyStore")).getOrCreateSigningKey();
    expect(second.publicKeyHex).toBe(expectedPub);
  });

  it("generates the private key as non-extractable (cannot exportKey())", async () => {
    const { getOrCreateSigningKey } = await import("./signingKeyStore");
    const { privateKey } = await getOrCreateSigningKey();
    expect(privateKey.extractable).toBe(false);
    // The WebCrypto contract: exportKey on a non-extractable CryptoKey
    // throws InvalidAccessError. Whatever the runtime spells the error
    // as, it must NOT resolve.
    await expect(crypto.subtle.exportKey("jwk", privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", privateKey)).rejects.toThrow();
  });

  it("does not persist privateKeyJwk (no JWK material on disk)", async () => {
    const { getOrCreateSigningKey } = await import("./signingKeyStore");
    await getOrCreateSigningKey();
    const snap = shim.current!.snapshot();
    const rec = snap.get("keys")?.get("device-ed25519") as { privateKeyJwk?: unknown; schema?: number } | undefined;
    expect(rec).toBeDefined();
    expect(rec).not.toHaveProperty("privateKeyJwk");
    expect(rec?.schema).toBe(2);
  });
});

describe("signingKeyStore — getPublicKeyHex", () => {
  it("returns null when no key has been generated yet", async () => {
    const { getPublicKeyHex } = await import("./signingKeyStore");
    expect(await getPublicKeyHex()).toBeNull();
  });

  it("returns the persisted pubkey hex once a key exists", async () => {
    const mod = await import("./signingKeyStore");
    const { publicKeyHex } = await mod.getOrCreateSigningKey();
    const got = await mod.getPublicKeyHex();
    expect(got).toBe(publicKeyHex);
  });
});

describe("signingKeyStore — signBytes", () => {
  it("returns a 64-byte signature and verifies against the public key", async () => {
    const { getOrCreateSigningKey, signBytes } = await import("./signingKeyStore");
    const { publicKeyHex } = await getOrCreateSigningKey();

    const data = new TextEncoder().encode("manifest payload");
    const sig = await signBytes(data);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    // Re-import the public key from raw hex to verify.
    const rawPub = new Uint8Array(publicKeyHex.length / 2);
    for (let i = 0; i < rawPub.length; i++) {
      rawPub[i] = parseInt(publicKeyHex.slice(i * 2, i * 2 + 2), 16);
    }
    const pubKey = await crypto.subtle.importKey("raw", rawPub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", pubKey, sig as BufferSource, data as BufferSource);
    expect(ok).toBe(true);
  });

  it("generates a key on first signBytes call if none exists", async () => {
    const { signBytes, getPublicKeyHex } = await import("./signingKeyStore");
    expect(await getPublicKeyHex()).toBeNull();
    const sig = await signBytes(new TextEncoder().encode("anything"));
    expect(sig.length).toBe(64);
    // After signing, a key must have been persisted.
    expect(await getPublicKeyHex()).toMatch(/^[0-9a-f]{64}$/);
  });
});
