/**
 * subagent-resilient.js — ✅ THE ANSWER.
 *
 * The resilient synthesis agent is handed a SCOPED `verify_fact` tool — a
 * narrow, bounded, read-only lookup against the LocalFactDatabase. It can
 * therefore resolve the ~85% of trivial fact-checks (dates, names, statistics)
 * LOCALLY, in-tool, without ever troubling the coordinator.
 *
 * Only when a claim is complex/exploratory (or genuinely absent from the
 * bounded local store) does the agent return a STRUCTURED `needs_verification`
 * result, delegating the heavy lifting up to the coordinator → web search
 * agent. This is least-privilege: the agent gets exactly the capability it
 * needs to stay fast, and nothing that could let it wander into infinite loops
 * or prompt dilution (which full web access would risk).
 *
 * Crucially, locally-resolved facts are written back into the shared answer
 * store so a coordinator re-invocation NEVER re-verifies them (idempotent),
 * and the agent only ever escalates the genuinely complex subset.
 *
 * Same `synthesize(task, ctx)` contract as the naive agent.
 */

import { TOKEN_COST, LATENCY, VerifyStatus } from './domain.js';
import { isSimpleFact } from './infrastructure.js';

const VIA_LOCAL = 'verify_fact(local)';

export class ResilientSynthesisAgent {
  constructor({ bus, scenario, metrics, verifyFact }) {
    this.bus = bus;
    this.scenario = scenario;
    this.metrics = metrics;
    this.verifyFact = verifyFact; // the scoped tool (dependency-injected)
    this.role = 'synthesis(resilient)';
  }

  async synthesize(task, ctx) {
    const answers = ctx.answers ?? new Map();

    this.metrics.inputTokens += TOKEN_COST.SYNTHESIS_PROMPT;
    this.metrics.latencyMs += LATENCY.SYNTHESIS_TICK;
    this.metrics.eventCount += 1;
    this.bus.emit({
      layer: 'agent:synthesis',
      scenario: this.scenario,
      kind: 'invoke',
      detail: `🧠 Resilient synthesis invoked on "${task.topic}"`,
      tokens: TOKEN_COST.SYNTHESIS_PROMPT,
      latencyMs: LATENCY.SYNTHESIS_TICK,
    });

    const findings = [];
    const pending = []; // claims that MUST escalate to the coordinator

    for (const claim of task.claims) {
      // Idempotent skip: already resolved (locally or by a prior hand-off).
      if (answers.has(claim.id)) {
        const a = answers.get(claim.id);
        findings.push(this._toFinding(claim, a));
        continue;
      }

      // 🛡️ Least-privilege fast path: try the scoped tool for simple facts.
      if (isSimpleFact(claim)) {
        const local = await this.verifyFact(claim); // mutates metrics via the tool
        if (local.status === VerifyStatus.OK) {
          const stored = {
            value: local.result.value,
            confidence: local.result.confidence,
            via: VIA_LOCAL,
          };
          // PERSIST so a re-invocation never re-verifies (idempotency).
          answers.set(claim.id, stored);
          findings.push(this._toFinding(claim, stored));
          continue;
        }
        // Tool miss → fall through to structured escalation (rare).
      }

      // Complex / exploratory, or local miss → ask the coordinator, but ONLY
      // for this subset. We batch these into a single structured request.
      this.bus.emit({
        layer: 'agent:synthesis',
        scenario: this.scenario,
        kind: 'escalate',
        detail: `↗️ Delegating complex claim "${claim.task}" to coordinator (bounded escalation)`,
        tokens: 0,
        latencyMs: 0,
      });
      pending.push(claim);
    }

    if (pending.length === 0) {
      this.bus.emit({
        layer: 'agent:synthesis',
        scenario: this.scenario,
        kind: 'completed',
        detail: `✅ Synthesis complete for "${task.topic}" — ${findings.length}/${task.claims.length} resolved locally`,
        tokens: 0,
        latencyMs: 0,
      });
      return { status: 'completed', pending: [], findings, attemptLog: ['all-local'] };
    }

    // Structured escalation: a typed, partial result, never a thrown exception.
    return {
      status: 'needs_verification',
      pending,
      findings,
      attemptLog: [`escalate ${pending.length} complex claim(s)`],
    };
  }

  _toFinding(claim, stored) {
    return {
      claimId: claim.id,
      topic: claim.task,
      value: stored?.value ?? null,
      via: stored?.via ?? 'unknown',
      confidence: stored?.confidence ?? 0,
    };
  }
}
