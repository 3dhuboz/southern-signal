/**
 * Tiny mic-level meter — reads RMS off a MediaStream via Web Audio.
 *
 * Usage:
 *   const meter = new MicLevelMeter(stream);
 *   meter.start((rms) => setLevel(rms));      // rms in [0..1]
 *   ...
 *   meter.stop();
 *
 * Independent of the EvpRecorder — used pre-pairing in Estes mode so the
 * Receiver can confirm their mic is alive before they put on a blindfold.
 */

export class MicLevelMeter {
  private stream: MediaStream;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rafId: number | null = null;
  private cb: ((rms: number) => void) | null = null;

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  start(cb: (rms: number) => void): void {
    if (this.ctx) return;
    this.cb = cb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    this.ctx = new Ctx();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    const buf = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    const tick = () => {
      if (!this.analyser || !this.cb) return;
      // Cast through unknown so the strict Float32Array<ArrayBuffer> overload accepts our buffer.
      this.analyser.getFloatTimeDomainData(buf as unknown as Float32Array<ArrayBuffer>);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i += 1) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);
      this.cb(Math.min(1, rms * 4)); // amplify for display; raw RMS is tiny
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.source = null;
    this.analyser = null;
    this.ctx = null;
    this.cb = null;
  }
}
