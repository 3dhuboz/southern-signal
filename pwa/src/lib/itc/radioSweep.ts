/**
 * RadioSweep — real-radio audio source for the Spirit Box panel.
 *
 * Loads a curated pool of internet-radio stations via the
 * /api/radio/proxy Cloudflare function (which adds CORS), decodes each
 * fetched chunk into an AudioBuffer, and plays random 200–400ms slices
 * on demand. The slice cadence is driven by the same tick interval as
 * the formant-noise synth so the rest of the UI (trail, chrome,
 * amplitude meter) keeps working unchanged.
 *
 * # Forensic story (read this before adding more stations)
 *
 * Every slice you hear came from a real broadcast — a DJ, news anchor,
 * song lyric, ad, etc. The likelihood ratio for *paranormal* evidence
 * from any reported phrase is effectively zero, because there's an
 * exhaustively-explained mundane source for it. The Estes Method audit
 * pipeline already understands "broadcast contamination" — this class
 * just provides the audio. The caller is responsible for:
 *
 *   1. Firing a `contamination.radio_broadcast` audit marker the moment
 *      sweep starts (so the chain knows every clip captured during
 *      this window had a known contaminant).
 *   2. Treating reported phrases as experiential, NOT evidential.
 *
 * # Why slices vs continuous play
 *
 * A real spirit box scans frequencies at 50–200ms per channel; the
 * chopped audio is the whole point. Continuous play of one station
 * sounds like… a radio station. Slicing gives the hallmark spirit-box
 * texture (chopped voice fragments) AND keeps the LR-=0 forensic story
 * crisp — no single fragment is long enough to make sense on its own.
 */

export interface Station {
  /** Stable identifier, used in trail UI + audit markers. */
  id: string;
  /** Human-readable name. Shown in the now-playing line. */
  name: string;
  /** Original upstream stream URL. */
  url: string;
}

/** Default curated pool. CORS-permissive (via the proxy) and reliably up.
 *  Mix of music (so chopped vowels / lyrics) and talk (news / DJ
 *  voice-overs) — both give pareidolia-rich fragments. */
export const DEFAULT_STATIONS: readonly Station[] = [
  { id: "somafm-grovesalad", name: "Groove Salad",       url: "https://ice1.somafm.com/groovesalad-128-mp3" },
  { id: "somafm-u80s",       name: "Underground 80s",    url: "https://ice1.somafm.com/u80s-128-mp3" },
  { id: "somafm-seventies",  name: "Left Coast 70s",     url: "https://ice1.somafm.com/seventies-128-mp3" },
  { id: "somafm-dronezone",  name: "Drone Zone",         url: "https://ice1.somafm.com/dronezone-128-mp3" },
  { id: "somafm-defcon",     name: "DEF CON Radio",      url: "https://ice1.somafm.com/defcon-128-mp3" },
  { id: "somafm-spacestation", name: "Space Station",    url: "https://ice1.somafm.com/spacestation-128-mp3" },
];

/** State a UI panel might want to surface. */
export interface RadioSweepState {
  status: "idle" | "loading" | "ready" | "error";
  loaded: number;             // count of stations with a decoded buffer
  total: number;              // count of stations attempted
  lastStation: Station | null;
  error: string | null;
}

export class RadioSweep {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private stations: Station[];
  private active: AudioBufferSourceNode | null = null;
  private state: RadioSweepState = {
    status: "idle",
    loaded: 0,
    total: 0,
    lastStation: null,
    error: null,
  };
  private listeners = new Set<(state: RadioSweepState) => void>();

  constructor(stations: readonly Station[] = DEFAULT_STATIONS) {
    this.stations = [...stations];
  }

