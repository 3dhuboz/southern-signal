import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_MODEL,
  WHISPER_SAMPLE_RATE,
  _resetLocalTranscribeForTests,
  getLocalTranscribeStatus,
  isLocalTranscribeReady,
  loadLocalWhisperModel,
  transcribeOnDevice,
  unloadLocalWhisperModel,
} from "./localTranscribe";

// Track the instances the module creates so tests can drive the message bus.
const workerInstances: FakeWorker[] = [];

class FakeWorker {
  private listeners = new Map<string, Set<(event: Event) => void>>();
  postedMessages: Array<{ msg: unknown; transfer: Transferable[] | undefined }> = [];
  terminated = false;

  constructor(_url: URL | string, _opts?: WorkerOptions) {
    workerInstances.push(this);
  }

  postMessage(msg: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : (transferOrOptions as StructuredSerializeOptions | undefined)?.transfer as Transferable[] | undefined;
    this.postedMessages.push({ msg, transfer });
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  fireMessage(data: unknown): void {
    const event = new MessageEvent("message", { data });
    this.listeners.get("message")?.forEach((l) => l(event));
  }

  fireError(message: string): void {
    // Use a plain Event with `message` patched on for jsdom — ErrorEvent
    // exists but its constructor signature varies between runtimes.
    const event = Object.assign(new Event("error"), { message }) as Event;
    this.listeners.get("error")?.forEach((l) => l(event));
  }
}

beforeEach(() => {
  workerInstances.length = 0;
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  _resetLocalTranscribeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetLocalTranscribeForTests();
});

function lastWorker(): FakeWorker {
  const w = workerInstances[workerInstances.length - 1];
  if (!w) throw new Error("No Worker instance created");
  return w;
}

describe("loadLocalWhisperModel", () => {
  it("posts a load message with the requested model and resolves on 'loaded'", async () => {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    expect(getLocalTranscribeStatus().state).toBe("loading");
    const w = lastWorker();
    expect(w.postedMessages[0].msg).toEqual({ type: "load", model: DEFAULT_LOCAL_MODEL });
    w.fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await promise;
    expect(getLocalTranscribeStatus().state).toBe("ready");
    expect(getLocalTranscribeStatus().loadedModel).toBe(DEFAULT_LOCAL_MODEL);
    expect(isLocalTranscribeReady()).toBe(true);
  });

  it("rejects with the error message when the worker reports an error during load", async () => {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({ type: "error", error: "out of memory" });
    await expect(promise).rejects.toThrow(/out of memory/);
    expect(getLocalTranscribeStatus().state).toBe("error");
    expect(getLocalTranscribeStatus().error).toContain("out of memory");
  });

  it("dedupes concurrent load() calls — only one worker created, both promises resolve", async () => {
    const a = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    const b = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    expect(workerInstances.length).toBe(1);
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await Promise.all([a, b]);
    expect(getLocalTranscribeStatus().state).toBe("ready");
  });

  it("forwards loading_progress events to status", async () => {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({
      type: "loading_progress",
      info: { status: "download", file: "model.onnx", loaded: 5_000_000, total: 40_000_000 },
    });
    expect(getLocalTranscribeStatus().progress).toEqual({
      stage: "download",
      file: "model.onnx",
      loaded: 5_000_000,
      total: 40_000_000,
    });
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await promise;
    // Progress clears when the loaded event lands.
    expect(getLocalTranscribeStatus().progress).toBeNull();
  });

  it("resolves immediately when the same model is already loaded", async () => {
    const first = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await first;
    const before = workerInstances.length;
    await loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    expect(workerInstances.length).toBe(before); // no new worker
  });
});

describe("transcribeOnDevice", () => {
  async function loadReady(): Promise<FakeWorker> {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await promise;
    return lastWorker();
  }

  it("throws when the model isn't loaded yet", async () => {
    const audio = new Float32Array(16_000);
    await expect(transcribeOnDevice(audio, WHISPER_SAMPLE_RATE)).rejects.toThrow(/not ready/);
  });

  it("posts the audio at 16 kHz when input is already 16 kHz", async () => {
    const w = await loadReady();
    const audio = new Float32Array(16_000);
    audio[0] = 0.5;
    const promise = transcribeOnDevice(audio, WHISPER_SAMPLE_RATE);
    const transcribeMsg = w.postedMessages.find((m): m is { msg: { type: "transcribe"; audio: Float32Array; requestId: string }; transfer: Transferable[] | undefined } =>
      typeof m.msg === "object" && m.msg !== null && (m.msg as { type?: string }).type === "transcribe",
    );
    expect(transcribeMsg).toBeDefined();
    expect(transcribeMsg!.msg.audio.length).toBe(16_000);
    expect(transcribeMsg!.msg.audio[0]).toBeCloseTo(0.5, 6);
    // Transferred buffer
    expect(transcribeMsg!.transfer).toBeDefined();
    w.fireMessage({
      type: "transcribed",
      requestId: transcribeMsg!.msg.requestId,
      text: "hello",
      segments: [],
    });
    const result = await promise;
    expect(result.text).toBe("hello");
    expect(result.engine).toContain("local-whisper-");
  });

  it("downsamples 48 kHz input to 16 kHz before posting", async () => {
    const w = await loadReady();
    const audio = new Float32Array(48_000); // 1 second of 48 kHz
    const promise = transcribeOnDevice(audio, 48_000);
    const transcribeMsg = w.postedMessages.find((m) =>
      typeof m.msg === "object" && m.msg !== null && (m.msg as { type?: string }).type === "transcribe",
    );
    expect(transcribeMsg).toBeDefined();
    const posted = (transcribeMsg!.msg as { audio: Float32Array }).audio;
    expect(posted.length).toBe(16_000); // 3:1 decimation
    w.fireMessage({
      type: "transcribed",
      requestId: (transcribeMsg!.msg as { requestId: string }).requestId,
      text: "x",
      segments: [],
    });
    await promise;
  });

  it("rejects the in-flight promise if the worker emits an error", async () => {
    const w = await loadReady();
    const promise = transcribeOnDevice(new Float32Array(16_000), WHISPER_SAMPLE_RATE);
    const transcribeMsg = w.postedMessages.find((m) =>
      typeof m.msg === "object" && m.msg !== null && (m.msg as { type?: string }).type === "transcribe",
    );
    w.fireMessage({
      type: "error",
      requestId: (transcribeMsg!.msg as { requestId: string }).requestId,
      error: "model crashed",
    });
    await expect(promise).rejects.toThrow(/model crashed/);
  });

  it("dispatches concurrent transcribe requests by requestId", async () => {
    const w = await loadReady();
    const a = transcribeOnDevice(new Float32Array(16_000), WHISPER_SAMPLE_RATE);
    const b = transcribeOnDevice(new Float32Array(16_000), WHISPER_SAMPLE_RATE);
    const transcribeMsgs = w.postedMessages.filter((m) =>
      typeof m.msg === "object" && m.msg !== null && (m.msg as { type?: string }).type === "transcribe",
    );
    expect(transcribeMsgs).toHaveLength(2);
    const idA = (transcribeMsgs[0].msg as { requestId: string }).requestId;
    const idB = (transcribeMsgs[1].msg as { requestId: string }).requestId;
    // Resolve out of order.
    w.fireMessage({ type: "transcribed", requestId: idB, text: "second", segments: [] });
    w.fireMessage({ type: "transcribed", requestId: idA, text: "first", segments: [] });
    expect((await a).text).toBe("first");
    expect((await b).text).toBe("second");
  });

  it("returns the segments array when the worker provides one", async () => {
    const w = await loadReady();
    const promise = transcribeOnDevice(new Float32Array(16_000), WHISPER_SAMPLE_RATE);
    const msg = w.postedMessages.find((m) =>
      typeof m.msg === "object" && m.msg !== null && (m.msg as { type?: string }).type === "transcribe",
    )!.msg as { requestId: string };
    w.fireMessage({
      type: "transcribed",
      requestId: msg.requestId,
      text: "hello there",
      segments: [
        { start: 0, end: 0.6, text: "hello" },
        { start: 0.6, end: 1.2, text: "there" },
      ],
    });
    const result = await promise;
    expect(result.segments).toHaveLength(2);
    expect(result.segments[1].text).toBe("there");
  });
});

describe("unloadLocalWhisperModel", () => {
  it("terminates the worker and resets state to 'unloaded'", async () => {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await promise;
    const w = lastWorker();
    unloadLocalWhisperModel();
    expect(w.terminated).toBe(true);
    expect(getLocalTranscribeStatus().state).toBe("unloaded");
    expect(isLocalTranscribeReady()).toBe(false);
  });

  it("rejects any in-flight transcribe promises", async () => {
    const promise = loadLocalWhisperModel(DEFAULT_LOCAL_MODEL);
    lastWorker().fireMessage({ type: "loaded", model: DEFAULT_LOCAL_MODEL });
    await promise;
    const transcribePromise = transcribeOnDevice(new Float32Array(16_000), WHISPER_SAMPLE_RATE);
    unloadLocalWhisperModel();
    await expect(transcribePromise).rejects.toThrow(/Worker unloaded/);
  });
});

describe("getLocalTranscribeStatus", () => {
  it("starts as unloaded with no progress or error", () => {
    expect(getLocalTranscribeStatus()).toEqual({
      state: "unloaded",
      loadedModel: null,
      progress: null,
      error: null,
    });
  });
});
