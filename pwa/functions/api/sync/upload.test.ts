import { beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { onRequestPost } from "./upload";
import type { AuthKVNamespace } from "../ai/_auth";

if (typeof (globalThis as { crypto?: Crypto }).crypto === "undefined") {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const ORIGIN = "https://southern-signal.pages.dev";
const PATH = "/api/sync/upload";
const URL = `${ORIGIN}${PATH}`;
const BOUNDARY = "----SSTestBoundary";

class MemKV implements AuthKVNamespace {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
}

class MemStatement {
  constructor(private readonly query: string) {}
  bind(..._values: unknown[]): MemStatement { return this; }
  async run(): Promise<{ success: boolean }> { return { success: true }; }
  async all(): Promise<{ results: unknown[] }> { return { results: [] }; }
}

class MemD1 {
  statements: string[] = [];
  prepare(query: string): MemStatement {
    this.statements.push(query);
    return new MemStatement(query);
  }
  async batch(_statements: MemStatement[]): Promise<unknown> { return null; }
  async exec(query: string): Promise<unknown> {
    this.statements.push(query);
    return null;
  }
}

class MemR2 {
  puts: { key: string; bytes: number; contentType?: string }[] = [];
  async put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value).byteLength
      : value instanceof ArrayBuffer
        ? value.byteLength
        : 0;
    this.puts.push({ key, bytes, contentType: options?.httpMetadata?.contentType });
    return null;
  }
  async head(): Promise<unknown | null> { return null; }
}

type Context = Parameters<typeof onRequestPost>[0];

function ctx(env: Record<string, unknown>, request: Request): Context {
  return {
    request,
    env,
    params: {},
    data: {},
    next: async () => new Response(null),
    waitUntil: () => undefined,
  } as Context;
}

function multipartBody(items: unknown[], files: { name: string; filename: string; contentType: string; body: string }[] = []): Uint8Array {
  const chunks = [
    `--${BOUNDARY}\r\n`,
    'Content-Disposition: form-data; name="items"\r\n\r\n',
    JSON.stringify(items),
    "\r\n",
  ];
  for (const file of files) {
    chunks.push(
      `--${BOUNDARY}\r\n`,
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`,
      `Content-Type: ${file.contentType}\r\n\r\n`,
      file.body,
      "\r\n",
    );
  }
  chunks.push(`--${BOUNDARY}--\r\n`);
  return new TextEncoder().encode(chunks.join(""));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signingHeaders(body: Uint8Array): Promise<Record<string, string>> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pubHex = Array.from(new Uint8Array(pubRaw)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const timestamp = Date.now();
  const canonical = `${pubHex}\nPOST\n${PATH}\n${timestamp}\n${await sha256Hex(body)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(canonical)));
  let bin = "";
  for (let i = 0; i < sig.length; i += 1) bin += String.fromCharCode(sig[i]);
  return {
    "X-SS-Pubkey": pubHex,
    "X-SS-Timestamp": String(timestamp),
    "X-SS-Signature": btoa(bin),
  };
}

function baseEnv(extra: Record<string, unknown> = {}) {
  return {
    SYNC_TOKEN: "sync-secret",
    SYNC_DB: new MemD1(),
    MEDIA_BUCKET: new MemR2(),
    AI_RATE_LIMIT: new MemKV(),
    AI_RATE_LIMIT_SALT: "sync-test-salt",
    ...extra,
  };
}

function uploadRequest(body: Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Authorization: "Bearer sync-secret",
      "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...headers,
    },
    body: body as BodyInit,
  });
}

describe("POST /api/sync/upload auth", () => {
  const items = [{
    kind: "investigation",
    ref_id: "inv-1",
    payload: {
      id: "inv-1",
      title: "The Boys test hunt",
      created_at: "2026-05-23T00:00:00.000Z",
    },
  }];

  let body: Uint8Array;
  beforeEach(() => { body = multipartBody(items); });

  it("refuses a valid bearer token without the device Ed25519 signature", async () => {
    const response = await onRequestPost(ctx(baseEnv(), uploadRequest(body)));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Signed sync request required",
    });
  });

  it("accepts a valid bearer token plus a valid device signature", async () => {
    const response = await onRequestPost(ctx(baseEnv(), uploadRequest(body, await signingHeaders(body))));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: ["inv-1"],
      rejected: [],
    });
  });

  it("fails closed if the signing KV binding is missing", async () => {
    const response = await onRequestPost(ctx(baseEnv({ AI_RATE_LIMIT: undefined }), uploadRequest(body, await signingHeaders(body))));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Sync signing rate-limit binding missing",
    });
  });

  it("derives media R2 keys on the server instead of trusting the client payload", async () => {
    const bucket = new MemR2();
    const mediaItems = [{
      kind: "media_blob",
      ref_id: "clip-1",
      r2_key: "attacker/chosen/key",
      byte_length: 4,
      payload: {
        investigation_id: "inv/../secret",
        media_type: "video",
      },
    }];
    const mediaBody = multipartBody(mediaItems, [{
      name: "file:clip-1",
      filename: "clip.webm",
      contentType: "video/webm",
      body: "test",
    }]);

    const response = await onRequestPost(ctx(baseEnv({ MEDIA_BUCKET: bucket }), uploadRequest(mediaBody, await signingHeaders(mediaBody))));

    expect(response.status).toBe(200);
    expect(bucket.puts).toMatchObject([
      { key: "media/inv_secret/clip-1", bytes: 4, contentType: "video/webm" },
    ]);
    await expect(response.json()).resolves.toEqual({
      accepted: ["clip-1"],
      rejected: [],
    });
  });
});
