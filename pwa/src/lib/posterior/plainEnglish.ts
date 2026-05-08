/**
 * Translators that convert the technical posterior model into plain
 * English for Simple mode. The math is unchanged; only the labels are.
 */

export interface ActivityBand {
  id: "calm" | "light" | "possible" | "notable" | "strong";
  label: string;
  hint: string;
}

export function describeActivity(posterior: number): ActivityBand {
  if (posterior < 0.3) {
    return { id: "calm", label: "Calm", hint: "Nothing unusual right now." };
  }
  if (posterior < 0.5) {
    return { id: "light", label: "Light activity", hint: "A few small readings — could easily be normal." };
  }
  if (posterior < 0.7) {
    return { id: "possible", label: "Possible activity", hint: "Worth paying attention. Try a respectful question." };
  }
  if (posterior < 0.9) {
    return { id: "notable", label: "Notable activity", hint: "Multiple readings stacking up. Check for normal causes." };
  }
  return { id: "strong", label: "Strong activity", hint: "Many corroborating readings. Treat as flagged for review." };
}

export function describeChannel(channel: string): { label: string; emoji: string } {
  switch (channel) {
    case "acoustic":      return { label: "Sound",            emoji: "🔊" };
    case "infrasound":    return { label: "Pressure shift",   emoji: "🌬️" };
    case "magnetometer":  return { label: "Magnetic anomaly", emoji: "🧲" };
    case "coupling":      return { label: "Multiple signals at once", emoji: "✦" };
    case "contamination": return { label: "Marked as interference", emoji: "—" };
    case "marker":        return { label: "Marker dropped",   emoji: "📍" };
    default:              return { label: channel,            emoji: "·" };
  }
}

/**
 * Strip technical fragments from a reason string so amateurs see what
 * happened, not the SI numbers. Heuristic — keeps the sector + the kind
 * of event, drops dB / coh / band counts / log LR.
 */
export function plainEnglishReason(reason: string): string {
  return reason
    .replace(/,?\s*coh \d+\.\d+/gi, "")
    .replace(/,?\s*\d+ bands?/gi, "")
    .replace(/sustained \d+s/gi, "lasting a few seconds")
    .replace(/\+\d+\.\d+ dB above baseline/gi, "above baseline")
    .replace(/log LR \+?-?\d+\.\d+/gi, "")
    .replace(/window \d+s/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s,/g, ",")
    .replace(/,\s*$/g, "")
    .trim();
}

/** Friendly directional gloss for sector codes. */
export function describeSector(sector: string | null): string {
  if (!sector) return "";
  switch (sector) {
    case "FRONT-L":  return "front-left";
    case "FRONT-C":  return "front, centred";
    case "FRONT-R":  return "front-right";
    case "REAR-L":   return "behind-left";
    case "REAR-C":   return "behind you";
    case "REAR-R":   return "behind-right";
    default:         return sector.toLowerCase();
  }
}
