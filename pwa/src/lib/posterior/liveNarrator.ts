/**
 * Live narrator — builds plain-English observation strings from each
 * posterior LogIncrement and (optionally) speaks them via the browser's
 * SpeechSynthesis API.
 *
 * V1 uses local templating only — instant, offline, free. A later pass
 * can swap in a Sonnet call for richer narration.
 */

import { useEffect, useRef, useState } from "react";
import type { LogIncrement } from "./posterior";
import { describeChannel, describeSector } from "./plainEnglish";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function buildNarration(inc: LogIncrement): string {
  const ch = describeChannel(inc.channel);
  const meta = (inc.metadata ?? {}) as Record<string, unknown>;
  switch (inc.channel) {
    case "acoustic": {
      const sector = describeSector((meta.sector as string) ?? null);
      const opener = pick(["I'm hearing", "Just picked up", "Catching a sound"]);
      const where = sector ? ` from your ${sector}` : "";
      return `${opener}${where}.`;
    }
    case "infrasound": {
      const hz = typeof meta.peak_hz === "number" ? (meta.peak_hz as number).toFixed(1) : null;
      const sec = typeof meta.duration_s === "number" ? Math.round(meta.duration_s as number) : null;
      const tail = sec ? `, sustained ${sec} seconds` : "";
      return hz ? `Low-frequency pressure shift around ${hz} hertz${tail}.` : "Low-frequency pressure shift in the room.";
    }
    case "magnetometer": {
      const z = typeof meta.z_score === "number" ? Math.abs(meta.z_score as number).toFixed(1) : null;
      return z ? `Magnetic field spike — ${z} standard deviations above the room baseline.` : "Magnetic field anomaly.";
    }
    case "coupling": {
      const channels = (meta.coupled_channels as string[]) ?? [];
      const friendly = channels.map((c) => describeChannel(c).label.toLowerCase()).join(" and ");
      return `Two channels firing at once: ${friendly}. That's harder to explain than either alone.`;
    }
    case "contamination": {
      const tag = (meta.tag as string) ?? "interference";
      return `Tagged interference: ${tag.replace(/_/g, " ")}. Subtracting from the activity.`;
    }
    default:
      return `${ch.label} event.`;
  }
}

interface UseLiveNarratorOpts {
  /** Speak each narration via SpeechSynthesis. */
  speak?: boolean;
  /** How long the caption stays visible (ms). */
  captionMs?: number;
}

export function useLiveNarrator(recentIncrements: LogIncrement[], opts: UseLiveNarratorOpts = {}) {
  const { speak = false, captionMs = 7000 } = opts;
  const [caption, setCaption] = useState<string | null>(null);
  const lastCountRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (recentIncrements.length === lastCountRef.current) return;
    if (recentIncrements.length === 0) return;
    lastCountRef.current = recentIncrements.length;
    const last = recentIncrements[recentIncrements.length - 1];
    const text = buildNarration(last);
    setCaption(text);
    if (speak && typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        // Cancel anything still queued so we don't pile up.
        if (utteranceRef.current) speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 0.9;
        utteranceRef.current = u;
        speechSynthesis.speak(u);
      } catch { /* ignore */ }
    }
    const t = window.setTimeout(() => setCaption(null), captionMs);
    return () => window.clearTimeout(t);
  }, [recentIncrements, speak, captionMs]);

  return caption;
}
