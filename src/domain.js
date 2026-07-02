/**
 * domain.js — Domain model & reproducible research workload.
 *
 * Dependency direction (no cycles):
 *   domain  ←  infrastructure  ←  subagent-*  ←  coordinator  ←  demo
 *
 * Entities model a Multi-Agent Research System:
 *   - ResearchTask: a synthesis job the coordinator hands to the synthesis agent.
 *   - Claim: an atomic factual assertion the synthesis agent must verify before
 *            committing it to the synthesized output.
 *   - Difficulty: 'simple' (date / name / statistic → local verify_fact)
 *                 'complex' (needs exploration → coordinator → web search agent).
 *
 * The workload is deliberately seeded so that ~85% of verifications are simple
 * fact-checks and ~15% require deeper investigation, matching the exam prompt.
 */

/** Difficulty buckets. */
export const Difficulty = Object.freeze({
  SIMPLE: 'simple', // local verify_fact tool resolves it
  COMPLEX: 'complex', // must escalate to coordinator → web search agent
});

/** Lifecycle status for a verification result (architectural seam). */
export const VerifyStatus = Object.freeze({
  OK: 'ok',
  ESCALATE: 'escalate', // synthesis asks the coordinator for a deep search
  FAILED: 'failed',
});

/**
 * A research claim embedded in a synthesis task.
 * @typedef {Object} Claim
 * @property {string} id
 * @property {string} task
 * @property {string} expected        Ground-truth answer (for the local fact DB).
 * @property {'simple'|'complex'} difficulty
 * @property {string} subject         Canonical fact key the local DB indexes on.
 */

/**
 * A synthesis task: produces a synthesized finding once all its claims verify.
 * @typedef {Object} ResearchTask
 * @property {string} id
 * @property {string} topic
 * @property {Claim[]} claims
 */

/** Deterministic reproducible seed of research tasks / claims. */
export const WORKLOAD = Object.freeze(buildWorkload());

/** Token-cost model — the heart of the input-token efficiency argument.
 *  These are the per-operation *input* token costs the architecture pays.
 *  Tuned to realistic multi-agent proportions: re-invocations replay full
 *  context, while a scoped tool call replays almost nothing. */
export const TOKEN_COST = Object.freeze({
  SYNTHESIS_PROMPT: 1200, // one synthesis invocation input (task + context + prior findings)
  COORDINATOR_OVERHEAD: 250, // orchestrator bookkeeping per hand-off round trip
  WEB_SEARCH_PROMPT: 450, // web search agent input tokens per delegated query
  VERIFY_FACT_TOOL: 70, // scoped local tool call input — only the fact key + schema
});

/** Simulated latency model (deterministic-ish, ms). */
export const LATENCY = Object.freeze({
  SYNTHESIS_TICK: 90, // per synthesis invocation
  COORDINATOR_HANDOFF: 400, // serialize → route → deserialize
  WEB_SEARCH: 350, // deep exploratory search
  VERIFY_FACT_LOCAL: 60, // local fact lookup
});

