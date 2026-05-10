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
  /** Current dwell station. Sequential playback dwells here for a few
   *  ticks (mimicking a real spirit box on one frequency band) before
   *  jumping to a different station. */
  private dwellStationId: string | null = null;
  /** Where in the dwell station's buffer we play next. Advances each
   *  emit() so consecutive ticks hear *forward* through the same
   *  station's content — not random fragments from random places. */
  private dwellOffsetSec = 0;
  /** Ticks left on the current dwell. When this hits 0 we jump to a
   *  different station and pick a new offset + dwell length. */
  private dwellTicksRemaining = 0;
  /** RNG hook for tests; production is Math.random. */
  private rng: () => number;
  private state: RadioSweepState = {
    status: "idle",
    loaded: 0,
    total: 0,
    lastStation: null,
    error: null,
  };
  private listeners = new Set<(state: RadioSweepState) => void>();

  constructor(stations: readonly Station[] = DEFAULT_STATIONS, rng: () => number = Math.random) {
    this.stations = [...stations];
    this.rng = rng;
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

  /** Play one slice of the current dwell station, advancing forward
   *  through its buffer. When the dwell budget runs out, jump to a
   *  different station and emit a brief tuner click (the audible "klik"
   *  a real spirit-box demodulator makes catching up to a new band).
   *
   *  Behaviour shape (per tick at 280ms cadence):
   *    - 3–6 consecutive ticks dwell on one station (~840-1680ms),
   *      consecutive offsets so the listener hears forward audio.
   *    - On the dwell-end tick: ramp the old slice out, klik, then the
   *      next emit() picks a different station.
   *
   *  Returns the slice duration in ms so the UI amplitude meter can sync. */
  emit(opts: { durationMs?: number } = {}): { durationMs: number; station: Station | null; didJump: boolean } {
    if (!this.ctx || !this.master || this.buffers.size === 0) {
      return { durationMs: 0, station: null, didJump: false };
    }
    const dur = (opts.durationMs ?? 250) / 1000;

    let didJump = false;
    if (this.dwellTicksRemaining <= 0 || this.dwellStationId == null || !this.buffers.has(this.dwellStationId)) {
      didJump = true;
      this.pickNextDwell();
    }
    const station = this.stations.find((s) => s.id === this.dwellStationId) ?? null;
    const buf = this.dwellStationId ? this.buffers.get(this.dwellStationId) ?? null : null;
    if (!buf || !station) {
      return { durationMs: 0, station: null, didJump: false };
    }

    // Wrap the offset back to a fresh randomised start if we'd overrun
    // the buffer's tail — keeps dwell-forward playback running smoothly
    // even when a station's chunk is shorter than expected.
    if (this.dwellOffsetSec + dur + 0.05 >= buf.duration) {
      this.dwellOffsetSec = 0.1 + (buf.duration * 0.5 * this.rng());
    }

    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const env = this.ctx.createGain();
      const t0 = this.ctx.currentTime;
      // Slightly longer attack on dwell-continuation ticks to crossfade
      // smoothly off the previous slice; near-instant attack on a jump
      // (the tuner-click below fills the seam).
      const attackSec = didJump ? 0.005 : 0.03;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.9, t0 + attackSec);
      env.gain.linearRampToValueAtTime(0.7, t0 + dur * 0.7);
      env.gain.linearRampToValueAtTime(0, t0 + dur);

      src.connect(env).connect(this.master);
      src.start(t0, this.dwellOffsetSec, dur + 0.05);
      src.stop(t0 + dur + 0.08);

      this.active = src;

      if (didJump) this.tunerClick(t0);

      this.dwellOffsetSec += dur;
      this.dwellTicksRemaining -= 1;

      this.update({ lastStation: station });
      return { durationMs: dur * 1000, station, didJump };
    } catch (err) {
      this.update({ error: `emit() failed: ${(err as Error).message}` });
      return { durationMs: 0, station, didJump };
    }
  }

  /** Pick a fresh dwell station + offset + tick count. Avoids picking the
   *  same station twice in a row when the pool has more than one option. */
  private pickNextDwell(): void {
    const ids = Array.from(this.buffers.keys());
    if (ids.length === 0) {
      this.dwellStationId = null;
      this.dwellTicksRemaining = 0;
      this.dwellOffsetSec = 0;
      return;
    }
    let candidates = ids;
    if (ids.length > 1 && this.dwellStationId) {
      candidates = ids.filter((id) => id !== this.dwellStationId);
    }
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    this.dwellStationId = pick;
    const buf = this.buffers.get(pick)!;
    // Start at a random offset, leaving at least ~1.5s of runway.
    const maxStart = Math.max(0, buf.duration - 1.5);
    this.dwellOffsetSec = maxStart * this.rng();
    // 3–6 consecutive ticks ≈ 840-1680ms of dwell — about right for the
    // spirit-box "you can almost catch a word" feel without lingering
    // long enough to coherently identify a song or sentence.
    this.dwellTicksRemaining = 3 + Math.floor(this.rng() * 4);
  }

  /** Brief filtered-noise click to bridge two stations — sounds like an
   *  analog tuner snapping onto a new band. Pure currentTime scheduling
   *  so it sits cleanly inside the slice envelope. */
  private tunerClick(t0: number): void {
    if (!this.ctx || !this.master) return;
    try {
      const sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * 0.04)); // 40ms
      const noise = this.ctx.createBuffer(1, len, sr);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const env = 1 - i / len; // linear decay
        data[i] = (Math.random() * 2 - 1) * env * env;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = noise;
      const filt = this.ctx.createBiquadFilter();
      filt.type = "highpass";
      filt.frequency.value = 2200;
      filt.Q.value = 0.7;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.18;
      src.connect(filt).connect(gain).connect(this.master);
      src.start(t0);
      src.stop(t0 + 0.05);
    } catch { /* ignore — best-effort cosmetic */ }
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
    this.dwellStationId = null;
    this.dwellTicksRemaining = 0;
    this.dwellOffsetSec = 0;
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
