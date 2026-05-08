/**
 * Channel likelihood models — explicit, defensible, parameterized.
 *
 * Each channel emits an `Evidence` (a `logLr` + `reason` string) when its
 * detector fires. The likelihood model is the thing an external Bayesian
 * reviewer signs off on, so the parameters here are not magic numbers —
 * they're declared with rationale at the top of each model and a clear
 * statement of what they assume.
 *
 * The hard ceiling on |log LR| in posterior.ts protects against any
 * runaway value here.
 */

export interface EvidenceEmission {
  channel: string;
  logLr: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

// ----------------------------------------------------------------------
// Channel A — Acoustic transient with sub-band coherence
// ----------------------------------------------------------------------
//
// Detector: SRP-PHAT-ish stereo cross-correlation produces a sector
// estimate + a coherence score in [0, 1]. We require coherence > 0.7
// AND peak persistence across ≥3 non-adjacent sub-bands (handled in
// the detector). On fire, this channel contributes one Evidence.
//
// Likelihood model (rationale):
//   P(transient with coh ≥ 0.7 + ≥3 bands | mundane site noise): rare.
//   Empirical estimate from stage baselines (HVAC, traffic): ~0.04 per
//   60s sample window.
//   P(transient with coh ≥ 0.7 + ≥3 bands | actual localised acoustic
//   source): ~0.80 (we miss some due to reverb).
//   LR = 0.80 / 0.04 = 20  → log LR ≈ 3.0
//
// The +3.0 fires only on the FIRST fire in a 30-second window; subsequent
// fires of this channel inside the window contribute log LR = 1.0 (LR
// ~2.7) — this prevents a chatty channel from piling up.

export function emitAcousticTransient(opts: {
  coherence: number;
  subBandsAgreed: number;
  sector: string;
  sectorPersistedFromPrior: boolean;
  isFirstInWindow: boolean;
}): EvidenceEmission | null {
  if (opts.coherence < 0.7 || opts.subBandsAgreed < 3) return null;
  const baseLogLr = opts.isFirstInWindow ? 3.0 : 1.0;
  const persistenceBonus = opts.sectorPersistedFromPrior ? 1.4 : 0;
  const logLr = baseLogLr + persistenceBonus;
  const reason = opts.sectorPersistedFromPrior
    ? `Acoustic transient ${opts.sector}, sector persistence from prior event`
    : `Acoustic transient ${opts.sector}, coh ${opts.coherence.toFixed(2)}, ${opts.subBandsAgreed} bands`;
  return {
    channel: "acoustic",
    logLr,
    reason,
    metadata: {
      sector: opts.sector,
      coherence: opts.coherence,
      sub_bands: opts.subBandsAgreed,
      persisted: opts.sectorPersistedFromPrior,
    },
  };
}

// ----------------------------------------------------------------------
// Channel B — Infrasound pressure-pulse from AGC envelope
// ----------------------------------------------------------------------
//
// Detector: 0.5–18 Hz bandpassed envelope (recovered from RMS of audio,
// not the codec-stripped low frequencies). Sustained narrowband peak
// 7–19 Hz for ≥10 s in the rolling baseline frame.
//
// Likelihood model:
//   P(sustained 7–19Hz envelope peak | mundane room): low but nonzero —
//   HVAC fans, distant traffic, wind buffet can all produce sustained
//   peaks. Empirical: ~0.10 per 60s sample window in indoor spaces.
//   P(sustained 7–19Hz peak | actual localised infrasound source): ~0.55.
//   LR = 5.5  → log LR ≈ 1.7

export function emitInfrasoundPulse(opts: {
  peakHz: number;
  durationSeconds: number;
  envelopeDb: number;
  baselineEnvelopeDb: number;
}): EvidenceEmission | null {
  if (opts.peakHz < 7 || opts.peakHz > 19) return null;
  if (opts.durationSeconds < 10) return null;
  if (opts.envelopeDb - opts.baselineEnvelopeDb < 6) return null;
  return {
    channel: "infrasound",
    logLr: 1.7,
    reason: `Infrasound peak ${opts.peakHz.toFixed(1)} Hz sustained ${opts.durationSeconds.toFixed(0)}s, +${(opts.envelopeDb - opts.baselineEnvelopeDb).toFixed(1)} dB above baseline`,
    metadata: {
      peak_hz: opts.peakHz,
      duration_s: opts.durationSeconds,
      delta_db: opts.envelopeDb - opts.baselineEnvelopeDb,
    },
  };
}

// ----------------------------------------------------------------------
// Channel C — EMF / Magnetometer (Android only) anomaly
// ----------------------------------------------------------------------
//
// Detector: rolling Welford z-score on |B| (magnetic field magnitude).
// Fire when |z| > 3 sustained for ≥200 ms.
//
// Likelihood model:
//   P(z > 3 transient | mundane indoor environment): ~0.05 per 60s.
//     (Lots of mundane causes: walking past wiring, fluorescent ballasts,
//      microwave kicks, motors — not paranormal but also not "natural baseline".)
//   P(z > 3 transient | localised EM-type anomaly): ~0.65.
//   LR = 13  → log LR ≈ 2.6

export function emitMagnetometerAnomaly(opts: {
  zScore: number;
  magnitudeMicrotesla: number;
  baselineMicrotesla: number;
}): EvidenceEmission | null {
  if (Math.abs(opts.zScore) < 3) return null;
  return {
    channel: "magnetometer",
    logLr: 2.6,
    reason: `EMF z=${opts.zScore.toFixed(1)}, |B|=${opts.magnitudeMicrotesla.toFixed(1)} μT (baseline ${opts.baselineMicrotesla.toFixed(1)} μT)`,
    metadata: {
      z_score: opts.zScore,
      magnitude_uT: opts.magnitudeMicrotesla,
      baseline_uT: opts.baselineMicrotesla,
    },
  };
}

// ----------------------------------------------------------------------
// Channel D — Cross-channel temporal coupling (the most important channel)
// ----------------------------------------------------------------------
//
// Detector: when two independent channels (acoustic + magnetometer, or
// acoustic + infrasound) fire within 200 ms of each other, emit a
// COUPLING event. Independence makes this much more informative than
// either channel alone.
//
// Likelihood model:
//   P(coupling within 200 ms | mundane): negligible — base rate of any
//   single channel firing is ~0.05–0.10 per 60s; coincidence within
//   200ms = ~3×10⁻⁴ × number of channels. Practically: ~0.001 per event.
//   P(coupling within 200ms | actual physical event affecting both modalities): ~0.35
//   LR = 350  → log LR ≈ 5.86 — but capped at 4.0 by posterior.ts.
//
// We declare 2.3 here (LR ~10) as a conservative single-event contribution
// and let the LR ceiling protect against repeated firings.

export function emitTemporalCoupling(opts: {
  channels: string[];
  deltaMs: number;
}): EvidenceEmission | null {
  if (opts.channels.length < 2 || opts.deltaMs > 200) return null;
  return {
    channel: "coupling",
    logLr: 2.3,
    reason: `Temporal coupling: ${opts.channels.join(" + ")} within ${opts.deltaMs.toFixed(0)} ms`,
    metadata: { coupled_channels: opts.channels, delta_ms: opts.deltaMs },
  };
}

// ----------------------------------------------------------------------
// Channel E — Contamination penalty (MUNDANE EVIDENCE)
// ----------------------------------------------------------------------
//
// When the investigator tags an event as a known mundane cause (HVAC kick,
// vehicle pass, voice contamination), we apply a NEGATIVE log LR to the
// posterior — explicit evidence FOR mundanity.

export function emitContamination(opts: {
  tag: string;
  appliesToWindowSeconds: number;
}): EvidenceEmission {
  const logLr = -3.0;
  return {
    channel: "contamination",
    logLr,
    reason: `Contamination flagged: ${opts.tag} (window ${opts.appliesToWindowSeconds.toFixed(0)}s)`,
    metadata: { tag: opts.tag, window_s: opts.appliesToWindowSeconds },
  };
}
