/// <reference lib="webworker" />
/**
 * Whisper transcription worker — runs the Whisper model off the main thread.
 *
 * Runs in its own Web Worker; the main thread talks to it via postMessage.
 * Holds a singleton `automatic-speech-recognition` pipeline once loaded.
 *
 * Audio gets here pre-resampled to 16 kHz Float32 mono — see
 * src/lib/audio/localTranscribe.ts which calls downsampleFloat32 before
 * the postMessage. Whisper expects 16 kHz internally; sending native-rate
 * audio works but burns CPU on the model's resampler.
 *
 * Privacy: this worker NEVER touches the network during transcribe — only
 * during the initial load() call when the model is fetched + cached.
 * Once `loaded`, transcribe runs entirely in WASM in this Worker. That's
 * the whole point: cultural-sensitivity flag is irrelevant to this code
 * path because the audio doesn't leave the device.
 */

declare const self: DedicatedWorkerGlobalScope;

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";

// Inbound from main thread
export type WhisperWorkerInbound =
  | { type: "load"; model: string }
  | {
      type: "transcribe";
      requestId: string;
      audio: Float32Array;
      language?: string | null;
      returnTimestamps?: boolean;
    }
  | { type: "unload" };

// Outbound to main thread
export type WhisperWorkerOutbound =
  | { type: "loading_progress"; info: ProgressInfo }
  | { type: "loaded"; model: string }
  | {
      type: "transcribed";
      requestId: string;
      text: string;
      segments: Array<{ start: number; end: number; text: string }>;
    }
  | { type: "error"; requestId?: string; error: string };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedModel: string | null = null;
let loadingPromise: Promise<void> | null = null;

function post(msg: WhisperWorkerOutbound): void {
  self.postMessage(msg);
}

async function load(model: string): Promise<void> {
  if (loadedModel === model && asr) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    asr = (await pipeline("automatic-speech-recognition", model, {
      progress_callback: (info: ProgressInfo) => {
        post({ type: "loading_progress", info });
      },
    })) as AutomaticSpeechRecognitionPipeline;
    loadedModel = model;
    post({ type: "loaded", model });
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

interface WhisperChunk {
  text?: string;
  timestamp?: [number, number] | [number, number | null];
}

interface WhisperRunResult {
  text?: string;
  chunks?: WhisperChunk[];
}

async function transcribe(
  requestId: string,
  audio: Float32Array,
  language: string | null | undefined,
  returnTimestamps: boolean,
): Promise<void> {
  if (!asr) {
    post({ type: "error", requestId, error: "Model not loaded — call load() first." });
    return;
  }
  try {
    // The pipeline accepts Float32Array directly. Language is optional —
    // omitting it lets Whisper auto-detect (slower; English-only models
    // ignore it anyway). returnTimestamps yields per-chunk start/end.
    const result = (await asr(audio, {
      ...(language ? { language } : {}),
      return_timestamps: returnTimestamps,
    } as Record<string, unknown>)) as WhisperRunResult | WhisperRunResult[];

    const first = Array.isArray(result) ? result[0] : result;
    const text = typeof first.text === "string" ? first.text : "";
    const segments = Array.isArray(first.chunks)
      ? first.chunks
          .filter((c): c is WhisperChunk => c != null)
          .map((c) => {
            const ts = c.timestamp ?? [0, 0];
            return {
              start: typeof ts[0] === "number" ? ts[0] : 0,
              end: typeof ts[1] === "number" ? ts[1] : 0,
              text: typeof c.text === "string" ? c.text : "",
            };
          })
      : [];

    post({ type: "transcribed", requestId, text, segments });
  } catch (err) {
    post({ type: "error", requestId, error: err instanceof Error ? err.message : String(err) });
  }
}

self.addEventListener("message", (event: MessageEvent<WhisperWorkerInbound>) => {
  const msg = event.data;
  switch (msg.type) {
    case "load":
      void load(msg.model).catch((err: unknown) => {
        post({ type: "error", error: err instanceof Error ? err.message : String(err) });
      });
      return;
    case "transcribe":
      void transcribe(msg.requestId, msg.audio, msg.language, !!msg.returnTimestamps);
      return;
    case "unload":
      asr = null;
      loadedModel = null;
      return;
    default: {
      const exhaustiveCheck: never = msg;
      void exhaustiveCheck;
    }
  }
});
