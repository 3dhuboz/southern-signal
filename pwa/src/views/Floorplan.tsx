/**
 * Floorplan — sketch the site, drop anomaly markers, and ask the AI
 * co-pilot to do the heavy lifting:
 *
 *   • Suggest a sweep order based on placed markers + room intent.
 *   • Generate site-specific EVP questions for a selected room/marker.
 *   • Generate the mundane-cause checklist for a selected anomaly.
 *
 * Every marker can carry a label + reviewer note. Tapping a marker
 * opens an inline tag sheet. AI suggestions land in a side panel and,
 * when the operator accepts a question, are appended to the audit
 * chain so the post-roll knows what was asked and where.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { generateQuestions, autoDebunk, type DebunkResult } from "../lib/ai/cloudAi";
import { useSession } from "../lib/session";
import { recordEvent } from "../lib/db/repo";
import { appendAuditEntry } from "../lib/db/auditLog";
import s from "./View.module.css";
import f from "./Floorplan.module.css";

interface Stroke {
  id: string;
  points: { x: number; y: number }[];
  kind: "wall" | "marker";
  label?: string;
  note?: string;
}

const STORAGE_KEY = "ss-floorplan-v2";

function loadStrokes(): Stroke[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate from v1 if present.
      const legacy = localStorage.getItem("ss-floorplan-v1");
      if (legacy) {
        const arr = JSON.parse(legacy) as Omit<Stroke, "id">[];
        return arr.map((s) => ({ ...s, id: crypto.randomUUID() }));
      }
      return [];
    }
    return JSON.parse(raw) as Stroke[];
  } catch { return []; }
}

export function Floorplan() {
  const session = useSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(loadStrokes);
  const [tool, setTool] = useState<"wall" | "marker" | "select">("wall");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aiQuestions, setAiQuestions] = useState<string[] | null>(null);
  const [aiDebunk, setAiDebunk] = useState<DebunkResult[] | null>(null);
  const [aiSweepOrder, setAiSweepOrder] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<null | "questions" | "debunk" | "sweep">(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiOff, setAiOff] = useState(false);
  const drawing = useRef<Stroke | null>(null);

  const selectedStroke = selectedId ? strokes.find((s) => s.id === selectedId) ?? null : null;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strokes));
  }, [strokes]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0A0E14";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(38, 46, 58, 0.6)";
    ctx.lineWidth = 1;
    const grid = 24;
    for (let x = 0; x < w; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      const isSelected = stroke.id === selectedId;
      if (stroke.kind === "wall") {
        ctx.strokeStyle = isSelected ? "#7FFCD7" : "#9BA6B8";
        ctx.lineWidth = isSelected ? 4 : 3;
        ctx.beginPath();
        stroke.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
      } else if (stroke.kind === "marker") {
        const last = stroke.points[stroke.points.length - 1];
        ctx.fillStyle = isSelected ? "#FF6E6E" : "#5DF2C7";
        ctx.beginPath();
        ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isSelected ? "rgba(255, 110, 110, 0.55)" : "rgba(93, 242, 199, 0.4)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 16, 0, Math.PI * 2);
        ctx.stroke();
        if (stroke.label) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.font = "11px ui-monospace, monospace";
          ctx.fillText(stroke.label, last.x + 22, last.y + 4);
        }
      }
    }
  }, [strokes, selectedId]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Hit-test markers within 18px to pick up taps in select mode.
  const hitTestMarker = (point: { x: number; y: number }): Stroke | null => {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      if (stroke.kind !== "marker") continue;
      const last = stroke.points[stroke.points.length - 1];
      const dx = last.x - point.x;
      const dy = last.y - point.y;
      if (dx * dx + dy * dy <= 18 * 18) return stroke;
    }
    return null;
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = getPoint(e);
    if (tool === "select") {
      const hit = hitTestMarker(point);
      setSelectedId(hit?.id ?? null);
      setAiQuestions(null);
      setAiDebunk(null);
      return;
    }
    if (tool === "marker") {
      const id = crypto.randomUUID();
      setStrokes((s) => [...s, { id, kind: "marker", points: [point] }]);
      setSelectedId(id);
      drawing.current = null;
      return;
    }
    const id = crypto.randomUUID();
    drawing.current = { id, kind: "wall", points: [point] };
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || tool !== "wall") return;
    const point = getPoint(e);
    drawing.current.points.push(point);
    setStrokes((s) => {
      const next = [...s];
      const idx = next.findIndex((x) => x.id === drawing.current!.id);
      if (idx === -1) next.push({ ...drawing.current! });
      else next[idx] = { ...drawing.current! };
      return next;
    });
  };

  const handleUp = () => {
    drawing.current = null;
  };

  const undo = () => setStrokes((s) => s.slice(0, -1));
  const clear = () => {
    setStrokes([]);
    setSelectedId(null);
    setAiQuestions(null);
    setAiDebunk(null);
    setAiSweepOrder(null);
  };

  const updateSelected = (patch: Partial<Stroke>) => {
    if (!selectedStroke) return;
    setStrokes((arr) => arr.map((x) => x.id === selectedStroke.id ? { ...x, ...patch } : x));
  };

  const removeSelected = () => {
    if (!selectedStroke) return;
    setStrokes((arr) => arr.filter((x) => x.id !== selectedStroke.id));
    setSelectedId(null);
  };

  const counts = {
    walls: strokes.filter((s) => s.kind === "wall").length,
    markers: strokes.filter((s) => s.kind === "marker").length,
  };

  // ----- AI co-pilot actions -----

  const callQuestionsForSelected = async () => {
    if (aiOff) return;
    setAiBusy("questions");
    setAiError(null);
    setAiDebunk(null);
    try {
      const ctx = { investigationId: session.current?.id ?? "anon", culturallySensitive: false };
      const siteContext = [
        session.current?.location_name ? `Location: ${session.current.location_name}.` : "",
        selectedStroke?.label ? `Selected room/marker: ${selectedStroke.label}.` : "",
        selectedStroke?.note ? `Reviewer note: ${selectedStroke.note}.` : "",
        `Floorplan has ${counts.walls} wall strokes and ${counts.markers} markers.`,
      ].filter(Boolean).join(" ");
      const qs = await generateQuestions({ siteContext, tone: "respectful" }, ctx);
      setAiQuestions(qs);
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiBusy(null);
    }
  };

  const callDebunkForSelected = async () => {
    if (aiOff || !selectedStroke || selectedStroke.kind !== "marker") return;
    setAiBusy("debunk");
    setAiError(null);
    setAiQuestions(null);
    try {
      const ctx = { investigationId: session.current?.id ?? "anon", culturallySensitive: false };
      const result = await autoDebunk(
        {
          eventTitle: selectedStroke.label ? `Anomaly marker: ${selectedStroke.label}` : "Unlabelled anomaly marker",
          eventDescription: selectedStroke.note ?? "Marker placed on floorplan with no note.",
          contaminationMarkers: [],
        },
        ctx,
      );
      setAiDebunk(result);
      // Feed the same H₀ metric the in-session debunker feeds — record the
      // plausibility distribution so Review's AHT post-roll status and the
      // Evidence Brief verdict reflect floorplan-marker debunks too.
      if (session.current?.id) {
        const maxPlausibility = result.length > 0 ? Math.max(...result.map((d) => d.plausibility)) : 0;
        const meanPlausibility = result.length > 0
          ? result.reduce((sum, d) => sum + d.plausibility, 0) / result.length
          : 0;
        await appendAuditEntry({
          actor: "ai",
          kind: "ai.debunk.proposed",
          payload: {
            investigation_id: session.current.id,
            count: result.length,
            source: "floorplan_marker",
            marker_label: selectedStroke.label ?? null,
            model: "anthropic/sonnet",
            max_plausibility: maxPlausibility,
            mean_plausibility: meanPlausibility,
          },
        }).catch(() => { /* audit best-effort — never block the UI */ });
      }
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiBusy(null);
    }
  };

  const callSweepOrder = async () => {
    if (aiOff) return;
    setAiBusy("sweep");
    setAiError(null);
    try {
      const markerSummary = strokes.filter((s) => s.kind === "marker").map((m, i) => {
        const last = m.points[m.points.length - 1];
        return `${i + 1}. ${m.label ?? "unlabelled"} at (${last.x.toFixed(0)}, ${last.y.toFixed(0)})${m.note ? ` — ${m.note}` : ""}`;
      });
      const userPrompt = [
        `Site has ${counts.walls} wall strokes and ${counts.markers} placed markers.`,
        markerSummary.length ? `Markers (room-coords in pixels):\n${markerSummary.join("\n")}` : "No markers placed yet.",
        "Recommend a sweep order (1, 2, 3…) for an investigator working solo with a phone, plus which sensor/tool to lead with at each marker (mic, camera, infrasound, EVP capture, contamination check). Keep it under 8 lines.",
      ].join("\n\n");
      const resp = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: "You are a forensic paranormal-investigation planner. You write short numbered sweep orders. Be concrete and respectful.",
          user: userPrompt,
          max_tokens: 280,
          temperature: 0.5,
        }),
      });
      if (!resp.ok) throw new Error(`Sweep planner ${resp.status}`);
      const data = await resp.json() as { text?: string };
      if (!data.text) throw new Error("No text returned");
      setAiSweepOrder(data.text);
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiBusy(null);
    }
  };

  const acceptQuestion = async (q: string) => {
    if (!session.current) return;
    try {
      await recordEvent({
        investigation_id: session.current.id,
        source: "user",
        event_type: "floorplan.question_accepted",
        title: `Question accepted: ${q}`,
        metadata: { question: q, marker_id: selectedStroke?.id ?? null, marker_label: selectedStroke?.label ?? null },
      });
      await appendAuditEntry({
        actor: "user",
        kind: "floorplan.question.accept",
        payload: { investigation_id: session.current.id, question: q, marker_id: selectedStroke?.id ?? null },
      });
    } catch { /* don't crash UI */ }
  };

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Floorplan</span>
        <h1 className={s.title}>Sketch the site</h1>
        <p className={s.lede}>Walls + anomaly markers + an AI co-pilot for sweep order, room-specific questions, and per-marker debunking.</p>
      </div>

      <div className={f.toolbar}>
        <button className={tool === "wall" ? f.toolActive : f.tool} onClick={() => setTool("wall")}>Wall</button>
        <button className={tool === "marker" ? f.toolActive : f.tool} onClick={() => setTool("marker")}>Marker</button>
        <button className={tool === "select" ? f.toolActive : f.tool} onClick={() => setTool("select")}>Select / tag</button>
        <button className={f.tool} onClick={undo} disabled={strokes.length === 0}>Undo</button>
        <button className={f.tool} onClick={clear} disabled={strokes.length === 0}>Clear</button>
        <span className={f.counts}>{counts.walls} walls · {counts.markers} markers</span>
        <label className={f.aiToggle}>
          <input type="checkbox" checked={aiOff} onChange={(e) => setAiOff(e.target.checked)} />
          <span>AI off</span>
        </label>
      </div>

      <div className={f.layout}>
        <canvas
          ref={canvasRef}
          className={f.canvas}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
        />

        <aside className={f.aiPanel}>
          <header className={f.aiPanelHead}>
            <span className={f.aiEyebrow}>AI CO-PILOT</span>
            {aiOff && <span className={f.aiOffBadge}>Off</span>}
          </header>

          {selectedStroke && selectedStroke.kind === "marker" ? (
            <div className={f.tagSheet}>
              <span className={f.tagEyebrow}>Marker · tap to edit</span>
              <input
                type="text"
                className={f.tagInput}
                value={selectedStroke.label ?? ""}
                onChange={(e) => updateSelected({ label: e.target.value })}
                placeholder="Label (e.g. cold spot, stairs landing)"
                maxLength={48}
              />
              <textarea
                className={f.tagTextarea}
                rows={2}
                value={selectedStroke.note ?? ""}
                onChange={(e) => updateSelected({ note: e.target.value })}
                placeholder="Reviewer note — what felt off, what mundane source you ruled out"
                maxLength={400}
              />
              <button type="button" className={f.tagDelete} onClick={removeSelected}>Delete marker</button>
            </div>
          ) : (
            <p className={f.aiHint}>Tap <strong>Select / tag</strong> then a marker to edit it. AI suggestions adapt to the selected marker, or work site-wide when nothing is selected.</p>
          )}

          <div className={f.aiActions}>
            <button
              type="button"
              className={f.aiBtn}
              onClick={callSweepOrder}
              disabled={aiOff || aiBusy != null}
            >
              {aiBusy === "sweep" ? "Planning…" : "Suggest sweep order"}
            </button>
            <button
              type="button"
              className={f.aiBtn}
              onClick={callQuestionsForSelected}
              disabled={aiOff || aiBusy != null}
            >
              {aiBusy === "questions" ? "Generating…" : selectedStroke ? "Questions for selected" : "Site-wide questions"}
            </button>
            <button
              type="button"
              className={f.aiBtn}
              onClick={callDebunkForSelected}
              disabled={aiOff || aiBusy != null || !selectedStroke || selectedStroke.kind !== "marker"}
            >
              {aiBusy === "debunk" ? "Working…" : "Debunk this marker"}
            </button>
          </div>

          {aiError && <p className={f.aiError}>{aiError}</p>}

          {aiSweepOrder && (
            <div className={f.aiResult}>
              <span className={f.aiResultLabel}>Sweep order</span>
              <pre className={f.aiResultPre}>{aiSweepOrder}</pre>
            </div>
          )}

          {aiQuestions && (
            <div className={f.aiResult}>
              <span className={f.aiResultLabel}>Suggested questions</span>
              <ol className={f.aiQuestionList}>
                {aiQuestions.map((q, i) => (
                  <li key={i} className={f.aiQuestionItem}>
                    <span>{q}</span>
                    <button
                      type="button"
                      className={f.aiAccept}
                      onClick={() => acceptQuestion(q)}
                      disabled={!session.current}
                      title={session.current ? "Append to audit chain" : "Begin a session first"}
                    >
                      Accept
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {aiDebunk && (
            <div className={f.aiResult}>
              <span className={f.aiResultLabel}>Debunk checklist</span>
              <ul className={f.aiDebunkList}>
                {aiDebunk.map((d, i) => (
                  <li key={i} className={f.aiDebunkItem}>
                    <div className={f.aiDebunkRow}>
                      <strong>{d.hypothesis}</strong>
                      <span className={f.aiDebunkScore}>{(d.plausibility * 100).toFixed(0)}%</span>
                    </div>
                    <span className={f.aiDebunkTest}>Test: {d.test}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <p className={f.note}>
        AI suggestions go through the server-side proxy — your prompts and floorplan never leave the device unencrypted.
        Every accepted question is appended to the audit chain so the post-roll knows what was asked and where.
      </p>
    </section>
  );
}
