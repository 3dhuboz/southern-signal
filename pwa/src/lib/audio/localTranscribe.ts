/**
 * On-device transcription via Whisper running in a Web Worker.
 *
 * Privacy-first counterpart to cloud transcription (cloudTranscribe.ts).
 * Once the model is loaded, transcription runs entirely in-browser — no
 * audio leaves the device. The cultural-sensitivity flag is irrelevant
 * to this path because there's nothing to gate.
 *
 * Lifecycle:
 *   1. Operator opts in via Setup → "Enable on-device transcription"
 *   2. UI calls loadLocalWhisperModel() → downloads + caches the model
 *      (Whisper-tiny.en, ~40 MB, fetched from HuggingFace via transformers.js)
 *   3. Once `state === "ready"`, EvpEditor surfaces a "Transcribe on-device"
 *      button alongside the existing cloud path
 *   4. transcribeOnDevice(float32, sampleRate) → downsamples to 16 kHz and
 *      pushes to the worker; resolves with { text, segments }
 *   5. unloadLocalWhisperModel() — terminates the worker, frees memory
 *
 * The worker is created lazily on first load() call. Subsequent loads of
 * the same model are no-ops; loads of a different model swap.
 *
 * Default model: `Xenova/whisper-tiny.en` — English-only, ~40 MB
 * quantized, the fastest practical Whisper for phones. Operators who
 * want multilingual can override via loadLocalWhisperModel("Xenova/whisper-tiny").
 */

import { useEffect, useState } from "react";
import { downsampleFloat32 } from "../wav";
import type { ProgressInfo } from "@huggingface/transformers";
import type {
  WhisperWorkerInbound,
  WhisperWorkerOutbound,
} from "../../workers/whisperTranscribe.worker";

// Was "Xenova/whisper-tiny.en" — that repo's quantized decoder fails to load
// on current onnxruntime-web with a QDQ "Missing required scale" error.
// `onnx-community/whisper-tiny.en` is the maintained successor with
// quantization configs that load cleanly under the dtype config in the worker.
export const DEFAULT_LOCAL_MODEL = "onnx-community/whisper-tiny.en";
export const WHISPER_SAMPLE_RATE = 16_000;

export type LocalTranscribeState = "unloaded" | "loading" | "ready" | "error";

export interface LocalTranscribeProgress {
  /** What stage the loader is in: pulling files, initialising, etc. */
  stage: string;
  /** Per-file path being fetched. */
  file: string | null;
  /** Bytes loaded for the current file (0 when unknown). */
  loaded: number;
  /** Total bytes for the current file (0 when unknown). */
  total: number;
}

export interface LocalTranscriptionResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  /** "local-whisper-<model>" — distinguishes from cloud transcripts in the DB. */
  engine: string;
}

interface ModuleState {
  worker: Worker | null;
  state: LocalTranscribeState;
  loadedModel: string | null;
  loadProgress: LocalTranscribeProgress | null;
  error: string | null;
  loadResolvers: { resolve: () => void; reject: (e: Error) => void } | null;
  pendingTranscriptions: Map<
    string,
    { resolve: (r: LocalTranscriptionResult) => void; reject: (e: Error) => void }
  >;
}

const internal: ModuleState = {
  worker: null,
  state: "unloaded",
  loadedModel: null,
  loadProgress: null,
  error: null,
  loadResolvers: null,
  pendingTranscriptions: new Map(),
};

const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function setState(state: LocalTranscribeState, error: string | null = null): void {
  internal.state = state;
  internal.error = error;
  notify();
}

function setProgress(progress: LocalTranscribeProgress | null): void {
  internal.loadProgress = progress;
  notify();
}

function ensureWorker(): Worker {
  if (internal.worker) return internal.worker;
  // Vite resolves `new URL(..., import.meta.url)` to a worker chunk it
  // bundles separately; the `type: "module"` keeps modern import syntax
  // available inside the worker.
  const worker = new Worker(
    new URL("../../workers/whisperTranscribe.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.addEventListener("message", (event: MessageEvent<WhisperWorkerOutbound>) => {
    const msg = event.data;
    switch (msg.type) {
      case "loading_progress":
        setProgress(progressFromInfo(msg.info));
        return;
      case "loaded":
        internal.loadedModel = msg.model;
        setProgress(null);
        setState("ready");
        if (internal.loadResolvers) {
          internal.loadResolvers.resolve();
          internal.loadResolvers = null;
        }
        return;
      case "transcribed": {
        const pending = internal.pendingTranscriptions.get(msg.requestId);
        internal.pendingTranscriptions.delete(msg.requestId);
        if (pending) {
          pending.resolve({
            text: msg.text,
            segments: msg.segments,
            engine: `local-whisper-${internal.loadedModel ?? "unknown"}`,
          });
        }
        return;
      }
      case "error": {
        if (msg.requestId) {
          const pending = internal.pendingTranscriptions.get(msg.requestId);
          internal.pendingTranscriptions.delete(msg.requestId);
          if (pending) pending.reject(new Error(msg.error));
        } else {
          // Load-time / global error
          setState("error", msg.error);
          if (internal.loadResolvers) {
            internal.loadResolvers.reject(new Error(msg.error));
            internal.loadResolvers = null;
          }
        }
        return;
      }
    }
  });
  worker.addEventListener("error", (event) => {
    const errMsg = event.message || "Worker error";
    setState("error", errMsg);
    if (internal.loadResolvers) {
      internal.loadResolvers.reject(new Error(errMsg));
      internal.loadResolvers = null;
    }
    for (const pending of internal.pendingTranscriptions.values()) {
      pending.reject(new Error(errMsg));
    }
    internal.pendingTranscriptions.clear();
  });
  internal.worker = worker;
  return worker;
}

