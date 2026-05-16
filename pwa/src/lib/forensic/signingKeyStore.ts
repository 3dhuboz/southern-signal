/**
 * Ed25519 signing key — stored in IndexedDB as a JWK, singleton per device.
 *
 * Separate from keyStore.ts (which holds cloud API keys) so there is no
 * coupling between AI provider configuration and forensic signing.
 *
 * The private key is extractable (JWK) so it can survive an IndexedDB
 * round-trip. The public key is exported as raw bytes (32 bytes) and
 * exposed as a 64-char hex string for inclusion in export bundles.
 */

const DB_NAME = "ss-signing";
const STORE = "keys";
const DB_VERSION = 1;

interface SigningKeyRecord {
  id: "device-ed25519"; // singleton
  privateKeyJwk: JsonWebKey;
  publicKeyHex: string; // 32 bytes, 64 hex chars
  createdAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Module-level cache: resolved once, reused for the lifetime of the page. */
let signingKeyPromise: Promise<{ privateKey: CryptoKey; publicKeyHex: string }> | null = null;

/**
 * Generate an Ed25519 CryptoKeyPair via WebCrypto and store private key as JWK.
 * Returns existing key if already generated (singleton per device).
 * Subsequent calls return the same Promise (no extra IndexedDB round-trips).
 */
export function getOrCreateSigningKey(): Promise<{
  privateKey: CryptoKey;
  publicKeyHex: string;
}> {
  if (!signingKeyPromise) signingKeyPromise = loadOrCreateKey();
  return signingKeyPromise;
}

async function loadOrCreateKey(): Promise<{
  privateKey: CryptoKey;
  publicKeyHex: string;
}> {
  // Try to load existing record first.
  let rec: SigningKeyRecord | undefined;
  try {
    rec = await withStore<SigningKeyRecord | undefined>(
      "readonly",
      (s) => s.get("device-ed25519") as IDBRequest<SigningKeyRecord | undefined>,
    );
  } catch {
    rec = undefined;
  }

  if (rec) {
    // Re-import the private key from JWK.
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      rec.privateKeyJwk,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return { privateKey, publicKeyHex: rec.publicKeyHex };
  }

  // Generate a new keypair.
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true, // extractable — needed for JWK export/import
    ["sign", "verify"],
  );

  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyHex = Array.from(new Uint8Array(publicRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const newRec: SigningKeyRecord = {
    id: "device-ed25519",
    privateKeyJwk,
    publicKeyHex,
    createdAt: new Date().toISOString(),
  };

  await withStore<IDBValidKey>("readwrite", (s) => s.put(newRec));

  return { privateKey: keyPair.privateKey, publicKeyHex };
}

/**
 * Export public key as 32-byte hex string (64 chars).
 * Returns null if no key has been generated yet.
 */
export async function getPublicKeyHex(): Promise<string | null> {
  try {
    const rec = await withStore<SigningKeyRecord | undefined>(
      "readonly",
      (s) => s.get("device-ed25519") as IDBRequest<SigningKeyRecord | undefined>,
    );
    return rec?.publicKeyHex ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign a Uint8Array with the stored Ed25519 private key.
 * Returns 64-byte signature as Uint8Array.
 * Calls getOrCreateSigningKey() — generates a key on first use.
 */
export async function signBytes(data: Uint8Array): Promise<Uint8Array> {
  const { privateKey } = await getOrCreateSigningKey();
  // TypeScript 5.7+ tightened Uint8Array generic — it can be backed by either
  // ArrayBuffer or SharedArrayBuffer, but SubtleCrypto.sign rejects the latter.
  // The cast narrows the type; the runtime value is always ArrayBuffer-backed
  // because the caller paths construct it locally (not from shared memory).
  const sigBuf = await crypto.subtle.sign("Ed25519", privateKey, data as BufferSource);
  return new Uint8Array(sigBuf);
}
