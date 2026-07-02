/**
 * subagent-naive.js — ❌ THE ANTI-PATTERN.
 *
 * The naive synthesis agent has NO local capability. Every time it encounters a
 * claim it must verify — even a trivial date/name/statistic — it surrenders
 * control back to the coordinator, which routes to the web search agent and
 * then re-invokes synthesis with the answer. Per the exam, this is the source
 * of the 2–3 extra round trips and the ~40% latency penalty.
 *
 * Here the agent returns exactly ONE unresolved claim per synthesis call,
 * forcing a fresh coordinator round trip (context replay + orchestration +
 * web search) for every single fact-check. This maximally exposes the cost.
 *
 * Same `synthesize(task, ctx)` contract as the resilient agent — the SAME
 * coordinator drives both, so the contrast is purely architectural.
 */

import { TOKEN_COST, LATENCY } from './domain.js';

export class NaiveSynthesisAgent {
  constructor({ bus, scenario, metrics }) {
    this.bus = bus;
    this.scenario = scenario;
    this.metrics = metrics;
    this.role = 'synthesis(naive)';
  }

  /**
   * @param {ResearchTask} task
   * @param {{ answers: Map<string, any> }} ctx shared answer store maintained by the coordinator
   * @returns {Promise<{status, pending, findings, attemptLog}>}
   */
  async synthesize(task, ctx) {
    const answers = ctx.answers ?? new Map();

    // A synthesis invocation always re-reads (replays) the full prompt context.
    this.metrics.inputTokens += TOKEN_COST.SYNTHESIS_PROMPT;
    this.metrics.latencyMs += LATENCY.SYNTHESIS_TICK;
    this.metrics.eventCount += 1;
    this.bus.emit({
      layer: 'agent:synthesis',
      scenario: this.scenario,
      kind: 'invoke',
      detail: `🧠 Naive synthesis invoked on "${task.topic}" (context replay)`,
      tokens: TOKEN_COST.SYNTHESIS_PROMPT,
      latencyMs: LATENCY.SYNTHESIS_TICK,
    });

    // Find the next claim we have NOT yet been given an answer for.
    const next = task.claims.find((c) => !answers.has(c.id));

    if (!next) {
      // Everything is verified → commit the synthesized output.
      const findings = task.claims.map((c) => {
        const a = answers.get(c.id);
        return {
          claimId: c.id,
          topic: c.task,
          value: a?.value ?? null,
          via: a?.via ?? 'coordinator→web_search',
          confidence: a?.confidence ?? 0.9,
        };
      });
      this.bus.emit({
        layer: 'agent:synthesis',
        scenario: this.scenario,
        kind: 'completed',
        detail: `✅ Synthesis complete for "${task.topic}" (after ${task.claims.length} hand-offs)`,
        tokens: 0,
        latencyMs: 0,
      });
      return { status: 'completed', pending: [], findings, attemptLog: this._log() };
    }

    // ❌ The anti-pattern: bounce EVERY trivial fact-check to the coordinator.
    this.bus.emit({
      layer: 'agent:synthesis',
      scenario: this.scenario,
      kind: 'escalate',
      detail: `↩️ Cannot verify "${next.task}" — returning control to coordinator (round trip)`,
      tokens: 0,
      latencyMs: 0,
    });
    return { status: 'needs_verification', pending: [next], findings: [], attemptLog: this._log() };
  }

  _log() {
    return [`naive hand-off #${this.metrics.coordinatorInterventions + 1}`];
  }
}
