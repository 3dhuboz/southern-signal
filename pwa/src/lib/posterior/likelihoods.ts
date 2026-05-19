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

import type { BaselineSummary } from "./sessionBaseline";

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
  /** Current rolling RMS of the audio frame the transient was detected
   *  on. Required for the baseline-aware path; pass null when unavailable
   *  (e.g. synthesized fallback signals like the sensor-vibration path). */
  audioRms?: number | null;
  /** Optional captured site baseline (the same struct the magnetometer
   *  channel uses). When supplied with a non-zero audioRmsP95, transients
   *  whose rolling RMS is at or below the site's measured noise floor are
   *  REFUSED — site noise, not anomalies. Bonus when above audioRmsMax. */
  siteBaseline?: BaselineSummary | null;
}): EvidenceEmission | null {
  if (opts.coherence < 0.7 || opts.subBandsAgreed < 3) return null;

  const site = opts.siteBaseline;
  let aboveSiteP95 = false;
  let aboveSiteMax = false;
  let baselineNote = "";
  if (site && site.audioRmsP95 > 0 && typeof opts.audioRms === "number" && Number.isFinite(opts.audioRms)) {
    if (opts.audioRms <= site.audioRmsP95) {
      // Within the site's measured noise floor — refuse, even if the
      // detector's coherence + sub-band gates passed. The site baseline
      // is a longer, calmer reference than any single-frame coherence
      // peak and trumps it.
      //
      // NOTE: this RMS comparison is GATING ONLY (null vs not-null). It
      // does NOT contribute additive log-LR evidence. See the comment
      // below on the removed RMS-novelty bonus for why this matters.
      return null;
    }
    aboveSiteP95 = true;
    if (opts.audioRms > site.audioRmsMax) {
      aboveSiteMax = true;
    }
    baselineNote = `, RMS ${opts.audioRms.toFixed(3)} > site p95 ${site.audioRmsP95.toFixed(3)}${aboveSiteMax ? ` (above site max ${site.audioRmsMax.toFixed(3)})` : ""}`;
  }

  // Self-coupling decouple (2026-05-19, panel P1):
  //
  // The previous implementation added a +0.5 "novelty above site max" bonus
  // when `audioRms > site.audioRmsMax`. That term is REMOVED because it
  // double-counts evidence already in the pipeline:
  //
  //   1. LiveAnalyzer gates the transient firing on `rms - rollingRms >
  //      transientThreshold` (liveAnalyzer.ts L159). The baseLogLr of 3.0
  //      is calibrated for the fact that RMS deviation already cleared a
  //      threshold.
  //   2. The site-baseline GATE above (audioRms <= p95 → null) uses the
  //      same audio RMS. That gate is fine because it REMOVES candidates,
  //      not ADDS log-LR.
  //   3. Adding a further +0.5 bonus on `audioRms > site.audioRmsMax`
  //      treats the same RMS signal as a THIRD piece of independent
  //      evidence — which it isn't. An external Bayesian reviewer would
  //      reject this as a violation of the independence assumption stated
  //      at the top of posterior.ts.
  //
  // The novelty signal we still want — "this transient is unusually
  // strong for this site" — now comes from a feature ORTHOGONAL to RMS:
  // the spectral coherence value already required by the detector's first
  // gate. High coherence (≥ 0.85) means a tightly-localised acoustic
  // source above the 0.7 minimum gate; it's genuinely orthogonal to the
  // RMS magnitude. The +0.5 magnitude is preserved — we're moving the
  // bonus from a self-coupled signal to an orthogonal one.
  const coherenceNoveltyBonus = opts.coherence >= 0.85 ? 0.5 : 0;

  const baseLogLr = opts.isFirstInWindow ? 3.0 : 1.0;
  const persistenceBonus = opts.sectorPersistedFromPrior ? 1.4 : 0;
  const logLr = baseLogLr + persistenceBonus + coherenceNoveltyBonus;
  const reason = opts.sectorPersistedFromPrior
    ? `Acoustic transient ${opts.sector}, sector persistence from prior event${baselineNote}`
    : `Acoustic transient ${opts.sector}, coh ${opts.coherence.toFixed(2)}, ${opts.subBandsAgreed} bands${baselineNote}`;
  return {
    channel: "acoustic",
    logLr,
    reason,
    metadata: {
      sector: opts.sector,
      coherence: opts.coherence,
      sub_bands: opts.subBandsAgreed,
      persisted: opts.sectorPersistedFromPrior,
      audio_rms: typeof opts.audioRms === "number" ? opts.audioRms : null,
      site_audio_rms_p95: site?.audioRmsP95 ?? null,
      site_audio_rms_max: site?.audioRmsMax ?? null,
      above_site_p95: aboveSiteP95,
      // `above_site_max` is retained in audit metadata for transparency,
      // but it NO LONGER adds to logLr — see "Self-coupling decouple"
      // comment above. The actual novelty contribution comes from
      // `coherence_novelty_bonus`, which is RMS-orthogonal.
      above_site_max: aboveSiteMax,
      coherence_novelty_bonus: coherenceNoveltyBonus,
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
//
// Optional `siteBaseline` — when the operator has captured an empty-room
// baseline for this site, a stricter floor applies:
//   - Readings at or below the site's emfP95 are treated as site noise,
//     not anomalies, and the channel REFUSES to fire (returns null) even
//     if the rolling z-score crossed 3. The rolling z-score is sensitive
//     to short-window noise; the site p95 is a longer, calmer reference
//     and trumps it.
//   - Readings exceeding the site's emfMax — i.e. higher than anything
//     observed during a deliberate quiet calibration — get a small +0.5
//     bonus for "novelty above all observed baseline." Capped by the
//     posterior |log LR| ceiling.
// When no baseline is supplied, behaviour is identical to the original
// detector — no regression for operators who skip baseline capture.

export function emitMagnetometerAnomaly(opts: {
  zScore: number;
  magnitudeMicrotesla: number;
  baselineMicrotesla: number;
  siteBaseline?: BaselineSummary | null;
}): EvidenceEmission | null {
  if (Math.abs(opts.zScore) < 3) return null;

  const site = opts.siteBaseline;
  let logLr = 2.6;
  let baselineNote = "";
  let aboveSiteP95 = false;
  let aboveSiteMax = false;
  if (site && site.emfP95 > 0) {
    if (opts.magnitudeMicrotesla <= site.emfP95) {
      // Within the site's measured noise floor — refuse, don't pile-on.
      return null;
    }
    aboveSiteP95 = true;
    if (opts.magnitudeMicrotesla > site.emfMax) {
      aboveSiteMax = true;
      logLr += 0.5;
    }
    baselineNote = `, site p95=${site.emfP95.toFixed(1)} μT${aboveSiteMax ? ` (above site max ${site.emfMax.toFixed(1)})` : ""}`;
  }

  return {
    channel: "magnetometer",
    logLr,
    reason: `EMF z=${opts.zScore.toFixed(1)}, |B|=${opts.magnitudeMicrotesla.toFixed(1)} μT (baseline ${opts.baselineMicrotesla.toFixed(1)} μT)${baselineNote}`,
    metadata: {
      z_score: opts.zScore,
      magnitude_uT: opts.magnitudeMicrotesla,
      baseline_uT: opts.baselineMicrotesla,
      site_emf_p95_uT: site?.emfP95 ?? null,
      site_emf_max_uT: site?.emfMax ?? null,
      above_site_p95: aboveSiteP95,
      above_site_max: aboveSiteMax,
    },
  };
}

// ----------------------------------------------------------------------
// Channel D — Cross-channel temporal coupling (the most important channel)
// ----------------------------------------------------------------------
//
// Detector: when two INDEPENDENT channels fire within 200 ms of each
// other, emit a COUPLING event. Independence makes this much more
// informative than either channel alone.
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
//
// Channel-independence rule (2026-05-19, panel P1 self-coupling fix):
//
// "Independent" is the load-bearing word. Channels that share a physical
// signal-chain do NOT qualify. The `acoustic` and `infrasound` channels
// are BOTH derived from the audio RMS sequence — see infrasound.ts where
// InfrasoundDetector.pushFrameRms takes the very same `rms` value that
// the acoustic transient detector gates on in liveAnalyzer.ts L159.
// Firing a coupling event on `acoustic + infrasound` therefore triple-
// counts the same audio-RMS spike:
//
//   1. acoustic channel: +3.0 (already cleared an RMS-deviation gate)
//   2. infrasound channel: +1.7 (FFT peak in envelope-of-same-RMS)
//   3. coupling: +2.3 (firing because both fired within 200 ms — but
//      the simultaneity is GUARANTEED by the shared RMS source, not by
//      an independent physical event affecting two modalities)
//
// `acoustic + magnetometer` IS genuinely independent (mic + magnetometer
// are different hardware sensors with different physics), so that
// coupling remains valid.
//
// The rule is enforced here, in the likelihood, rather than at each
// call-site so a future caller can't accidentally re-introduce the bug.

/** Channels that share the audio RMS signal chain and are NOT independent. */
const AUDIO_CHAIN_CHANNELS = new Set(["acoustic", "infrasound"]);

function shareAudioChain(channels: string[]): boolean {
  let count = 0;
  for (const c of channels) if (AUDIO_CHAIN_CHANNELS.has(c)) count += 1;
  return count >= 2;
}

export function emitTemporalCoupling(opts: {
  channels: string[];
  deltaMs: number;
}): EvidenceEmission | null {
  if (opts.channels.length < 2 || opts.deltaMs > 200) return null;
  // Independence assumption: refuse couplings between channels that share
  // the audio signal chain — they're not independent evidence, just the
  // same RMS spike appearing in two derived channels.
  if (shareAudioChain(opts.channels)) return null;
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
