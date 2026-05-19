/**
 * Ed25519 signing key — stored in IndexedDB, singleton per device.
 *
 * Separate from keyStore.ts (which holds cloud API keys) so there is no
 * coupling between AI provider configuration and forensic signing.
 *
 * Security posture: the private key is generated NON-extractable. WebCrypto
 * still allows structured-clone of a non-extractable CryptoKey across the
 * IndexedDB boundary (the bytes never leave the agent), which is the
 * mechanism we use to survive a page reload. There is no JWK export of the
 * private key — so an XSS payload running on the page cannot exfiltrate
 * it via `crypto.subtle.exportKey()`.
 *
 * Migration: legacy records carry `privateKeyJwk` and an extractable key.
 * Those records are rotated on first load — a fresh non-extractable
 * keypair is generated and persisted, the legacy row replaced. Older
 * bundles still verify against their own embedded pubkey because
 * verifiers always read the pubkey from the bundle's signing.json, not
 * from the device. The trade-off is operators see a new
 * ed25519_pubkey_hex on the next bundle; that's acceptable for V1 where
 * cross-device sync isn't a requirement.
 *
 * The public key is exported as raw bytes (32 bytes) and exposed as a
 * 64-char hex string for inclusion in export bundles.
 */

const DB_NAME = "ss-signing";
const STORE = "keys";
const DB_VERSION = 1;

interface LegacySigningKeyRecord {
  id: "device-ed25519"; // singleton
  privateKeyJwk: JsonWebKey;
  publicKeyHex: string; // 32 bytes, 64 hex chars
  createdAt: string;
}

interface SigningKeyRecord {
  id: "device-ed25519"; // singleton
  /** Non-extractable CryptoKey, round-tripped via structured-clone in IDB. */
  privateKey: CryptoKey;
  publicKeyHex: string; // 32 bytes, 64 hex chars
  createdAt: string;
  /** Marker so we can tell migrated v2 rows from legacy v1 rows. */
  schema: 2;
}

type AnySigningKeyRecord = SigningKeyRecord | LegacySigningKeyRecord;

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
 * Generate an Ed25519 CryptoKeyPair via WebCrypto and store the private
 * key as a non-extractable CryptoKey in IndexedDB. Returns the existing
 * key if already generated (singleton per device). Subsequent calls
 * return the same Promise (no extra IndexedDB round-trips).
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
  let rec: AnySigningKeyRecord | undefined;
  try {
    rec = await withStore<AnySigningKeyRecord | undefined>(
      "readonly",
      (s) => s.get("device-ed25519") as IDBRequest<AnySigningKeyRecord | undefined>,
    );
  } catch {
    rec = undefined;
  }

  if (rec) {
    if (isV2Record(rec)) {
      return { privateKey: rec.privateKey, publicKeyHex: rec.publicKeyHex };
    }
    // Legacy v1 (extractable JWK) — rotate to v2.
    return await mintFreshKey();
  }

  return await mintFreshKey();
}

function isV2Record(rec: AnySigningKeyRecord): rec is SigningKeyRecord {
  return (rec as { schema?: number }).schema === 2;
}

async function mintFreshKey(): Promise<{ privateKey: CryptoKey; publicKeyHex: string }> {
  // Non-extractable Ed25519 keypair. The private key is bound to this
  // origin's IndexedDB and cannot be exfiltrated via the WebCrypto API.
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    /* extractable */ false,
    ["sign", "verify"],
  );
  const publicRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyHex = Array.from(new Uint8Array(publicRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const newRec: SigningKeyRecord = {
    id: "device-ed25519",
    privateKey: keyPair.privateKey,
    publicKeyHex,
    createdAt: new Date().toISOString(),
    schema: 2,
  };

  // IndexedDB structured-clone preserves CryptoKey objects across page
  // reloads without ever materialising the bytes in JS.
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
