/**
 * infrastructure.js — Simulated external services + typed error seams.
 *
 * Two capability surfaces exist, modelled on the exam:
 *
 *   1. LocalFactDatabase  → backs the scoped `verify_fact` tool. Fast, cheap,
 *      narrow, read-only. Only knows canonical simple facts (dates/names/stats).
 *
 *   2. WebSearchService   → the heavyweight exploratory capability owned by the
 *      dedicated web search agent. Expensive, broad, reached only through the
 *      coordinator. This is the path the naive approach uses for EVERYTHING.
 *
 * Typed errors act as architectural seams: callers branch programmatically on
 * `recoverable` instead of parsing message strings.
 */

import { Difficulty, VerifyStatus, TOKEN_COST, LATENCY } from './domain.js';

/** Base typed error carrying a `recoverable` architectural seam flag. */
export class AgentError extends Error {
  constructor(message, { recoverable = false, code = 'AGENT_ERROR', context = {} } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.recoverable = recoverable;
    this.context = context;
  }
}

/** Transient — caller should retry locally or degrade. NEVER bubble to coordinator. */
export class TransientError extends AgentError {
  constructor(message, context = {}) {
    super(message, { recoverable: true, code: 'TRANSIENT', context });
    this.name = 'TransientError';
  }
}

/** Fatal — caller must escalate with a structured result (never throw raw). */
export class FatalError extends AgentError {
  constructor(message, context = {}) {
    super(message, { recoverable: false, code: 'FATAL', context });
    this.name = 'FatalError';
  }
}

/**
 * The local fact store that powers the scoped `verify_fact` tool.
 * Read-only + canonical keys → it CANNOT wander into exploratory research,
 * which is what preserves least-privilege.
 */
export class LocalFactDatabase {
  constructor() {
    /** subject → { value, confidence } */
    this._store = new Map([
      ['inventor:transistor', { value: 'Bell Labs', confidence: 0.99 }],
      ['date:transistor-demo', { value: '1947', confidence: 0.99 }],
      ['people:transistor-inventors', { value: 'Bardeen/Brattain/Shockley', confidence: 0.98 }],
      ['concept:vacuum-tubes', { value: 'vacuum tubes', confidence: 0.97 }],
      ['date:tcp-ip-flag-day', { value: '1983-01-01', confidence: 0.99 }],
      ['people:tcp-ip-authors', { value: 'Cerf/Kahn', confidence: 0.99 }],
      ['concept:ncp', { value: 'NCP', confidence: 0.98 }],
      ['concept:ipv6-motivation', { value: '32-bit', confidence: 0.97 }],
      ['concept:crispr-immunity', { value: 'bacterial immune system', confidence: 0.98 }],
      ['date:crispr-nobel', { value: '2020', confidence: 0.99 }],
      ['concept:cas9', { value: 'Cas9', confidence: 0.99 }],
      ['concept:guide-rna', { value: 'guide RNA', confidence: 0.98 }],
      ['date:k8s-opensource', { value: '2014', confidence: 0.99 }],
      ['concept:borg', { value: 'Borg', confidence: 0.98 }],
      ['date:k8s-v1', { value: '2015-07', confidence: 0.98 }],
      ['concept:cncf', { value: 'CNCF', confidence: 0.99 }],
      ['paper:transformer', { value: 'Attention Is All You Need', confidence: 0.99 }],
      ['date:transformer-paper', { value: '2017', confidence: 0.99 }],
      ['concept:rnn', { value: 'RNN/LSTM', confidence: 0.98 }],
      ['concept:bert-gpt', { value: 'BERT/GPT', confidence: 0.99 }],
      ['concept:self-attention', { value: 'self-attention', confidence: 0.98 }],
    ]);
    // Complex / exploratory subjects are deliberately ABSENT — they cannot be
    // answered locally, which forces a clean escalation decision.
  }

  /** Resolve a simple fact. Returns null if unknown (→ escalate). */
  lookup(subject) {
    const hit = this._store.get(subject);
    if (!hit) return null;
    return { value: hit.value, confidence: hit.confidence, source: 'verify_fact(local)' };
  }
}

/** Lightweight, exploratory web search agent capability. */
export class WebSearchService {
  constructor() {
    this.calls = 0;
    this.latencyMs = LATENCY.WEB_SEARCH;
    this.tokens = TOKEN_COST.WEB_SEARCH_PROMPT;
  }

  /** Deep search for a complex/exploratory claim. Always succeeds in simulation. */
  async search(subject) {
    this.calls += 1;
    // Emulate the heavyweight nature of full exploration:
    return {
      value: `Deep synthesis for ${subject}`,
      confidence: 0.9,
      source: 'web_search(agent)',
      citations: [`https://research.example/${encodeURIComponent(subject)}`],
    };
  }
}

/**
 * A scoped `verify_fact` tool bound to a single LocalFactDatabase.
 *
 * This is THE architectural artifact of the recommended answer: a narrow,
 * bounded tool handed to the synthesis agent so it can resolve the 85% of
 * trivial fact-checks locally WITHOUT bouncing through the coordinator.
 */
export function createVerifyFactTool(db, bus, scenario, metrics) {
  /** @param {Claim} claim */
  return async function verifyFact(claim) {
    bus.emit({
      layer: 'tool:verify_fact',
      scenario,
      kind: 'tool_call',
      detail: `🔍 verify_fact(${claim.subject}) — local bounded lookup`,
      tokens: TOKEN_COST.VERIFY_FACT_TOOL,
      latencyMs: LATENCY.VERIFY_FACT_LOCAL,
    });
    // Tiny artificial delay to make the simulator timeline feel real.
    await new Promise((r) => setTimeout(r, LATENCY.VERIFY_FACT_LOCAL));

    const hit = db.lookup(claim.subject);
    metrics.inputTokens += TOKEN_COST.VERIFY_FACT_TOOL;
    metrics.latencyMs += LATENCY.VERIFY_FACT_LOCAL;
    metrics.eventCount += 1;

    if (hit) {
      // Local recovery: resolved without ever troubling the coordinator.
      metrics.claimsVerifiedLocally += 1;
      metrics.localRecoveries += 1;
      bus.emit({
        layer: 'tool:verify_fact',
        scenario,
        kind: 'local_recovery',
        detail: `✅ Local verified "${claim.subject}" → ${hit.value}`,
        tokens: 0,
        latencyMs: 0,
      });
      return { status: VerifyStatus.OK, claim, result: hit, via: 'verify_fact' };
    }

    // Subject genuinely absent from the bounded store → structured escalation.
    bus.emit({
      layer: 'tool:verify_fact',
      scenario,
      kind: 'miss',
      detail: `↗️ Not in local store (${claim.subject}) → escalate`,
      tokens: 0,
      latencyMs: 0,
    });
    return { status: VerifyStatus.ESCALATE, claim, result: null, via: 'verify_fact' };
  };
}

/** Helper: does this claim belong to the "simple" bucket the tool can serve? */
export function isSimpleFact(claim) {
  return claim.difficulty === Difficulty.SIMPLE;
}
