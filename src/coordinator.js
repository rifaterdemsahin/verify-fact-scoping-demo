/**
 * coordinator.js — The orchestrator.
 *
 * ONE coordinator implementation drives BOTH the naive and resilient
 * synthesis agents through the identical duck-typed `synthesize(task, ctx)`
 * contract. The architectural difference lives entirely inside the agents
 * (capability scoping), which is exactly the point the demo makes.
 *
 * Responsibilities:
 *   - Invoke the synthesis agent.
 *   - On a structured `needs_verification` result, broker the hand-off to the
 *     web search agent, then re-invoke synthesis with the new answers.
 *   - Enforce a bounded-retry circuit breaker (MAX_ROUNDS) so a misbehaving
 *     agent can never trigger an infinite hand-off loop.
 *   - Charge the coordinator's own orchestration overhead (tokens + latency)
 *     to the active scenario's metrics, making the cost contrast honest.
 */

import { TOKEN_COST, LATENCY } from './domain.js';

/** Loop safety — any well-scoped agent terminates well below this. */
const MAX_ROUNDS = 12;

export class Coordinator {
  constructor({ bus, scenario, metrics, webSearch }) {
    this.bus = bus;
    this.scenario = scenario; // 'naive' | 'resilient'
    this.metrics = metrics;
    this.webSearch = webSearch;
    this.role = 'coordinator';
  }

  /**
   * Run a single research task to completion (or bounded failure).
   * @param {ResearchTask} task
   * @param {(task, ctx) => Promise<any>} synthesisAgent.synthesize bound contract
   * @param {object} agent must expose `synthesize(task, ctx)`
   */
  async run(task, agent) {
    const ctx = { answers: new Map() };
    let depth = 0;
    let result;

    this.bus.emit({
      layer: 'coordinator',
      scenario: this.scenario,
      kind: 'task_start',
      detail: `🎯 Coordinator dispatched "${task.topic}" (${task.claims.length} claims)`,
      tokens: 0,
      latencyMs: 0,
    });

    while (depth < MAX_ROUNDS) {
      depth += 1;
      this.metrics.maxReentrancy = Math.max(this.metrics.maxReentrancy, depth);

      result = await agent.synthesize(task, ctx);

      if (result.status === 'completed') {
        this.metrics.tasksCompleted += 1;
        this.metrics.claimsTotal += task.claims.length;
        return result;
      }

      // Structured escalation: broker every pending claim via the web search agent.
      for (const claim of result.pending) {
        this.metrics.coordinatorInterventions += 1;
        this.metrics.roundTrips += 1;
        this.metrics.claimsEscalated += 1;

        // Coordinator orchestration bookkeeping cost.
        this.metrics.inputTokens += TOKEN_COST.COORDINATOR_OVERHEAD;
        this.metrics.latencyMs += LATENCY.COORDINATOR_HANDOFF;
        this.metrics.eventCount += 1;
        this.bus.emit({
          layer: 'coordinator',
          scenario: this.scenario,
          kind: 'handoff',
          detail: `🔀 Coordinator hand-off → web search agent for "${claim.task}"`,
          tokens: TOKEN_COST.COORDINATOR_OVERHEAD,
          latencyMs: LATENCY.COORDINATOR_HANDOFF,
        });

        // Delegate to the heavyweight web search agent.
        const answer = await this.webSearch.search(claim.subject);
        this.metrics.inputTokens += TOKEN_COST.WEB_SEARCH_PROMPT;
        this.metrics.latencyMs += this.webSearch.latencyMs;
        this.metrics.eventCount += 1;
        this.bus.emit({
          layer: 'agent:web_search',
          scenario: this.scenario,
          kind: 'search',
          detail: `🌐 Web search agent resolved "${claim.subject}"`,
          tokens: TOKEN_COST.WEB_SEARCH_PROMPT,
          latencyMs: this.webSearch.latencyMs,
        });

        // Store a uniform, source-tagged answer so the agent's idempotency
        // check works and findings carry the right provenance.
        ctx.answers.set(claim.id, {
          value: answer.value,
          confidence: answer.confidence,
          via: 'coordinator→web_search',
          citations: answer.citations ?? [],
        });
      }
      // Loop: re-invoke synthesis (its next call replays full context = cost).
    }

    // Bounded-failure path — never an uncaught exception, never an infinite loop.
    this.metrics.tasksFailed += 1;
    this.bus.emit({
      layer: 'coordinator',
      scenario: this.scenario,
      kind: 'circuit_open',
      detail: `🛑 Circuit breaker opened for "${task.topic}" after ${MAX_ROUNDS} rounds`,
      tokens: 0,
      latencyMs: 0,
    });
    return {
      status: 'failed',
      pending: result?.pending ?? [],
      findings: result?.findings ?? [],
      attemptLog: [`circuit-broken@${MAX_ROUNDS}`],
      errorContext: { rounds: MAX_ROUNDS },
    };
  }
}

/**
 * Run the full workload through a fresh agent+coordinator pair, returning the
 * aggregate metrics + the structured event trace (for CLI tables & web sim).
 */
export async function runScenario({ scenario, workload, buildAgent, buildMetrics }) {
  const { EventBus, emptyMetrics } = await import('./utils.js');
  const bus = new EventBus();
  const metrics = { ...emptyMetrics(), scenario };

  // Fresh infra per scenario so call counters never bleed across runs.
  const { LocalFactDatabase, WebSearchService, createVerifyFactTool } = await import('./infrastructure.js');
  const db = new LocalFactDatabase();
  const webSearch = new WebSearchService();
  const verifyFact = createVerifyFactTool(db, bus, scenario, metrics);
  const coordinator = new Coordinator({ bus, scenario, metrics, webSearch });
  const agent = buildAgent({ bus, scenario, metrics, verifyFact });

  for (const task of workload) {
    await coordinator.run(task, agent);
  }

  // Reliability: claims resolved (local + escalated) over total claims seen.
  metrics.successRate =
    metrics.claimsTotal > 0
      ? Number(((metrics.claimsVerifiedLocally + metrics.claimsEscalated) / metrics.claimsTotal).toFixed(3))
      : 0;

  return { scenario, metrics, trace: bus.log };
}
