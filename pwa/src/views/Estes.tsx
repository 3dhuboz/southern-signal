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

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../lib/session";
import { EstesPeer, generatePairingCode } from "../lib/estes/peer";
import { nextPhoneme } from "../lib/itc/phonemes";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./View.module.css";
import e from "./Estes.module.css";

type Phase = "pick-role" | "receiver" | "questioner" | "connected-receiver" | "connected-questioner";

interface LogEntry {
  who: "questioner" | "receiver";
  text: string;
  ts: string;
}

export function Estes() {
  const session = useSession();
  const [phase, setPhase] = useState<Phase>("pick-role");
  const [code, setCode] = useState<string>("");
  const [enteredCode, setEnteredCode] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [questionDraft, setQuestionDraft] = useState("");
  const [phoneme, setPhoneme] = useState<string>("—");
  const [spiritBoxOn, setSpiritBoxOn] = useState(false);
  const [ganzfeldOn, setGanzfeldOn] = useState(true);
  const [blackoutOn, setBlackoutOn] = useState(true);

  const peerRef = useRef<EstesPeer | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const seedRef = useRef<number>(Date.now() & 0x7fffffff);
  const phonemeTimerRef = useRef<number | null>(null);

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

  // Spirit-box phoneme tick (Receiver only).
  useEffect(() => {
    if (!spiritBoxOn || (phase !== "connected-receiver" && phase !== "receiver")) {
      if (phonemeTimerRef.current != null) {
        window.clearInterval(phonemeTimerRef.current);
        phonemeTimerRef.current = null;
      }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      return;
    }
    phonemeTimerRef.current = window.setInterval(() => {
      const { phoneme: p, nextSeed } = nextPhoneme(seedRef.current, Date.now() % 1000);
      seedRef.current = nextSeed;
      setPhoneme(p);
      try {
        speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(p);
        utt.rate = 1.5;
        utt.volume = 0.9;
        speechSynthesis.speak(utt);
      } catch { /* ignore */ }
    }, 280);
    return () => {
      if (phonemeTimerRef.current != null) {
        window.clearInterval(phonemeTimerRef.current);
        phonemeTimerRef.current = null;
      }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
    };
  }, [spiritBoxOn, phase]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try { peerRef.current?.close(); } catch { /* ignore */ }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
    };
  }, []);

  const handleStartReceiver = async () => {
    setError(null);
    setBusy(true);
    try {
      const c = generatePairingCode();
      setCode(c);
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const peer = new EstesPeer({
        onConnected: () => {
          setStatusMsg("Connected.");
          setPhase("connected-receiver");
          if (session.current) {
            void appendAuditEntry({
              actor: "user",
              kind: "estes.connect",
              payload: { investigation_id: session.current.id, role: "receiver", code: c },
            }).catch(() => { /* ignore */ });
          }
        },
        onClosed: () => setStatusMsg("Disconnected."),
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
      setStatusMsg("Waiting for the Questioner to enter the code…");
      await peer.startReceiver(c, mic);
    } catch (err) {
      const errMsg = err as Error;
      setError(errMsg.message || "Couldn't start as Receiver.");
      try { peerRef.current?.close(); } catch { /* ignore */ }
      peerRef.current = null;
      setPhase("pick-role");
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
        onConnected: () => {
          setStatusMsg("Connected.");
          setPhase("connected-questioner");
          if (session.current) {
            void appendAuditEntry({
              actor: "user",
              kind: "estes.connect",
              payload: { investigation_id: session.current.id, role: "questioner", code: enteredCode },
            }).catch(() => { /* ignore */ });
          }
        },
        onClosed: () => setStatusMsg("Disconnected."),
        onRemoteStream: (stream) => {
          const audio = remoteAudioRef.current;
          if (!audio) return;
          audio.srcObject = stream;
          audio.play().catch(() => { /* user gesture needed for first play, fine */ });
        },
        onMessage: (text, ts) => {
          // Receiver doesn't currently send back text — but if they did, log it.
          appendLog({ who: "receiver", text, ts });
        },
      });
      peerRef.current = peer;
      setStatusMsg("Connecting…");
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

  const handleEnd = () => {
    try { peerRef.current?.close(); } catch { /* ignore */ }
    peerRef.current = null;
    setSpiritBoxOn(false);
    setPhase("pick-role");
    setStatusMsg("Session ended.");
    setLog([]);
    setCode("");
    setEnteredCode("");
  };

  const isReceiver = phase === "receiver" || phase === "connected-receiver";
  const isQuestioner = phase === "questioner" || phase === "connected-questioner";
  const blackoutActive = isReceiver && phase === "connected-receiver" && blackoutOn;

  return (
    <section className={`${s.view} ${blackoutActive ? e.viewBlack : ""}`.trim()}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Estes Method · Dual-phone</span>
        <h1 className={s.title}>Sensory-deprivation rig</h1>
        <p className={s.lede}>
          Pair two phones over a 6-digit code. One blacks out + spirit-box-cycles + streams mic to the partner. Other phone types questions, hears the receiver's responses, and logs both with timestamps to the audit chain.
        </p>
      </div>

      {phase === "pick-role" && (
        <div className={e.roleRow}>
          <button type="button" className={e.roleCard} onClick={handleStartReceiver} disabled={busy}>
            <span className={e.roleEyebrow}>RECEIVER</span>
            <span className={e.roleTitle}>This phone goes dark</span>
            <span className={e.roleHint}>Blindfold + headphones recommended. Phone needs mic + speaker permission. Generates a code for the partner phone.</span>
          </button>
          <button type="button" className={e.roleCard} onClick={() => { setError(null); setStatusMsg(null); setPhase("questioner"); }} disabled={busy}>
            <span className={e.roleEyebrow}>QUESTIONER</span>
            <span className={e.roleTitle}>This phone runs the room</span>
            <span className={e.roleHint}>Type questions, hear the receiver, watch the timestamped log. Enter the code from the Receiver phone.</span>
          </button>
        </div>
      )}

      {phase === "questioner" && (
        <div className={e.codeEntry}>
          <label className={e.codeLabel}>
            <span>Enter the Receiver's 6-digit code</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={enteredCode}
              onChange={(ev) => setEnteredCode(ev.target.value.replace(/\D/g, ""))}
              className={e.codeInput}
              autoFocus
            />
          </label>
          <div className={e.codeActions}>
            <button type="button" className={e.primaryBtn} onClick={handleStartQuestioner} disabled={busy || enteredCode.length !== 6}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            <button type="button" className={e.ghostBtn} onClick={handleEnd}>Cancel</button>
          </div>
          <p className={e.disclaimer}>The 6-digit code is one-shot, expires in 120 seconds, and only carries the WebRTC handshake. Audio streams P2P after that.</p>
        </div>
      )}

      {(isReceiver || isQuestioner) && (
        <>
          <div className={e.statusBar}>
            <span className={e.statusBadge}>{phase.toUpperCase()}</span>
            {code && <span className={e.codeBig}>{code}</span>}
            {statusMsg && <span className={e.statusMsg}>{statusMsg}</span>}
            <button type="button" className={e.endBtn} onClick={handleEnd}>End</button>
          </div>

          {isReceiver && (
            <div className={e.receiverPanel}>
              <div className={e.receiverDisplay}>
                <span className={e.receiverPhoneme}>{phoneme}</span>
              </div>
              <div className={e.toggleRow}>
                <label className={e.toggle}>
                  <input type="checkbox" checked={spiritBoxOn} onChange={(ev) => setSpiritBoxOn(ev.target.checked)} />
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
                Hold the phone face-out (away from you) so the Ganzfeld pulse hits the blindfold or eyelids evenly. Speak whatever you hear out loud — your voice goes to the Questioner phone in real time.
              </p>
            </div>
          )}

          {isQuestioner && (
            <div className={e.questionerPanel}>
              <audio ref={remoteAudioRef} className={e.hiddenAudio} autoPlay playsInline />
              <div className={e.transcript}>
                {log.length === 0 ? (
                  <p className={e.transcriptEmpty}>The receiver's mic is live above. Type a question — it will be spoken on the receiver phone and logged here with a timestamp.</p>
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
    </section>
  );
}
