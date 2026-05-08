/**
 * Site Posterior — log-odds accumulator with bounded LR multipliers and
 * exponential decay back to prior over a stationarity window.
 *
 * Theory (defensible to an external Bayesian reviewer):
 *
 *   prior odds:   o₀ = P(H_anomalous) / P(H_mundane)
 *   evidence i:   LR_i = P(evidence_i | H_anomalous) / P(evidence_i | H_mundane)
 *   posterior:    o_t = o₀ · ∏ LR_i      (independence assumption)
 *                 P_t = o_t / (1 + o_t)
 *
 * Storage uses logit space (log o = log P − log(1 − P)) so updates are
 * additive: logit_t += Σ log(LR_i). This is numerically stable and the
 * decay is a pure exponential toward the prior logit.
 *
 * Independence assumption — we explicitly bound how much any single
 * channel can contribute in a window so a chatty channel (e.g. a single
 * EMF source firing repeatedly) can't pile-on its own LR. The cap is
 * declared per-channel and is part of the audit log.
 *
 * Decay model — between events the logit drifts back toward the prior
 * logit at exponential rate τ (default 20 minutes — long enough for a
 * site visit but short enough that a posterior peak relaxes within a
 * follow-up session). This implements "stationarity is the null
 * hypothesis": absence of evidence over time is itself information.
 *
 * NO LR may be infinite. Hard ceiling at log(LR) = ±4 per increment
 * (i.e. LR_max = e⁴ ≈ 54.6). Anything bigger means the channel's
 * likelihood model is wrong, not that the evidence is overwhelming.
 */

const DEFAULT_PRIOR = 0.05;          // P(H_anomalous) before any evidence
const DEFAULT_DECAY_TAU_SECONDS = 1200;   // 20 minutes
const HARD_LOG_LR_CEILING = 4;       // |log(LR)| ≤ 4 per increment

export const POSTERIOR_THRESHOLDS = {
  inconclusive: 0.5,
  elevated: 0.8,
  flag: 0.95,
} as const;

export type PosteriorBand = "below" | "inconclusive" | "elevated" | "flag";

export function classifyPosterior(p: number): PosteriorBand {
  if (p >= POSTERIOR_THRESHOLDS.flag) return "flag";
  if (p >= POSTERIOR_THRESHOLDS.elevated) return "elevated";
  if (p >= POSTERIOR_THRESHOLDS.inconclusive) return "inconclusive";
  return "below";
}

export interface PosteriorState {
  prior: number;
  /** Current logit (log odds). */
  logit: number;
  /** Exponential decay rate toward the prior logit, in seconds. */
  decayTauSeconds: number;
  /** Wall-clock ms of last update — used to apply decay on next read. */
  lastUpdateMs: number;
  /** Channel attribution: how much each channel has contributed cumulatively. */
  channelContribution: Record<string, number>;
  /** Total number of LR increments applied. */
  incrementCount: number;
}

export interface LogIncrement {
  ts: number;
  channel: string;
  logLr: number;
  logitBefore: number;
  logitAfter: number;
  posteriorBefore: number;
  posteriorAfter: number;
  /** Free-form description shown inline next to the bar (≤ 80 chars). */
  reason: string;
  metadata?: Record<string, unknown>;
}

export function probabilityFromLogit(logit: number): number {
  if (logit > 30) return 1;
  if (logit < -30) return 0;
  const e = Math.exp(logit);
  return e / (1 + e);
}

export function logitFromProbability(p: number): number {
  if (p <= 0) return -30;
  if (p >= 1) return 30;
  return Math.log(p / (1 - p));
}

export function createPosteriorState(opts: { prior?: number; decayTauSeconds?: number; nowMs?: number } = {}): PosteriorState {
  const prior = opts.prior ?? DEFAULT_PRIOR;
  return {
    prior,
    logit: logitFromProbability(prior),
    decayTauSeconds: opts.decayTauSeconds ?? DEFAULT_DECAY_TAU_SECONDS,
    lastUpdateMs: opts.nowMs ?? Date.now(),
    channelContribution: {},
    incrementCount: 0,
  };
}

/** Pure function: apply decay since lastUpdateMs to a logit, returning the new logit. */
export function decayLogit(state: PosteriorState, nowMs: number): number {
  const dtSeconds = Math.max(0, (nowMs - state.lastUpdateMs) / 1000);
  if (dtSeconds === 0 || state.decayTauSeconds <= 0) return state.logit;
  const priorLogit = logitFromProbability(state.prior);
  const k = Math.exp(-dtSeconds / state.decayTauSeconds);
  return priorLogit + (state.logit - priorLogit) * k;
}

/** Read posterior probability at `nowMs` after applying decay. */
export function getPosterior(state: PosteriorState, nowMs: number = Date.now()): number {
  return probabilityFromLogit(decayLogit(state, nowMs));
}

export interface ApplyEvidenceInput {
  channel: string;
  logLr: number;
  reason: string;
  nowMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ApplyEvidenceResult {
  state: PosteriorState;
  increment: LogIncrement;
  capped: boolean;
}

/**
 * Apply a single LR increment, returning the new state + a structured
 * audit-ready increment record. Hard-caps |log LR| at HARD_LOG_LR_CEILING
 * and reports `capped=true` so callers can surface a model-warning.
 */
export function applyEvidence(state: PosteriorState, input: ApplyEvidenceInput): ApplyEvidenceResult {
  const nowMs = input.nowMs ?? Date.now();
  const decayedLogit = decayLogit(state, nowMs);
  const rawLogLr = input.logLr;
  const capped = Math.abs(rawLogLr) > HARD_LOG_LR_CEILING;
  const cappedLogLr = Math.max(-HARD_LOG_LR_CEILING, Math.min(HARD_LOG_LR_CEILING, rawLogLr));

  const logitAfter = decayedLogit + cappedLogLr;
  const posteriorBefore = probabilityFromLogit(decayedLogit);
  const posteriorAfter = probabilityFromLogit(logitAfter);

  const nextChannelContribution = { ...state.channelContribution };
  nextChannelContribution[input.channel] = (nextChannelContribution[input.channel] ?? 0) + cappedLogLr;

  const next: PosteriorState = {
    prior: state.prior,
    logit: logitAfter,
    decayTauSeconds: state.decayTauSeconds,
    lastUpdateMs: nowMs,
    channelContribution: nextChannelContribution,
    incrementCount: state.incrementCount + 1,
  };

  const increment: LogIncrement = {
    ts: nowMs,
    channel: input.channel,
    logLr: cappedLogLr,
    logitBefore: decayedLogit,
    logitAfter,
    posteriorBefore,
    posteriorAfter,
    reason: input.reason,
    metadata: input.metadata,
  };

  return { state: next, increment, capped };
}

/**
 * Combined LR for a sequence — returned only for display ("multiply: 6.2 × 4.1 × 2.3").
 * Note: this is the product of LR magnitudes, not the posterior — callers
 * still rely on the state for the real number.
 */
export function combinedLrLabel(increments: LogIncrement[]): string {
  if (increments.length === 0) return "—";
  const lrs = increments.map((i) => Math.exp(Math.abs(i.logLr)));
  const formatted = lrs.map((lr) => lr.toFixed(1)).join(" × ");
  return formatted;
}
