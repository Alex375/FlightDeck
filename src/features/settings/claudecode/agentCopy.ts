// What each sub-agent IS, in the words of someone who has to decide what it should run on.
//
// Two rules this file exists to enforce:
//   • No Claude Code jargon on the page. "subagent_type", "frontmatter" and "inherit" are
//     implementation words; a person choosing a model needs to know what the helper does
//     and what changes if it gets weaker or stronger.
//   • Recommendations are DATA, with the reason attached. A recommendation without a
//     because is just an opinion the user cannot argue with.
//
// Agents not listed here still appear on the page — they just carry their own description
// from their definition file and no recommendation, which is the honest thing to show for
// an agent the user wrote themselves.

export interface AgentCopy {
  /** The name used in the UI, in place of the dispatch name. */
  title: string;
  /** One line: what it does. */
  summary: string;
  /** When Claude reaches for it without being asked. */
  whenUsed: string;
  /** What a weaker model costs you here. */
  weaker: string;
  /** What a stronger model buys you here. */
  stronger: string;
  /**
   * The model we suggest, and why.
   *
   * `model` is the catalogue value actually applied; `family` is what the UI SAYS —
   * "Haiku", not "Haiku 4.5". Versions move, and a recommendation that names one dates
   * itself the week a new model ships. The advice ("searching does not need power") is
   * about the tier, not the release.
   */
  recommend?: { model: string; family: string; because: string };
}

export const AGENT_COPY: Record<string, AgentCopy> = {
  Explore: {
    title: "Code search",
    summary:
      "Sweeps files to find where something lives, then reports back. Read-only — it never edits or fixes.",
    whenUsed:
      "Claude reaches for it on its own whenever answering means looking through many files rather than reading one.",
    weaker:
      "Almost nothing. Finding a symbol is pattern-matching; the answer is a list of file references either way.",
    stronger:
      "Slightly better judgement about which of several plausible matches is the one you meant — rarely worth the price here.",
    recommend: {
      model: "haiku",
      family: "Haiku",
      because: "this is grep with a summary at the end — raw power does not make it find more",
    },
  },
  Plan: {
    title: "Planning",
    summary:
      "Designs how a change should be made before any code is written, and reports the steps and trade-offs.",
    whenUsed: "Before large or structural work, and whenever you ask for a plan.",
    weaker:
      "A plan that misses a constraint costs far more than it saved — every later step is built on it.",
    stronger:
      "Catches the architectural problem early, which is the whole point of planning separately.",
    recommend: {
      model: "claude-opus-4-8",
      family: "Opus",
      because: "the plan decides everything downstream — this is the wrong place to save money",
    },
  },
  "general-purpose": {
    title: "General helper",
    summary:
      "The catch-all for multi-step work that has no more specific helper: research a question, follow a thread across files, carry out a self-contained task.",
    whenUsed:
      "Whenever Claude delegates something that is not plain searching and not planning.",
    weaker: "Loses the thread on long tasks and hands back work that needs redoing.",
    stronger: "Finishes open-ended tasks without coming back for clarification.",
    recommend: {
      model: "sonnet",
      family: "Sonnet",
      because: "capable enough for delegated work, several times cheaper than an Opus-tier model",
    },
  },
  "workflow-subagent": {
    title: "Workflow worker",
    summary:
      "One worker inside a multi-agent workflow run. Dozens of them can run for a single command.",
    whenUsed: "Only inside a workflow — never on its own.",
    weaker: "Each worker is doing a narrow, well-specified piece; most of them do not need depth.",
    stronger: "Rarely changes the outcome, and is multiplied by the number of workers.",
  },
};

/** The page's fallback for an agent nobody has written copy for — usually one of the
 *  user's own. Its own description is shown instead; we do not invent a recommendation for
 *  an agent we know nothing about. */
export function copyFor(name: string, description: string | null): AgentCopy {
  const known = AGENT_COPY[name];
  if (known) return known;
  return {
    title: name,
    summary: description ?? "A helper you defined.",
    whenUsed: "Whenever Claude decides this helper fits, or when you name it.",
    weaker: "Depends on what you wrote it to do.",
    stronger: "Depends on what you wrote it to do.",
  };
}

/**
 * The instruction block the app can add to the global CLAUDE.md.
 *
 * ## Why this block is the centre of the feature, not a footnote
 *
 * Claude's own workflow-authoring guidance tells it never to lower a worker's model
 * "because the task seems small, simple, or cheap". Left alone it will therefore never do
 * this routing on its own — every worker inherits the big model. A baseline env var can
 * lower the floor uniformly, but only a written policy lets Claude tell a cheap task from
 * an expensive one and choose accordingly. That is the difference between spending less
 * and spending well.
 */
export const ROUTING_POLICY_BLOCK = `## Choosing a model for a helper agent

When you delegate work to a sub-agent — including the workers in a workflow — pick the
model to fit the task instead of inheriting mine. Tiers, not versions — use whichever
release of each family is current:

- **Searching, locating, listing, reading to answer a factual question** → Haiku.
  Finding things is pattern-matching; a bigger model does not find more.
- **Implementing against a spec that already exists, mechanical refactors, writing tests
  for described behaviour, summarising** → Sonnet.
- **Multi-file refactors, security-sensitive work, debugging to root cause, design and
  planning, anything where being wrong is expensive** → Opus.

This instruction overrides any general guidance you have about not lowering a worker's
model because a task looks small. Here, matching the model to the task IS the instruction:
use a cheap model when the work is genuinely mechanical, and a strong one whenever
judgement, architecture, or correctness is at stake. When you are unsure, choose the
stronger model.`;

/** One-click blocks the instructions panel offers. Text is editable before it is written. */
export interface InstructionBlock {
  id: string;
  title: string;
  why: string;
  body: string;
}

export const INSTRUCTION_BLOCKS: InstructionBlock[] = [
  {
    id: "routing",
    title: "Model routing policy",
    why: "Lets Claude send mechanical work to a cheap model. Without it, it never will — its own guidance forbids downgrading a worker for looking easy.",
    body: ROUTING_POLICY_BLOCK,
  },
];