/** Build the canonical 85/15 workload deterministically. */
function buildWorkload() {
  const tasks = [];
  const claims = [
    // ---- Task A: History of the transistor ----
    ['A1', 'The transistor was invented at Bell Labs.', 'Bell Labs', Difficulty.SIMPLE, 'inventor:transistor'],
    ['A2', 'It was first demonstrated in December 1947.', '1947', Difficulty.SIMPLE, 'date:transistor-demo'],
    ['A3', 'The co-inventors include Bardeen, Brattain and Shockley.', 'Bardeen/Brattain/Shockley', Difficulty.SIMPLE, 'people:transistor-inventors'],
    ['A4', 'It revolutionized electronics by replacing bulky vacuum tubes.', 'vacuum tubes', Difficulty.SIMPLE, 'concept:vacuum-tubes'],
    ['A5', 'Its invention triggered a cascade of competing semiconductor firms and fabs across the 1950s.', 'exploratory', Difficulty.COMPLEX, 'explore:semiconductor-ecosystem'],
    // ---- Task B: TCP/IP ----
    ['B1', 'TCP/IP was adopted as the ARPANET standard on January 1, 1983.', '1983-01-01', Difficulty.SIMPLE, 'date:tcp-ip-flag-day'],
    ['B2', 'Vint Cerf and Bob Kahn designed the protocol suite.', 'Cerf/Kahn', Difficulty.SIMPLE, 'people:tcp-ip-authors'],
    ['B3', 'It replaced the earlier NCP protocol.', 'NCP', Difficulty.SIMPLE, 'concept:ncp'],
    ['B4', 'IPv6 was developed to address exhaustion of the 32-bit address space.', '32-bit', Difficulty.SIMPLE, 'concept:ipv6-motivation'],
    ['B5', 'The evolution of global routing shaped the modern internet economy and peering politics.', 'exploratory', Difficulty.COMPLEX, 'explore:global-routing-economy'],
    // ---- Task C: CRISPR ----
    ['C1', 'CRISPR was first described as a bacterial immune system.', 'bacterial immune system', Difficulty.SIMPLE, 'concept:crispr-immunity'],
    ['C2', 'Jennifer Doudna and Emmanuelle Charpentier shared the 2020 Nobel Prize in Chemistry for it.', '2020', Difficulty.SIMPLE, 'date:crispr-nobel'],
    ['C3', 'Cas9 is the protein that cuts DNA.', 'Cas9', Difficulty.SIMPLE, 'concept:cas9'],
    ['C4', 'The "guide RNA" directs the cut to a target sequence.', 'guide RNA', Difficulty.SIMPLE, 'concept:guide-rna'],
    ['C5', 'The patent landscape and ethics debates around germline editing reshaped biotech policy worldwide.', 'exploratory', Difficulty.COMPLEX, 'explore:crispr-policy'],
    // ---- Task D: Kubernetes ----
    ['D1', 'Kubernetes was open-sourced by Google in 2014.', '2014', Difficulty.SIMPLE, 'date:k8s-opensource'],
    ['D2', 'It was based on Google internal system Borg.', 'Borg', Difficulty.SIMPLE, 'concept:borg'],
    ['D3', 'Version 1.0 released in July 2015.', '2015-07', Difficulty.SIMPLE, 'date:k8s-v1'],
    ['D4', 'CNCF hosts the project.', 'CNCF', Difficulty.SIMPLE, 'concept:cncf'],
    ['D5', 'The ecosystem of operators, service meshes and policy engines redefined platform engineering at scale.', 'exploratory', Difficulty.COMPLEX, 'explore:k8s-ecosystem'],
    // ---- Task E: Transformer architecture ----
    ['E1', 'The Transformer was introduced in "Attention Is All You Need".', 'Attention Is All You Need', Difficulty.SIMPLE, 'paper:transformer'],
    ['E2', 'It was published in 2017.', '2017', Difficulty.SIMPLE, 'date:transformer-paper'],
    ['E3', 'It replaced recurrent networks (RNN/LSTM).', 'RNN/LSTM', Difficulty.SIMPLE, 'concept:rnn'],
    ['E4', 'BERT and GPT are transformer-based models.', 'BERT/GPT', Difficulty.SIMPLE, 'concept:bert-gpt'],
    ['E5', 'The architecture relies on self-attention instead of recurrence.', 'self-attention', Difficulty.SIMPLE, 'concept:self-attention'],
  ];

  const topics = {
    A: 'History of the Transistor',
    B: 'The TCP/IP Flag Day',
    C: 'CRISPR Gene Editing',
    D: 'Kubernetes Origin',
    E: 'The Transformer Architecture',
  };

  for (const prefix of Object.keys(topics)) {
    tasks.push({
      id: `task-${prefix}`,
      topic: topics[prefix],
      claims: claims
        .filter((c) => c[0].startsWith(prefix))
        .map(([id, task, expected, difficulty, subject]) => ({
          id,
          task,
          expected,
          difficulty,
          subject,
        })),
    });
  }
  return tasks;
}

/** Quick distribution sanity check used by the demo. */
export function workloadStats() {
  const all = WORKLOAD.flatMap((t) => t.claims);
  const simple = all.filter((c) => c.difficulty === Difficulty.SIMPLE).length;
  const complex = all.filter((c) => c.difficulty === Difficulty.COMPLEX).length;
  return {
    tasks: WORKLOAD.length,
    claims: all.length,
    simple,
    complex,
    simplePct: Math.round((simple / all.length) * 100),
    complexPct: Math.round((complex / all.length) * 100),
  };
}
