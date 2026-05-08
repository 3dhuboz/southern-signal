/**
 * AI Assistant — wraps the Anthropic-backed cloudAi router for the
 * Mission Control screen. Two real features:
 *
 *   1. Question generator (always available). Investigator taps "Suggest
 *      questions"; Sonnet returns 5 respectful prompts; investigator can
 *      tap a question to have it spoken via SpeechSynthesis. Each speak
 *      is hash-chained into the audit log.
 *
 *   2. Auto-debunker (available when posterior > 0.4). Sends the latest
 *      posterior + recent LR-increment summary to Sonnet/Opus and gets
 *      back ranked mundane explanations with suggested tests.
 *
 * Privacy: cloudAi.ts enforces hard refusal for culturallySensitive cases
 * AND the global preference flag — this UI surfaces those errors clearly.
 */

import { useCallback, useState } from "react";
import { autoDebunk, CloudGuardError, CloudKeyMissingError, generateQuestions, type DebunkResult } from "../lib/ai/cloudAi";
import { appendAuditEntry } from "../lib/db/auditLog";
import type { LogIncrement } from "../lib/posterior/posterior";
import s from "./AiAssistant.module.css";

interface AiAssistantProps {
  investigationId: string | null;
  posterior: number;
  recentIncrements: LogIncrement[];
  siteContext: string;
  /** Session-level cultural-sensitivity flag (per-case). The global pref is checked inside cloudAi.ts. */
  culturallySensitive: boolean;
}

type Mode = "idle" | "questions" | "debunker";

export function AiAssistant({ investigationId, posterior, recentIncrements, siteContext, culturallySensitive }: AiAssistantProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [debunks, setDebunks] = useState<DebunkResult[]>([]);

  const handleSuggestQuestions = useCallback(async () => {
    if (!investigationId) {
      setError("Begin a session first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMode("questions");
    setQuestions([]);
    try {
      const out = await generateQuestions(
        { siteContext, tone: "respectful", priorQuestions: questions },
        { investigationId, culturallySensitive },
      );
      setQuestions(out.slice(0, 5));
      await appendAuditEntry({
        actor: "ai",
        kind: "ai.questions.generated",
        payload: { investigation_id: investigationId, count: out.length, model: "anthropic/sonnet" },
      });
    } catch (err) {
      handleAiError(err, setError);
    } finally {
      setBusy(false);
    }
  }, [investigationId, siteContext, culturallySensitive, questions]);

  const speakQuestion = useCallback(async (q: string) => {
    if (!investigationId) return;
    try {
      const utterance = new SpeechSynthesisUtterance(q);
      utterance.rate = 0.92;
      utterance.pitch = 1;
      speechSynthesis.speak(utterance);
    } catch { /* ignore — first iOS use can require gesture */ }
    await appendAuditEntry({
      actor: "user",
      kind: "ai.question.asked",
      payload: { investigation_id: investigationId, question: q },
    });
  }, [investigationId]);

  const handleDebunk = useCallback(async () => {
    if (!investigationId) {
      setError("Begin a session first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMode("debunker");
    setDebunks([]);
    try {
      // Build a compact context: latest event + sensor summary + contamination tags.
      const lastIncrement = recentIncrements[recentIncrements.length - 1];
      const sensorSummary = recentIncrements
        .slice(-6)
        .map((inc) => `${inc.channel} +${inc.logLr.toFixed(2)} log LR (${inc.reason})`)
        .join("; ") || "no recent events";
      const out = await autoDebunk(
        {
          eventTitle: lastIncrement
            ? `${lastIncrement.channel} event — ${lastIncrement.reason}`
            : `Site posterior at ${posterior.toFixed(2)}`,
          eventDescription: `Current site posterior: ${posterior.toFixed(2)}.`,
          sensorSummary,
          contaminationMarkers: [],
        },
        { investigationId, culturallySensitive },
      );
      setDebunks(out);
      await appendAuditEntry({
        actor: "ai",
        kind: "ai.debunk.proposed",
        payload: {
          investigation_id: investigationId,
          count: out.length,
          posterior_at_request: posterior,
          model: "anthropic/sonnet",
        },
      });
    } catch (err) {
      handleAiError(err, setError);
    } finally {
      setBusy(false);
    }
  }, [investigationId, recentIncrements, posterior, culturallySensitive]);

  const debunkAvailable = posterior >= 0.4;

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <span className={s.eyebrow}>AI ASSIST</span>
        <span className={s.note}>Sonnet 4.6. Off-device per case. Refused on culturally sensitive sites.</span>
      </header>

      <div className={s.actions}>
        <button
          type="button"
          className={s.actionPrimary}
          onClick={handleSuggestQuestions}
          disabled={busy || !investigationId}
        >
          {busy && mode === "questions" ? "Thinking…" : "Suggest a question"}
        </button>
        <button
          type="button"
          className={s.action}
          onClick={handleDebunk}
          disabled={busy || !investigationId || !debunkAvailable}
          title={!debunkAvailable ? "Available when posterior ≥ 0.40" : undefined}
        >
          {busy && mode === "debunker" ? "Thinking…" : "Test mundane explanations"}
        </button>
      </div>

      {error && <p className={s.error}>{error}</p>}

      {mode === "questions" && questions.length > 0 && (
        <div className={s.list}>
          {questions.map((q, i) => (
            <button key={i} type="button" className={s.questionRow} onClick={() => speakQuestion(q)}>
              <span className={s.questionMark}>“</span>
              <span className={s.questionText}>{q}</span>
              <span className={s.questionAction}>Speak</span>
            </button>
          ))}
        </div>
      )}

      {mode === "debunker" && debunks.length > 0 && (
        <div className={s.list}>
          {debunks.map((d, i) => (
            <div key={i} className={s.debunkRow}>
              <div className={s.debunkHeader}>
                <span className={s.debunkBar} style={{ width: `${Math.round(Math.max(0, Math.min(1, d.plausibility)) * 100)}%` }} />
                <span className={s.debunkPlaus}>P {d.plausibility.toFixed(2)}</span>
              </div>
              <span className={s.debunkHypothesis}>{d.hypothesis}</span>
              <span className={s.debunkTest}><strong>Test:</strong> {d.test}</span>
            </div>
          ))}
        </div>
      )}

      <p className={s.disclaimer}>
        AI proposes; the investigator decides. AI never claims to hear voices or see ghosts. Every call hash-chained.
      </p>
    </div>
  );
}

function handleAiError(err: unknown, setError: (m: string) => void) {
  if (err instanceof CloudGuardError) {
    setError(err.message);
  } else if (err instanceof CloudKeyMissingError) {
    setError("Add your Anthropic API key in Setup → AI assistance.");
  } else {
    setError(`AI request failed: ${(err as Error).message}`);
  }
}
