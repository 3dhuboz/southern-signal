/**
 * API key storage in IndexedDB. Origin-bound. Never synced.
 *
 * V1 stores keys plaintext-at-rest (matches the existing OPFS-stored
 * audio model). V1.1 will wrap with WebCrypto AES-GCM keyed off a user
 * passphrase — same path as the planned forensic encryption layer.
 *
 * Convention: one key per provider per device. Replacing a key invalidates
 * the prior one immediately.
 */

const DB_NAME = "ss-keys";
const STORE = "keys";
const DB_VERSION = 1;

type Provider = "anthropic" | "openai" | "gemini" | "openrouter";

interface KeyRecord {
  provider: Provider;
  apiKey: string;
  createdAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "provider" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function setApiKey(provider: Provider, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");
  await withStore<IDBValidKey>("readwrite", (s) => s.put({ provider, apiKey: trimmed, createdAt: new Date().toISOString() } as KeyRecord));
}

export async function getApiKey(provider: Provider): Promise<string | null> {
  try {
    const rec = await withStore<KeyRecord | undefined>("readonly", (s) => s.get(provider) as IDBRequest<KeyRecord | undefined>);
    return rec?.apiKey ?? null;
  } catch {
    return null;
  }
}

export async function listProvidersWithKeys(): Promise<Provider[]> {
  try {
    const all = await withStore<KeyRecord[]>("readonly", (s) => s.getAll() as IDBRequest<KeyRecord[]>);
    return all.map((r) => r.provider);
  } catch {
    return [];
  }
}

export async function deleteApiKey(provider: Provider): Promise<void> {
  await withStore<undefined>("readwrite", (s) => s.delete(provider) as IDBRequest<undefined>);
}

export async function clearAllKeys(): Promise<void> {
  await withStore<undefined>("readwrite", (s) => s.clear() as IDBRequest<undefined>);
}
