/**
 * Site Posterior session — orchestrates a single investigation's posterior
 * lifecycle: prior, evidence application, audit-log hash-chain, recent-
 * increment ring buffer for the UI.
 *
 * Every posterior update fires an audit_log append with the full
 * before/after state + the channel + the reason — i.e. the exact data
 * a hostile journalist would need to reproduce the chain.
 */

import { appendAuditEntry } from "../db/auditLog";
import { applyEvidence, createPosteriorState, type ApplyEvidenceInput, type LogIncrement, type PosteriorState } from "./posterior";

export interface SiteSession {
  state: PosteriorState;
  recentIncrements: LogIncrement[];
}

export function createSiteSession(opts?: { prior?: number; decayTauSeconds?: number; nowMs?: number }): SiteSession {
  return {
    state: createPosteriorState(opts),
    recentIncrements: [],
  };
}

export async function applyAndAudit(session: SiteSession, input: ApplyEvidenceInput): Promise<{ session: SiteSession; capped: boolean }> {
  const result = applyEvidence(session.state, input);
  const next: SiteSession = {
    state: result.state,
    recentIncrements: [...session.recentIncrements, result.increment].slice(-12),
  };
  // Hash-chained audit entry.
  await appendAuditEntry({
    actor: "posterior",
    kind: `evidence.${input.channel}`,
    payload: {
      channel: input.channel,
      log_lr: result.increment.logLr,
      reason: input.reason,
      logit_before: result.increment.logitBefore,
      logit_after: result.increment.logitAfter,
      posterior_before: result.increment.posteriorBefore,
      posterior_after: result.increment.posteriorAfter,
      capped: result.capped,
      metadata: input.metadata ?? {},
    },
    ts: new Date(result.increment.ts).toISOString(),
  });
  return { session: next, capped: result.capped };
}
