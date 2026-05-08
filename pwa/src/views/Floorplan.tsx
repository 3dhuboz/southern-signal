import { useCallback, useEffect, useRef, useState } from "react";
import s from "./View.module.css";
import f from "./Floorplan.module.css";

interface Stroke {
  points: { x: number; y: number }[];
  kind: "wall" | "marker";
  label?: string;
}

const STORAGE_KEY = "ss-floorplan-v1";

/**
 * Pure-Canvas floorplan sketcher. No maps API, no SLAM. Investigator
 * sketches rooms, marks anomaly locations as colored dots. State persists
 * to localStorage in V1. Migrates to OPFS+sqlite as cases per investigation
 * in V1.1.
 */
export function Floorplan() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Stroke[]) : [];
    } catch { return []; }
  });
  const [tool, setTool] = useState<"wall" | "marker">("wall");
  const drawing = useRef<Stroke | null>(null);

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

    // Subtle grid
    ctx.strokeStyle = "rgba(38, 46, 58, 0.6)";
    ctx.lineWidth = 1;
    const grid = 24;
    for (let x = 0; x < w; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Strokes
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      if (stroke.kind === "wall") {
        ctx.strokeStyle = "#9BA6B8";
        ctx.lineWidth = 3;
        ctx.beginPath();
        stroke.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
      } else if (stroke.kind === "marker") {
        const last = stroke.points[stroke.points.length - 1];
        ctx.fillStyle = "#5DF2C7";
        ctx.beginPath();
        ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(93, 242, 199, 0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [strokes]);

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

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = getPoint(e);
    if (tool === "marker") {
      setStrokes((s) => [...s, { kind: "marker", points: [point] }]);
      drawing.current = null;
      return;
    }
    drawing.current = { kind: "wall", points: [point] };
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || tool !== "wall") return;
    const point = getPoint(e);
    drawing.current.points.push(point);
    setStrokes((s) => {
      const next = [...s];
      const lastIdx = next.indexOf(drawing.current!);
      if (lastIdx === -1) next.push({ ...drawing.current! });
      else next[lastIdx] = { ...drawing.current! };
      return next;
    });
  };

  const handleUp = () => {
    drawing.current = null;
  };

  const undo = () => setStrokes((s) => s.slice(0, -1));
  const clear = () => setStrokes([]);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Floorplan</span>
        <h1 className={s.title}>Sketch the site</h1>
        <p className={s.lede}>Walls + anomaly markers. Pure pen-on-paper, no GPS or maps API.</p>
      </div>

      <div className={f.toolbar}>
        <button
          className={tool === "wall" ? f.toolActive : f.tool}
          onClick={() => setTool("wall")}
        >
          Wall
        </button>
        <button
          className={tool === "marker" ? f.toolActive : f.tool}
          onClick={() => setTool("marker")}
        >
          Marker
        </button>
        <button className={f.tool} onClick={undo} disabled={strokes.length === 0}>Undo</button>
        <button className={f.tool} onClick={clear} disabled={strokes.length === 0}>Clear</button>
      </div>

      <canvas
        ref={canvasRef}
        className={f.canvas}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      />

      <p className={f.note}>
        V1: floorplan persists to local storage on this device. V1.1 will scope it per-case in OPFS+sqlite, with anomaly markers tagged to actual sensor events.
      </p>
    </section>
  );
}
