import { defineAgent } from "eve";

/**
 * The markup assistant.
 *
 * Scoped to one job — proposing which words in a requirement carry weight — for
 * a measured reason. Of the 60 open surfaces in the Studio corpus, 23 are
 * disposable by exact string matching (8 colon-form permission tokens covering
 * 38 rows, 9 schema identifiers, 6 decomposer artefacts a person clears), and a
 * model adds nothing to an exact match over an author's own backticks. What is
 * left is judgement: which of three plausible readings of `public` the business
 * actually means, and which noun inside a bolded clause is the term.
 *
 * ⛔ A deterministic script wins the majority of this work and should keep it.
 * This agent exists for the residue, and RFC-004 §5 requires it to be measured
 * against the null hypothesis — exact matching plus a ranked dropdown — before
 * it is allowed near the queue at scale.
 */
export default defineAgent({
  // AI Gateway model id. Overridable with SPEC_AGENT_MODEL so the eval suite can
  // pin a cheaper model than an interactive session uses.
  model: process.env["SPEC_AGENT_MODEL"] ?? "openai/gpt-5.4-mini",

  limits: {
    // ⚠ Both set EXPLICITLY. eve's defaults are generous (40,000,000 input
    // tokens per session), and an unbounded budget on an agent nobody is
    // watching is a cost incident waiting for a slow week. A number that is
    // wrong is fixable; a number nobody chose is not even visible.
    maxInputTokensPerSession: 2_000_000,
    // Long enough for a person to leave an approval overnight and come back —
    // the whole point of durable parking — and short enough that an abandoned
    // session does not sit open for a month.
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
