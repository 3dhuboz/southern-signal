/**
 * Estes — dual-phone Method UI.
 *
 * One phone runs the Receiver: blackout screen + Ganzfeld pulse +
 * spirit-box phoneme audio + mic streamed to the partner phone.
 * Receiver speaks anything they "hear" out loud.
 *
 * The other phone runs the Questioner: types questions (sent over
 * datachannel + spoken aloud by SpeechSynthesis on the receiver), hears
 * the receiver's mic, and watches a timestamped log of both sides for
 * intelligent-response review.
 *
 * Pair via 6-digit code routed through `/api/estes/signal` (cache-
 * backed, 120s TTL). Once peered, audio + chat flow P2P.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../lib/session";
import { EstesPeer, generatePairingCode } from "../lib/estes/peer";
import type { PeerState } from "../lib/estes/peer";
import { nextPhoneme } from "../lib/itc/phonemes";
import { PhonemeSynth } from "../lib/itc/phonemeSynth";
import { RadioSweep, type RadioSweepState, type Station } from "../lib/itc/radioSweep";
import { unlockAudio, peekAudioContext } from "../lib/audio/audioUnlock";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import { MicLevelMeter } from "../lib/audio/micLevel";
import s from "./View.module.css";
import e from "./Estes.module.css";

type Phase = "pick-role" | "receiver-prep" | "receiver" | "questioner" | "connected-receiver" | "connected-questioner";

interface LogEntry {
  who: "questioner" | "receiver";
  text: string;
  ts: string;
}

const CODE_TTL_SECONDS = 120;

const STATE_LABELS: Record<PeerState, string> = {
  idle: "Idle",
  gathering: "Finding network paths…",
  posting: "Sharing handshake…",
  waiting: "Waiting for the other phone to enter the code…",
  connecting: "Negotiating audio link…",
  connected: "Live",
  disconnected: "Disconnected",
  failed: "Connection failed — try again with a fresh code",
};

function formatMmSs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Map any 32-bit seed onto the FM broadcast band [88.0, 107.9] in 0.1 MHz
 *  steps. Pure cosmetic — the dial is a visual metaphor for the spirit-box
 *  scanning idiom; the underlying engine doesn't actually tune RF. */
function seedToFrequency(seed: number): number {
  return 88 + (Math.abs(seed | 0) % 200) / 10;
}

/** Same mapping but seeded from a station's stable id, so each loaded
 *  radio station consistently "tunes" to the same dial position
 *  throughout the session — feels like the dial settled on a real band. */
function stationIdToFrequency(stationId: string): number {
  let h = 5381;
  for (let i = 0; i < stationId.length; i++) h = ((h * 33) ^ stationId.charCodeAt(i)) | 0;
  return 88 + (Math.abs(h) % 200) / 10;
}

/** FrequencyDial — Necrophonic-style 88-108 MHz strip with a moving
 *  needle. Renders into a canvas so the needle animates smoothly without
 *  re-renders. Theme-aware: tick / label colours read from CSS custom
 *  properties on the canvas element. */
