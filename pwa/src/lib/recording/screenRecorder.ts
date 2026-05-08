/**
 * Screen recorder — getDisplayMedia + MediaRecorder.
 *
 * Platform reality:
 *   - Android Chrome 94+: works, can include system audio.
 *   - iOS Safari (incl. installed PWA): getDisplayMedia is missing or
 *     unreliable. We detect and surface a tip directing the user to the
 *     native iOS Control Center screen recorder. We still hash-chain
 *     start/stop into the audit log so the native recording can be
 *     aligned with the session timeline by timestamp.
 *
 * Output format: WebM/VP9 + Opus on Android (best codec support); falls
 * back to whatever MediaRecorder.isTypeSupported allows.
 */

export type RecorderStatus = "idle" | "starting" | "recording" | "saving" | "error";

export interface RecorderState {
  status: RecorderStatus;
  startedAt: number | null;
  durationSeconds: number;
  error: string | null;
  /** True only on iOS PWAs where in-app recording is unsupported. */
  inAppRecordingUnavailable: boolean;
}

export type RecorderListener = (state: RecorderState) => void;

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
}

const MIME_PREFERENCES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function isInAppRecordingSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!("mediaDevices" in navigator) || !navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getDisplayMedia !== "function") return false;
  if (typeof MediaRecorder === "undefined") return false;
  // iOS WebKit fakes getDisplayMedia in some versions but it throws "Not allowed".
  // We do a UA-based pre-flight — not perfect but the right default behaviour.
  if (isIOS()) return false;
  return true;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ presents as Mac with touch — sniff for it.
  if (ua.includes("Mac") && "ontouchend" in document) return true;
  return false;
}

function pickMimeType(): string {
  for (const candidate of MIME_PREFERENCES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch { /* swallow */ }
  }
  return "";
}

export class ScreenRecorder {
  private state: RecorderState = {
    status: "idle",
    startedAt: null,
    durationSeconds: 0,
    error: null,
    inAppRecordingUnavailable: !isInAppRecordingSupported(),
  };
  private listeners = new Set<RecorderListener>();
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private mimeType = "";
  private timerHandle: number | null = null;
  private resolveStop: ((result: RecordingResult | null) => void) | null = null;

  subscribe(listener: RecorderListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  getState(): RecorderState {
    return this.state;
  }

  private update(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  async start(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.state.inAppRecordingUnavailable) {
      this.update({ status: "error", error: "In-app recording unavailable on this platform — use the native screen recorder." });
      return;
    }
    this.update({ status: "starting", error: null });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
    } catch (err) {
      this.update({ status: "error", error: (err as Error).message });
      return;
    }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 4_000_000 });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this.update({ status: "error", error: (err as Error).message });
      return;
    }
    this.chunks = [];
    this.mimeType = mimeType;
    this.mediaStream = stream;
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });
      const result: RecordingResult = {
        blob,
        mimeType: this.mimeType || "video/webm",
        sizeBytes: blob.size,
        durationSeconds: this.state.durationSeconds,
      };
      this.cleanup();
      this.update({ status: "idle", startedAt: null, durationSeconds: 0 });
      const resolve = this.resolveStop;
      this.resolveStop = null;
      if (resolve) resolve(result);
    };
    // If the user stops sharing via the browser's "Stop sharing" UI, end the recording cleanly.
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => { void this.stop(); });
    });

    recorder.start(1000); // 1-second chunks for resilience
    this.update({ status: "recording", startedAt: Date.now(), durationSeconds: 0 });
    this.timerHandle = window.setInterval(() => {
      if (this.state.startedAt) {
        this.update({ durationSeconds: (Date.now() - this.state.startedAt) / 1000 });
      }
    }, 1000);
  }

  async stop(): Promise<RecordingResult | null> {
    if (this.state.status !== "recording") return null;
    this.update({ status: "saving" });
    return new Promise<RecordingResult | null>((resolve) => {
      this.resolveStop = resolve;
      try {
        this.mediaRecorder?.stop();
      } catch {
        this.cleanup();
        resolve(null);
      }
    });
  }

  private cleanup() {
    if (this.timerHandle != null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    try {
      this.mediaStream?.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    this.mediaStream = null;
    this.mediaRecorder = null;
  }
}

/** Trigger a browser download of a recorded blob with a timestamped filename. */
export function downloadRecording(result: RecordingResult, prefix = "southern-signal-session"): void {
  const url = URL.createObjectURL(result.blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = result.mimeType.includes("mp4") ? "mp4" : "webm";
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}-${stamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