function postToWorker(msg: WhisperWorkerInbound, transfer: Transferable[] = []): void {
  const worker = ensureWorker();
  if (transfer.length > 0) worker.postMessage(msg, transfer);
  else worker.postMessage(msg);
}

function progressFromInfo(info: ProgressInfo): LocalTranscribeProgress {
  // ProgressInfo is a discriminated union — defensive defaults handle every variant.
  const i = info as Record<string, unknown>;
  return {
    stage: typeof i.status === "string" ? i.status : "loading",
    file: typeof i.file === "string" ? i.file : null,
    loaded: typeof i.loaded === "number" ? i.loaded : 0,
    total: typeof i.total === "number" ? i.total : 0,
  };
}

/**
 * Begin loading the named Whisper model. First call kicks off the
 * download + cache; subsequent calls with the same model name resolve
 * immediately. Switching models unloads then reloads.
 */
export async function loadLocalWhisperModel(model: string = DEFAULT_LOCAL_MODEL): Promise<void> {
  if (internal.state === "ready" && internal.loadedModel === model) return;
  if (internal.state === "loading" && internal.loadResolvers) {
    return new Promise<void>((resolve, reject) => {
      const prev = internal.loadResolvers!;
      internal.loadResolvers = {
        resolve: () => { prev.resolve(); resolve(); },
        reject: (e) => { prev.reject(e); reject(e); },
      };
    });
  }
  setState("loading");
  setProgress({ stage: "starting", file: null, loaded: 0, total: 0 });
  return new Promise<void>((resolve, reject) => {
    internal.loadResolvers = { resolve, reject };
    postToWorker({ type: "load", model });
  });
}

/**
 * Transcribe a Float32 PCM buffer at the given sample rate. Resamples to
 * 16 kHz internally (Whisper's expected rate). Throws if the model isn't
 * loaded yet — callers should check `getLocalTranscribeState()` first.
 */
export async function transcribeOnDevice(
  audio: Float32Array,
  sampleRate: number,
  opts: { language?: string; returnTimestamps?: boolean } = {},
): Promise<LocalTranscriptionResult> {
  if (internal.state !== "ready") {
    throw new Error(`On-device transcription not ready (state: ${internal.state}).`);
  }
  // Resample to 16 kHz if needed — uses the existing downsample utility.
  const resampled =
    sampleRate === WHISPER_SAMPLE_RATE
      ? audio
      : sampleRate > WHISPER_SAMPLE_RATE
        ? downsampleFloat32(audio, sampleRate, WHISPER_SAMPLE_RATE)
        : audio; // upsampling is a no-op here; Whisper handles slight underrate

  const requestId = crypto.randomUUID();
  return new Promise<LocalTranscriptionResult>((resolve, reject) => {
    internal.pendingTranscriptions.set(requestId, { resolve, reject });
    // Transfer the buffer so the main thread doesn't pay the copy cost.
    // After this, `resampled` is unusable on the main thread.
    postToWorker(
      {
        type: "transcribe",
        requestId,
        audio: resampled,
        language: opts.language ?? null,
        returnTimestamps: opts.returnTimestamps ?? true,
      },
      [resampled.buffer],
    );
  });
}

/**
 * Tear down the worker. Frees memory; the model will need to be
 * re-fetched (from cache, fast) on the next load() call.
 */
export function unloadLocalWhisperModel(): void {
  if (internal.worker) {
    try { internal.worker.postMessage({ type: "unload" } satisfies WhisperWorkerInbound); } catch { /* swallow */ }
    try { internal.worker.terminate(); } catch { /* swallow */ }
    internal.worker = null;
  }
  internal.loadedModel = null;
  for (const pending of internal.pendingTranscriptions.values()) {
    pending.reject(new Error("Worker unloaded"));
  }
  internal.pendingTranscriptions.clear();
  if (internal.loadResolvers) {
    internal.loadResolvers.reject(new Error("Worker unloaded"));
    internal.loadResolvers = null;
  }
  setProgress(null);
  setState("unloaded");
}

export interface LocalTranscribeStatus {
  state: LocalTranscribeState;
  loadedModel: string | null;
  progress: LocalTranscribeProgress | null;
  error: string | null;
}

export function getLocalTranscribeStatus(): LocalTranscribeStatus {
  return {
    state: internal.state,
    loadedModel: internal.loadedModel,
    progress: internal.loadProgress,
    error: internal.error,
  };
}

/** React hook — re-renders on state / progress / error changes. */
export function useLocalTranscribeStatus(): LocalTranscribeStatus {
  const [snap, setSnap] = useState<LocalTranscribeStatus>(getLocalTranscribeStatus);
  useEffect(() => {
    const update = () => setSnap(getLocalTranscribeStatus());
    subscribers.add(update);
    update();
    return () => { subscribers.delete(update); };
  }, []);
  return snap;
}

/** True when the worker has a model ready to transcribe. */
export function isLocalTranscribeReady(): boolean {
  return internal.state === "ready";
}

/** Test/diagnostic helper — wipes module-level state. Production code never calls this. */
export function _resetLocalTranscribeForTests(): void {
  if (internal.worker) {
    try { internal.worker.terminate(); } catch { /* swallow */ }
  }
  internal.worker = null;
  internal.state = "unloaded";
  internal.loadedModel = null;
  internal.loadProgress = null;
  internal.error = null;
  internal.loadResolvers = null;
  internal.pendingTranscriptions.clear();
  notify();
}