interface FrequencyDialProps {
  frequencyMhz: number;
  active: boolean;
  /** "radio" highlights the needle amber to mirror the broadcast-
   *  contamination chrome on the rest of the panel; "synth" uses
   *  signal teal for evidence-safe mode. */
  variant: "synth" | "radio";
}
function FrequencyDial({ frequencyMhz, active, variant }: FrequencyDialProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width * dpr)) canvas.width = Math.floor(rect.width * dpr);
    if (canvas.height !== Math.floor(rect.height * dpr)) canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cs = getComputedStyle(canvas);
    const signal = cs.getPropertyValue("--signal").trim() || "#7FFCD7";
    const warning = cs.getPropertyValue("--warning").trim() || "#D99E20";
    const textMuted = cs.getPropertyValue("--text-muted").trim() || "#71808C";
    const textDim = cs.getPropertyValue("--text-dim").trim() || "#4A5560";

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const padX = 14 * dpr;
    const usable = w - padX * 2;
    const railY = h * 0.62;
    const minF = 88;
    const maxF = 108;
    const range = maxF - minF;

    // Baseline rail
    ctx.strokeStyle = textDim;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(padX, railY);
    ctx.lineTo(w - padX, railY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Tick marks — 0.5 MHz minor, 2 MHz major
    for (let mhz = minF; mhz <= maxF; mhz += 0.5) {
      const x = padX + ((mhz - minF) / range) * usable;
      const isMajor = Math.round(mhz) % 2 === 0 && Math.abs(mhz - Math.round(mhz)) < 0.05;
      const tickH = isMajor ? 7 * dpr : 3 * dpr;
      ctx.strokeStyle = textMuted;
      ctx.globalAlpha = isMajor ? 0.7 : 0.3;
      ctx.beginPath();
      ctx.moveTo(x, railY);
      ctx.lineTo(x, railY + tickH);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Major tick labels
    ctx.fillStyle = textMuted;
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let mhz = 88; mhz <= 108; mhz += 4) {
      const x = padX + ((mhz - minF) / range) * usable;
      ctx.fillText(`${mhz}`, x, railY + 10 * dpr);
    }

    // Top-of-strip labels: band on the left, live frequency on the right
    ctx.fillStyle = textMuted;
    ctx.font = `bold ${9 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("FM  88.0 – 108.0 MHz", padX, 2 * dpr);

    if (active) {
      const liveColor = variant === "radio" ? warning : signal;
      ctx.fillStyle = liveColor;
      ctx.font = `bold ${10 * dpr}px ui-monospace, monospace`;
      ctx.textAlign = "right";
      ctx.fillText(`${frequencyMhz.toFixed(1)} MHz`, w - padX, 2 * dpr);
    }

    // Needle — line + triangle pointer
    const clampedF = Math.max(minF, Math.min(maxF, frequencyMhz));
    const needleX = padX + ((clampedF - minF) / range) * usable;
    const needleColor = variant === "radio" ? warning : signal;

    ctx.strokeStyle = needleColor;
    ctx.globalAlpha = active ? 1 : 0.35;
    ctx.lineWidth = 2 * dpr;

    if (active) {
      ctx.shadowColor = needleColor;
      ctx.shadowBlur = 10 * dpr;
    }
    ctx.beginPath();
    ctx.moveTo(needleX, railY - 16 * dpr);
    ctx.lineTo(needleX, railY + 8 * dpr);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Pointer triangle at the top of the needle
    ctx.fillStyle = needleColor;
    ctx.beginPath();
    ctx.moveTo(needleX - 4 * dpr, railY - 18 * dpr);
    ctx.lineTo(needleX + 4 * dpr, railY - 18 * dpr);
    ctx.lineTo(needleX, railY - 11 * dpr);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
  }, [frequencyMhz, active, variant]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: 60 }}
      aria-hidden="true"
    />
  );
}

export function Estes() {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>("pick-role");
  const [code, setCode] = useState<string>("");
  const [enteredCode, setEnteredCode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [questionDraft, setQuestionDraft] = useState("");
  const [phonemeHistory, setPhonemeHistory] = useState<{ phoneme: string; ts: number; station?: Station | null }[]>([]);
  const [emissionCount, setEmissionCount] = useState(0);
  const [synthAmp, setSynthAmp] = useState(0);
  // Virtual FM frequency the dial is "tuned to" — derived deterministically
  // from the current seed (synth mode) or the current dwell station's id
  // (radio mode). Visual metaphor only: the synth doesn't actually use FM;
  // the radio sweep cycles internet stations, not RF bands. The dial is the
  // ghost-hunting genre's canonical visual cue ("88-108 MHz scanner") and
  // people read it instantly even though our forensic guts are different.
  const [tunedFrequency, setTunedFrequency] = useState<number>(88.0);
  const [spiritBoxOn, setSpiritBoxOn] = useState(false);
  // "synth" — formant-noise burst (deterministic, no broadcast contamination).
  // "radio" — real internet-radio chunks proxied via /api/radio/proxy. Every
  // slice is real broadcast audio, so the audit chain auto-fires a
  // `contamination.tag` event on start. See radioSweep.ts header for the
  // full forensic story.
  const [audioSource, setAudioSource] = useState<"synth" | "radio">("synth");
  const [radioState, setRadioState] = useState<RadioSweepState>({
    status: "idle", loaded: 0, total: 0, lastStation: null, error: null,
  });
  const [ganzfeldOn, setGanzfeldOn] = useState(true);
  const [blackoutOn, setBlackoutOn] = useState(true);
  const [peerState, setPeerState] = useState<PeerState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [remoteLevel, setRemoteLevel] = useState(0);
  const [codeIssuedAt, setCodeIssuedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const peerRef = useRef<EstesPeer | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micMeterRef = useRef<MicLevelMeter | null>(null);
  const remoteMeterRef = useRef<MicLevelMeter | null>(null);
  const seedRef = useRef<number>(Date.now() & 0x7fffffff);
  const phonemeTimerRef = useRef<number | null>(null);
  const synthRef = useRef<PhonemeSynth | null>(null);
  const radioRef = useRef<RadioSweep | null>(null);
  const radioRefreshTimerRef = useRef<number | null>(null);
  const ampDecayTimerRef = useRef<number | null>(null);

  const appendLog = useCallback((entry: LogEntry) => {
    setLog((arr) => [...arr.slice(-499), entry]);
    if (session.current) {
      void recordEvent({
        investigation_id: session.current.id,
        source: "user",
        event_type: "estes.log",
        title: `Estes ${entry.who}: ${entry.text.slice(0, 80)}`,
        description: entry.text,
        timestamp: entry.ts,
        metadata: { who: entry.who, text: entry.text },
      }).catch(() => { /* ignore */ });
    }
  }, [session.current]);

  // Code TTL ticker (1Hz when waiting on a code).
  useEffect(() => {
    if (codeIssuedAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [codeIssuedAt]);

  const codeRemaining = codeIssuedAt == null ? null : Math.max(0, CODE_TTL_SECONDS - Math.floor((now - codeIssuedAt) / 1000));

  // Spirit-box tick (Receiver only). One scheduler, two audio backends:
  //   - "synth" — formant-noise burst, deterministic, no broadcast risk
  //   - "radio" — random slice from a pool of real internet radio
  //              chunks. Every slice has a real broadcast source, so we
  //              fire a `contamination.tag` audit entry on start.
  // The trail / chrome / amplitude meter UI works the same way for both;
  // only the audio source and the chrome's "src" label differ.
  useEffect(() => {
    const stop = () => {
      if (phonemeTimerRef.current != null) {
        window.clearInterval(phonemeTimerRef.current);
        phonemeTimerRef.current = null;
      }
      if (ampDecayTimerRef.current != null) {
        window.clearInterval(ampDecayTimerRef.current);
        ampDecayTimerRef.current = null;
      }
      if (radioRefreshTimerRef.current != null) {
        window.clearInterval(radioRefreshTimerRef.current);
        radioRefreshTimerRef.current = null;
      }
      setSynthAmp(0);
      try { synthRef.current?.close(); } catch { /* ignore */ }
      synthRef.current = null;
      try { radioRef.current?.close(); } catch { /* ignore */ }
      radioRef.current = null;
    };

    if (!spiritBoxOn || (phase !== "connected-receiver" && phase !== "receiver" && phase !== "receiver-prep")) {
      stop();
      // Reset the visible trail so the readout doesn't look "alive"
      // after the toggle goes off.
      setPhonemeHistory([]);
      setEmissionCount(0);
      setTunedFrequency(88.0);
      setRadioState({ status: "idle", loaded: 0, total: 0, lastStation: null, error: null });
      return;
    }

    // Amplitude decay tick (~30 Hz) for the live readout. Independent of
    // the phoneme rate so the meter has a smooth tail between bursts.
    ampDecayTimerRef.current = window.setInterval(() => {
      setSynthAmp((a) => Math.max(0, a * 0.78));
    }, 33);

    if (audioSource === "synth") {
      // Pass the shared (gesture-unlocked) AudioContext if the toggle
      // tap registered it; falls back to internal creation on the off
      // chance unlockAudio() returned null (no Web Audio support).
      synthRef.current = new PhonemeSynth(peekAudioContext());
      phonemeTimerRef.current = window.setInterval(() => {
        const { phoneme: p, nextSeed } = nextPhoneme(seedRef.current, Date.now() % 1000);
        seedRef.current = nextSeed;
        setPhonemeHistory((arr) => {
          const next = [...arr, { phoneme: p, ts: Date.now() }];
          return next.length > 12 ? next.slice(next.length - 12) : next;
        });
        setEmissionCount((n) => n + 1);
        // Visual: jump the FM needle to the seed-derived frequency.
        // Cosmetic only — the synth doesn't actually tune RF.
        setTunedFrequency(seedToFrequency(nextSeed));
        const ms = synthRef.current?.emit(p) ?? 0;
        if (ms > 0) setSynthAmp(1);
      }, 280);
    } else {
      // Radio mode — load the proxy chunks, fire the contamination
      // open-marker the moment the first chunk is in, then start
      // scanning. A close-marker is fired on the cleanup branch (toggle
      // off, switch back to synth, unmount) so the audit chain has a
      // bracketed window an external reviewer can read directly.
      // Pass the shared gesture-unlocked AudioContext so the dwell
      // slice player isn't silent on iOS Safari / Messenger in-app.
      const radio = new RadioSweep(undefined, undefined, peekAudioContext());
      radioRef.current = radio;
      const unsub = radio.subscribe(setRadioState);
      const investigationIdAtStart = session.current?.id ?? null;
      const startedAtMs = Date.now();
      let openedWindow = false;

      let cancelled = false;
      void (async () => {
        try {
          await radio.start();
          if (cancelled) return;
          // Forensic stamp — OPEN. Any clip captured during the sweep
          // window has a known mundane source. The chain needs that
          // record. The matching CLOSE event fires in the cleanup
          // below so the window is bracketed both sides.
          openedWindow = true;
          if (investigationIdAtStart) {
            void recordEvent({
              investigation_id: investigationIdAtStart,
              source: "user",
              event_type: "contamination",
              title: "Spirit Box — Radio Sweep started (broadcast contamination)",
              metadata: {
                tag: "radio_broadcast",
                source: "spirit_box_radio_sweep",
                phase: "open",
                started_at_ms: startedAtMs,
              },
            }).catch(() => { /* don't break the UI */ });
            void appendAuditEntry({
              actor: "user",
              kind: "contamination.tag",
              payload: {
                investigation_id: investigationIdAtStart,
                tag: "radio_broadcast",
                source: "spirit_box_radio_sweep",
                phase: "open",
                started_at_ms: startedAtMs,
                stations_loaded: radio.loadedStationIds(),
              },
            }).catch(() => { /* don't break the UI */ });
          }

          phonemeTimerRef.current = window.setInterval(() => {
            const { durationMs, station, didJump } = radio.emit({ durationMs: 250 });
            if (durationMs > 0) {
              setSynthAmp(1);
              setEmissionCount((n) => n + 1);
              // Only push to history (and tune the dial) on a station
              // JUMP — otherwise the trail would repeat "BBC BBC BBC"
              // across every dwell tick and the needle would jitter
              // between two values mid-dwell. Dwell ticks still drive
              // the amplitude meter and count, so the panel feels
              // alive between jumps.
              if (didJump) {
                setPhonemeHistory((arr) => {
                  const next = [...arr, { phoneme: station?.name ?? "—", ts: Date.now(), station }];
                  return next.length > 12 ? next.slice(next.length - 12) : next;
                });
                if (station) setTunedFrequency(stationIdToFrequency(station.id));
              }
            }
          }, 280);

          // Periodic chunk refresh — pick the next loaded station every
          // 10s, re-fetch its 5s buffer. Across 6 stations, each station
          // refreshes ~once a minute.
          let cursor = 0;
          radioRefreshTimerRef.current = window.setInterval(() => {
            const ids = radio.loadedStationIds();
            if (ids.length === 0) return;
            const id = ids[cursor % ids.length];
            cursor += 1;
            void radio.refresh(id);
          }, 10_000);
        } catch { /* state listener already surfaced the error */ }
      })();

      return () => {
        cancelled = true;
        unsub();
        // Close the contamination window cleanly. Only if we actually
        // opened it — if start() failed before the open-marker fired
        // there's nothing to close. Both writes are fire-and-forget so
        // a slow DB doesn't stall the cleanup path.
        if (openedWindow && investigationIdAtStart) {
          const endedAtMs = Date.now();
          const durationMs = endedAtMs - startedAtMs;
          void recordEvent({
            investigation_id: investigationIdAtStart,
            source: "user",
            event_type: "contamination",
            title: "Spirit Box — Radio Sweep ended",
            metadata: {
              tag: "radio_broadcast",
              source: "spirit_box_radio_sweep",
              phase: "close",
              started_at_ms: startedAtMs,
              ended_at_ms: endedAtMs,
              duration_ms: durationMs,
            },
          }).catch(() => { /* don't break the UI */ });
          void appendAuditEntry({
            actor: "user",
            kind: "contamination.tag",
            payload: {
              investigation_id: investigationIdAtStart,
              tag: "radio_broadcast",
              source: "spirit_box_radio_sweep",
              phase: "close",
              started_at_ms: startedAtMs,
              ended_at_ms: endedAtMs,
              duration_ms: durationMs,
            },
          }).catch(() => { /* don't break the UI */ });
        }
        stop();
      };
    }

    return stop;
  }, [spiritBoxOn, phase, audioSource, session]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try { peerRef.current?.close(); } catch { /* ignore */ }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      try { micMeterRef.current?.stop(); } catch { /* ignore */ }
      try { remoteMeterRef.current?.stop(); } catch { /* ignore */ }
      try { synthRef.current?.close(); } catch { /* ignore */ }
      try { radioRef.current?.close(); } catch { /* ignore */ }
      if (ampDecayTimerRef.current != null) window.clearInterval(ampDecayTimerRef.current);
      if (radioRefreshTimerRef.current != null) window.clearInterval(radioRefreshTimerRef.current);
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleTestMic = async () => {
    setError(null);
    setBusy(true);
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      micStreamRef.current = mic;
      const meter = new MicLevelMeter(mic);
      meter.start((lvl) => setMicLevel(lvl));
      micMeterRef.current = meter;
      setPhase("receiver-prep");
    } catch (err) {
      setError((err as Error).message || "Microphone permission denied. The Receiver phone needs mic access.");
    } finally {
      setBusy(false);
    }
  };

  const handleStartReceiver = async () => {
    setError(null);
    setBusy(true);
    try {
      const mic = micStreamRef.current;
      if (!mic) throw new Error("No microphone — go back and tap Test mic again.");

      const c = generatePairingCode();
      setCode(c);
      setCodeIssuedAt(Date.now());
      setNow(Date.now());

      const peer = new EstesPeer({
        onState: (s) => setPeerState(s),
        onConnected: () => {
          setPhase("connected-receiver");
          setCodeIssuedAt(null);
          if (session.current) {
            void appendAuditEntry({
              actor: "user",
              kind: "estes.connect",
              payload: { investigation_id: session.current.id, role: "receiver", code: c },
            }).catch(() => { /* ignore */ });
          }
        },
        onClosed: () => {
          // Don't kick the user back to pick-role on transient disconnect —
          // the peer state badge already shows "disconnected".
        },
        onMessage: (text, ts) => {
          appendLog({ who: "questioner", text, ts });
          // Speak the question aloud on the Receiver phone.
          try {
            speechSynthesis.cancel();
            const utt = new SpeechSynthesisUtterance(text);
            utt.rate = 1.0;
            utt.volume = 1.0;
            speechSynthesis.speak(utt);
          } catch { /* ignore */ }
        },
      });
      peerRef.current = peer;
      setPhase("receiver");
      await peer.startReceiver(c, mic);
    } catch (err) {
      const errMsg = err as Error;
      setError(errMsg.message || "Couldn't start as Receiver.");
      try { peerRef.current?.close(); } catch { /* ignore */ }
      peerRef.current = null;
      setPhase("receiver-prep");
    } finally {
      setBusy(false);
    }
  };

  const handleStartQuestioner = async () => {
    setError(null);
    if (enteredCode.length !== 6) {
      setError("Enter the 6-digit code from the Receiver phone.");
      return;
    }
    setBusy(true);
    try {
      const peer = new EstesPeer({
        onState: (s) => setPeerState(s),
        onConnected: () => {
          setPhase("connected-questioner");
          if (session.current) {
            void appendAuditEntry({
              actor: "user",
              kind: "estes.connect",
              payload: { investigation_id: session.current.id, role: "questioner", code: enteredCode },
            }).catch(() => { /* ignore */ });
          }
        },
        onClosed: () => { /* see receiver branch */ },
        onRemoteStream: (stream) => {
          const audio = remoteAudioRef.current;
          if (audio) {
            audio.srcObject = stream;
            audio.play().catch(() => { /* user gesture needed for first play, fine */ });
          }
          // Attach a level meter so the questioner sees the receiver's mic alive.
          try { remoteMeterRef.current?.stop(); } catch { /* ignore */ }
          const meter = new MicLevelMeter(stream);
          meter.start((lvl) => setRemoteLevel(lvl));
          remoteMeterRef.current = meter;
        },
        onMessage: (text, ts) => {
          // Receiver doesn't currently send back text — but if they did, log it.
          appendLog({ who: "receiver", text, ts });
        },
      });
      peerRef.current = peer;
      setPhase("questioner");
      await peer.startQuestioner(enteredCode);
    } catch (err) {
      const errMsg = err as Error;
      setError(errMsg.message || "Couldn't connect to the Receiver.");
      try { peerRef.current?.close(); } catch { /* ignore */ }
      peerRef.current = null;
      setPhase("pick-role");
    } finally {
      setBusy(false);
    }
  };

  const sendQuestion = () => {
    const text = questionDraft.trim();
    if (!text || !peerRef.current?.isConnected()) return;
    peerRef.current.send(text);
    appendLog({ who: "questioner", text, ts: new Date().toISOString() });
    setQuestionDraft("");
  };

  const handleReceiverMark = () => {
    // Receiver taps to log "I just heard a word" — no text required.
    appendLog({ who: "receiver", text: `(perception @ ${new Date().toLocaleTimeString()})`, ts: new Date().toISOString() });
  };

  const handleEnd = () => {
    try { peerRef.current?.close(); } catch { /* ignore */ }
    peerRef.current = null;
    try { micMeterRef.current?.stop(); } catch { /* ignore */ }
    try { remoteMeterRef.current?.stop(); } catch { /* ignore */ }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micMeterRef.current = null;
    remoteMeterRef.current = null;
    micStreamRef.current = null;
    setSpiritBoxOn(false);
    setPhase("pick-role");
    setLog([]);
    setCode("");
    setEnteredCode("");
    setPeerState("idle");
    setMicLevel(0);
    setRemoteLevel(0);
    setCodeIssuedAt(null);
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyMsg("Copied.");
      window.setTimeout(() => setCopyMsg(null), 1200);
    } catch {
      setCopyMsg("Copy unavailable — read it aloud.");
      window.setTimeout(() => setCopyMsg(null), 1800);
    }
  };

  const isReceiver = phase === "receiver" || phase === "connected-receiver";
  const isQuestioner = phase === "questioner" || phase === "connected-questioner";
  const blackoutActive = phase === "connected-receiver" && blackoutOn;
  const codeExpired = codeRemaining === 0;

  const stateLabel = useMemo(() => {
    if (phase === "connected-receiver" || phase === "connected-questioner") return STATE_LABELS.connected;
    return STATE_LABELS[peerState];
  }, [peerState, phase]);

  return (
    <section className={`${s.view} ${blackoutActive ? e.viewBlack : ""}`.trim()}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Estes Method · Dual-phone</span>
        <h1 className={s.title}>Sensory-deprivation rig</h1>
        <p className={s.lede}>
          Pair two phones over a 6-digit code. One blacks out + spirit-box-cycles + streams mic to the partner. The other types questions, hears the receiver, and logs both sides with timestamps to the audit chain.
        </p>
      </div>

      {phase === "pick-role" && (
        <div className={e.roleRow}>
          <button type="button" className={e.roleCard} onClick={handleTestMic} disabled={busy}>
            <span className={e.roleEyebrow}>RECEIVER</span>
            <span className={e.roleTitle}>This phone goes dark</span>
            <span className={e.roleHint}>Blindfold + headphones recommended. Tap to test the mic and generate a pairing code.</span>
          </button>
          <button type="button" className={e.roleCard} onClick={() => { setError(null); setPhase("questioner"); }} disabled={busy}>
            <span className={e.roleEyebrow}>QUESTIONER</span>
            <span className={e.roleTitle}>This phone runs the room</span>
            <span className={e.roleHint}>Type questions, hear the receiver, watch the timestamped log. Enter the code from the Receiver phone.</span>
          </button>
        </div>
      )}

      {phase === "receiver-prep" && (
        <div className={e.codeEntry}>
          <header className={e.prepHeader}>
            <span className={e.prepEyebrow}>STEP 1 / 2 · MIC CHECK</span>
            <h2 className={e.prepTitle}>Talk into the mic — bar should move</h2>
            <p className={e.prepHint}>Speak normally. If the bar stays flat, your mic isn't reaching the page — close the tab, re-open, and grant mic permission.</p>
          </header>
          <div className={e.levelMeter} aria-label="Microphone level">
            <div className={e.levelFill} style={{ width: `${Math.min(100, micLevel * 100).toFixed(0)}%` }} />
          </div>
          <div className={e.codeActions}>
            <button type="button" className={e.primaryBtn} onClick={handleStartReceiver} disabled={busy || micLevel < 0.005}>
              {busy ? "Generating code…" : "Mic is good — generate pairing code"}
            </button>
            <button type="button" className={e.ghostBtn} onClick={handleEnd}>Cancel</button>
          </div>
          <p className={e.disclaimer}>The pairing code is single-use, valid for 120 seconds, and only carries the WebRTC handshake. Audio streams P2P after that.</p>
        </div>
      )}

      {phase === "receiver" && (
        <div className={e.codeEntry}>
          <header className={e.prepHeader}>
            <span className={e.prepEyebrow}>STEP 2 / 2 · WAITING FOR PARTNER</span>
            <h2 className={e.prepTitle}>Tell the Questioner this code</h2>
          </header>
          <div className={e.codeBigRow}>
            <span className={e.codeBigText}>{code}</span>
            <button type="button" className={e.ghostBtn} onClick={handleCopyCode}>Copy</button>
          </div>
          {copyMsg && <p className={e.copyMsg}>{copyMsg}</p>}
          <div className={e.ttlRow}>
            <span className={e.ttlLabel}>Code expires in</span>
            <span className={`${e.ttlValue} ${codeExpired ? e.ttlExpired : ""}`.trim()}>{formatMmSs(codeRemaining ?? 0)}</span>
          </div>
          <p className={e.statusRow}>{stateLabel}</p>
          {codeExpired && (
            <button type="button" className={e.primaryBtn} onClick={handleStartReceiver} disabled={busy}>
              {busy ? "Re-issuing…" : "Generate new code"}
            </button>
          )}
          <button type="button" className={e.ghostBtn} onClick={handleEnd}>Cancel</button>
        </div>
      )}

      {phase === "questioner" && (
        <div className={e.codeEntry}>
          <header className={e.prepHeader}>
            <span className={e.prepEyebrow}>QUESTIONER · ENTER CODE</span>
            <h2 className={e.prepTitle}>Type the 6-digit code from the Receiver</h2>
          </header>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={enteredCode}
            onChange={(ev) => setEnteredCode(ev.target.value.replace(/\D/g, ""))}
            className={e.codeInput}
            autoFocus
            placeholder="000000"
          />
          <p className={e.statusRow}>{stateLabel}</p>
          <div className={e.codeActions}>
            <button type="button" className={e.primaryBtn} onClick={handleStartQuestioner} disabled={busy || enteredCode.length !== 6}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            <button type="button" className={e.ghostBtn} onClick={handleEnd}>Cancel</button>
          </div>
          <p className={e.disclaimer}>The 6-digit code is single-use and expires in 120 seconds. Audio streams P2P after the handshake.</p>
        </div>
      )}

      {(isReceiver && phase !== "receiver" || isQuestioner) && (
        <>
          <div className={e.statusBar}>
            <span className={`${e.statusBadge} ${peerState === "connected" ? e.badgeOk : peerState === "failed" ? e.badgeBad : e.badgeWait}`.trim()}>
              {phase.replace("-", " ").toUpperCase()}
            </span>
            <span className={e.statusMsg}>{stateLabel}</span>
            <button type="button" className={e.endBtn} onClick={handleEnd}>End</button>
          </div>

          {isReceiver && (
            <div className={e.receiverPanel}>
              {/* Instrument-panel readout. The forensic story lives in the
                  chrome (seed, count, rate, source) — exposing the machinery
                  is the whole point: anything reported by the receiver came
                  from a deterministic, seeded, inspectable engine, not a
                  black-box mystery generator. */}
              <div className={`${e.receiverDisplay} ${audioSource === "radio" ? e.receiverDisplayRadio : ""}`.trim()}>
                <div className={e.synthChrome}>
                  <span className={e.synthChromeLabel}>
                    {audioSource === "radio" ? "RADIO SWEEP · BROADCAST CONTAMINATION" : "STOCHASTIC PHONEME ENGINE"}
                  </span>
                  {audioSource === "synth" ? (
                    <>
                      <span className={e.synthChromeStat}>
                        seed <code>0x{(seedRef.current >>> 0).toString(16).padStart(8, "0").slice(-6)}</code>
                      </span>
                      <span className={e.synthChromeStat}>
                        n=<code>{emissionCount.toString().padStart(4, "0")}</code>
                      </span>
                      <span className={e.synthChromeStat}>rate <code>3.6 Hz</code></span>
                      <span className={e.synthChromeStat}>src <code>time(ms)</code></span>
                    </>
                  ) : (
                    <>
                      <span className={e.synthChromeStat}>
                        pool <code>{radioState.loaded}/{radioState.total}</code>
                      </span>
                      <span className={e.synthChromeStat}>
                        n=<code>{emissionCount.toString().padStart(4, "0")}</code>
                      </span>
                      <span className={e.synthChromeStat}>rate <code>3.6 Hz</code></span>
                      <span className={e.synthChromeStat}>
                        src <code>{radioState.status}</code>
                      </span>
                    </>
                  )}
                </div>
                {/* FM dial — the canonical spirit-box visual (Necrophonic,
                    Ghost Voice Box, every hardware P-SB7 / SB11). The
                    underlying engine doesn't actually tune RF; the needle
                    position is derived from the current seed (synth) or
                    the current dwell station's id (radio). Pure visual
                    metaphor — the engineering chrome above still tells
                    the truth about what's running. */}
                <div className={e.freqDialWrap}>
                  <FrequencyDial
                    frequencyMhz={tunedFrequency}
                    active={emissionCount > 0}
                    variant={audioSource}
                  />
                </div>
                <div className={e.synthTrail} aria-live="polite">
                  {phonemeHistory.length === 0 ? (
                    <span className={e.synthTrailIdle}>
                      {audioSource === "radio" && radioState.status === "loading"
                        ? `loading stations — ${radioState.loaded}/${radioState.total}`
                        : audioSource === "radio" && radioState.status === "error"
                        ? `error — ${radioState.error ?? "unknown"}`
                        : "idle — waiting for spirit-box toggle"}
                    </span>
                  ) : (
                    phonemeHistory.map((h, i) => {
                      const isCurrent = i === phonemeHistory.length - 1;
                      return (
                        <span
                          key={`${h.ts}-${i}`}
                          className={isCurrent ? e.synthTrailCurrent : e.synthTrailItem}
                          style={{ opacity: isCurrent ? 1 : 0.15 + (0.7 * i) / phonemeHistory.length }}
                        >
                          {h.phoneme}
                        </span>
                      );
                    })
                  )}
                </div>
                <div className={e.synthAmpRow}>
                  <span className={e.synthAmpLabel}>AMP</span>
                  <div className={e.synthAmpBar}>
                    <div
                      className={e.synthAmpFill}
                      style={{ width: `${(synthAmp * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
                {audioSource === "synth" ? (
                  <p className={e.synthHonesty}>
                    Formant-shaped noise burst per emission · seed advances deterministically · corpus inspectable in source ·{" "}
                    <strong>NOT a radio sweep</strong>
                  </p>
                ) : (
                  <p className={e.synthHonesty}>
                    Every slice is a real broadcast (DJ, song lyric, news, ad) · auto-fires a{" "}
                    <code>contamination.tag · radio_broadcast</code> audit marker on start ·{" "}
                    <strong>this channel cannot produce paranormal evidence — experiential only</strong>
                  </p>
                )}
              </div>

              {/* Audio-source selector — sits below the readout so the
                  receiver can flip between the deterministic synth and
                  the broadcast-contamination sweep without leaving the
                  panel. Defaults to synth (the evidence-safe path). */}
              <div className={e.sourceRow}>
                <span className={e.sourceLabel}>AUDIO</span>
                <div className={e.sourceSegmented} role="radiogroup" aria-label="Audio source">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={audioSource === "synth"}
                    className={`${e.sourceOpt} ${audioSource === "synth" ? e.sourceOptActive : ""}`.trim()}
                    onClick={() => { unlockAudio(); setAudioSource("synth"); }}
                  >
                    Stochastic synth
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={audioSource === "radio"}
                    className={`${e.sourceOpt} ${audioSource === "radio" ? e.sourceOptActive : ""}`.trim()}
                    onClick={() => { unlockAudio(); setAudioSource("radio"); }}
                  >
                    Radio sweep
                  </button>
                </div>
              </div>
              <button type="button" className={e.markBtn} onClick={handleReceiverMark}>
                I heard something — log it
              </button>
              <div className={e.toggleRow}>
                <label className={e.toggle}>
                  <input
                    type="checkbox"
                    checked={spiritBoxOn}
                    onChange={(ev) => {
                      // Gesture-time AudioContext unlock — required on iOS
                      // Safari + Facebook Messenger / Instagram in-app
                      // browsers, where deferred context creation in a
                      // useEffect or setInterval starts and stays
                      // suspended. Calling here keeps the synth audible.
                      if (ev.target.checked) unlockAudio();
                      setSpiritBoxOn(ev.target.checked);
                    }}
                  />
                  <span>Spirit-box phonemes</span>
                </label>
                <label className={e.toggle}>
                  <input type="checkbox" checked={ganzfeldOn} onChange={(ev) => setGanzfeldOn(ev.target.checked)} />
                  <span>Ganzfeld pulse</span>
                </label>
                <label className={e.toggle}>
                  <input type="checkbox" checked={blackoutOn} onChange={(ev) => setBlackoutOn(ev.target.checked)} />
                  <span>Blackout when connected</span>
                </label>
              </div>
              {phase === "connected-receiver" && ganzfeldOn && <div className={e.ganzfeld} aria-hidden="true" />}
              <p className={e.disclaimer}>
                Hold the phone face-out (away from you) so the Ganzfeld pulse hits the blindfold or eyelids evenly. Speak whatever you hear out loud — your voice goes to the Questioner phone in real time. Tap the button above to log a perception without typing.
              </p>
            </div>
          )}

          {isQuestioner && (
            <div className={e.questionerPanel}>
              <audio ref={remoteAudioRef} className={e.hiddenAudio} autoPlay playsInline />
              <div className={e.remoteLevelRow}>
                <span className={e.remoteLevelLabel}>Receiver mic</span>
                <div className={e.levelMeter} aria-label="Receiver microphone level">
                  <div className={e.levelFill} style={{ width: `${Math.min(100, remoteLevel * 100).toFixed(0)}%` }} />
                </div>
                <span className={e.remoteLevelHint}>{remoteLevel < 0.005 ? "silent" : "live"}</span>
              </div>
              <div className={e.transcript}>
                {log.length === 0 ? (
                  <p className={e.transcriptEmpty}>Receiver mic is live (bar above). Type a question — it will be spoken aloud on the receiver phone and logged here with a timestamp.</p>
                ) : (
                  <ol className={e.transcriptList}>
                    {log.map((entry, i) => (
                      <li key={i} className={`${e.transcriptItem} ${entry.who === "questioner" ? e.transcriptItemQ : e.transcriptItemR}`}>
                        <span className={e.transcriptTime}>{new Date(entry.ts).toLocaleTimeString()}</span>
                        <span className={e.transcriptWho}>{entry.who.toUpperCase()}</span>
                        <span className={e.transcriptText}>{entry.text}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div className={e.questionRow}>
                <input
                  type="text"
                  className={e.questionInput}
                  value={questionDraft}
                  onChange={(ev) => setQuestionDraft(ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === "Enter") sendQuestion(); }}
                  placeholder="Type a question — it will be spoken aloud on the receiver phone"
                  disabled={phase !== "connected-questioner"}
                />
                <button type="button" className={e.primaryBtn} onClick={sendQuestion} disabled={phase !== "connected-questioner" || questionDraft.trim().length === 0}>
                  Send
                </button>
              </div>
            </div>
          )}

          {error && <p className={e.error}>{error}</p>}
        </>
      )}

      {error && phase === "pick-role" && <p className={e.error}>{error}</p>}
    </section>
  );
}
