export interface BodyReadFailure {
  ok: false;
  status: 400 | 413;
  error: string;
}

export interface BodyBytesSuccess {
  ok: true;
  bytes: Uint8Array;
}

export interface BodyJsonSuccess<T> extends BodyBytesSuccess {
  value: T;
}

export interface BodyFormDataSuccess extends BodyBytesSuccess {
  formData: FormData;
}

export type BodyBytesResult = BodyBytesSuccess | BodyReadFailure;
export type BodyJsonResult<T> = BodyJsonSuccess<T> | BodyReadFailure;
export type BodyFormDataResult = BodyFormDataSuccess | BodyReadFailure;

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<BodyBytesResult> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const contentLength = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, status: 413, error: "Request body too large." };
    }
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body-size-limit-exceeded").catch(() => { /* ignore */ });
        return { ok: false, status: 413, error: "Request body too large." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "Invalid request body." };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readLimitedJson<T>(request: Request, maxBytes: number): Promise<BodyJsonResult<T>> {
  const body = await readLimitedBytes(request, maxBytes);
  if (!body.ok) return body;

  try {
    const raw = new TextDecoder().decode(body.bytes);
    return { ok: true, bytes: body.bytes, value: raw ? (JSON.parse(raw) as T) : ({} as T) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body." };
  }
}

export async function readLimitedFormData(request: Request, maxBytes: number): Promise<BodyFormDataResult> {
  const body = await readLimitedBytes(request, maxBytes);
  if (!body.ok) return body;

  try {
    const replay = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body.bytes as BodyInit,
    });
    return { ok: true, bytes: body.bytes, formData: await replay.formData() };
  } catch {
    return { ok: false, status: 400, error: "Invalid multipart body." };
  }
}