  subscribe(fn: (state: RadioSweepState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  getState(): RadioSweepState { return this.state; }

  /** Initialise the AudioContext + kick off chunk fetches for every
   *  station in parallel. Resolves once at least ONE station has been
   *  decoded — the sweep can start working as soon as the first buffer
   *  is in. Continues loading the rest in the background. */
  async start(): Promise<void> {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    try {
      const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch (err) {
      this.update({ status: "error", error: `AudioContext init failed: ${(err as Error).message}` });
      throw err;
    }

    this.update({ status: "loading", total: this.stations.length, loaded: 0, error: null });

    let firstResolve: (() => void) | null = null;
    let firstReject: ((err: Error) => void) | null = null;
    const firstReady = new Promise<void>((res, rej) => { firstResolve = res; firstReject = rej; });

    let firstSettled = false;
    let failuresPending = 0;

    const promises = this.stations.map(async (station) => {
      try {
        const buf = await this.loadStationChunk(station);
        this.buffers.set(station.id, buf);
        this.update({ loaded: this.buffers.size });
        if (!firstSettled) {
          firstSettled = true;
          firstResolve?.();
        }
      } catch (err) {
        failuresPending += 1;
        // Don't propagate individual failures — partial pool is fine.
        // But if EVERY station fails, surface that.
        if (failuresPending === this.stations.length && !firstSettled) {
          firstSettled = true;
          firstReject?.(err as Error);
        }
      }
    });

    // Don't await `promises` here — we let the rest load in the
    // background after first-ready resolves.
    void Promise.allSettled(promises).then(() => {
      if (this.buffers.size > 0) {
        this.update({ status: "ready" });
      } else if (this.state.status !== "error") {
        this.update({ status: "error", error: "All radio stations failed to load." });
      }
    });

    await firstReady;
    if (this.buffers.size > 0) this.update({ status: "ready" });
  }

  /** Play a short slice of a random loaded station. Mirrors
   *  PhonemeSynth.emit() — returns the duration in ms so the UI can
   *  drive the amplitude meter the same way. */
  emit(opts: { durationMs?: number } = {}): { durationMs: number; station: Station | null } {
    if (!this.ctx || !this.master || this.buffers.size === 0) {
      return { durationMs: 0, station: null };
    }
    const dur = (opts.durationMs ?? 250) / 1000;
    const stationIds = Array.from(this.buffers.keys());
    const stationId = stationIds[Math.floor(Math.random() * stationIds.length)];
    const buf = this.buffers.get(stationId);
    const station = this.stations.find((s) => s.id === stationId) ?? null;
    if (!buf || !station) return { durationMs: 0, station: null };

    // Random offset inside the buffer, leaving room for the slice.
    const maxStart = Math.max(0, buf.duration - dur - 0.05);
    const offset = maxStart * Math.random();

    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const env = this.ctx.createGain();
      const t0 = this.ctx.currentTime;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.9, t0 + 0.015);
      env.gain.linearRampToValueAtTime(0.7, t0 + dur * 0.7);
      env.gain.linearRampToValueAtTime(0, t0 + dur);

      src.connect(env).connect(this.master);
      src.start(t0, offset, dur + 0.02);
      src.stop(t0 + dur + 0.05);

      // Keep one handle so we can interrupt cleanly on stop().
      this.active = src;

      this.update({ lastStation: station });
      return { durationMs: dur * 1000, station };
    } catch (err) {
      this.update({ error: `emit() failed: ${(err as Error).message}` });
      return { durationMs: 0, station };
    }
  }

  /** Replace the chunk for one station — call periodically while sweeping
   *  so the slice pool doesn't go stale. Default cadence: every 60s per
   *  station (the UI drives this). */
  async refresh(stationId: string): Promise<void> {
    const station = this.stations.find((s) => s.id === stationId);
    if (!station) return;
    try {
      const buf = await this.loadStationChunk(station);
      this.buffers.set(station.id, buf);
    } catch {
      // Stale buffer beats no buffer — keep the old one.
    }
  }

  /** Get the list of station IDs that currently have a usable buffer. */
  loadedStationIds(): string[] {
    return Array.from(this.buffers.keys());
  }

  close(): void {
    try { this.active?.stop(); } catch { /* ignore */ }
    this.active = null;
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.master = null;
    this.buffers.clear();
    this.update({ status: "idle", loaded: 0, lastStation: null });
  }

  private async loadStationChunk(station: Station): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error("AudioContext not initialised.");
    const proxyUrl = `/api/radio/proxy?url=${encodeURIComponent(station.url)}&ms=5000`;
    const res = await fetch(proxyUrl, { method: "GET" });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Proxy ${res.status} for ${station.name}: ${detail.slice(0, 120)}`);
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 1024) throw new Error(`Chunk too small for ${station.name} (${bytes.byteLength} bytes).`);
    // decodeAudioData rejects on non-decodable bytes (corrupt frame at the
    // chunk boundary). Most browsers tolerate truncation gracefully.
    return await this.ctx.decodeAudioData(bytes);
  }

  private update(patch: Partial<RadioSweepState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}
