import { bedrock } from "@ai-sdk/amazon-bedrock";
import { defineAgent, defineDynamic } from "eve";

/**
 * Where the model comes from.
 *
 * Two routes, and the choice is a deployment decision rather than a code one.
 *
 * A bare gateway model id string routes through the Vercel AI Gateway, which is
 * the default and needs an `AI_GATEWAY_API_KEY` (or `eve link`) plus a card on
 * the Vercel team — inference is refused with `customer_verification_required`
 * until there is one.
 *
 * ⛔ SETTING `SPEC_AGENT_BEDROCK_MODEL` BYPASSES THE GATEWAY ENTIRELY. eve
 * accepts any provider-authored AI SDK `LanguageModel`, and
 * `@ai-sdk/amazon-bedrock` pins the same `@ai-sdk/provider@4.0.7` that eve's
 * `ai@7` peer resolves, so it drops in without a shim.
 *
 * Bedrock is the better fit for this system, and not only because of the
 * billing:
 *
 *   * The prompt carries a customer's authorization vocabulary — their roles,
 *     their permission names, their org structure. Invariant ① keeps their DATA
 *     out of spec; their MODEL still goes to whoever serves the tokens. Bedrock
 *     keeps that inside an account SAVVI already controls, in a chosen region.
 *   * On Fargate or Lambda a task role signs the request, so there is no API key
 *     in an environment variable and nothing to rotate. That is strictly better
 *     than any key-based path, and it is the same
 *     `sts:AssumeRoleWithWebIdentity` trust RFC-004 §4.3 already needs from
 *     Vercel OIDC for the symbolic services.
 *
 * ⚠ Model ids are Bedrock-native, not gateway-native: an inference profile id
 * like `us.anthropic.claude-...-v1:0`, not `anthropic/claude-...`. Model access
 * is granted per model per region in the Bedrock console and is NOT on by
 * default — an untouched account returns AccessDeniedException for a model that
 * plainly exists.
 */
const bedrockModel = process.env["SPEC_AGENT_BEDROCK_MODEL"]?.trim();

/**
 * ⚠ REQUIRED FOR A DIRECT PROVIDER, and eve fails the BUILD without it rather
 * than guessing:
 *
 *   Cannot compile agent compaction because the primary compaction trigger model
 *   "amazon-bedrock/us.anthropic.claude-…" does not have known AI Gateway
 *   context window metadata.
 *
 * eve resolves a context window from the AI Gateway catalog, and a model reached
 * directly is not in it. The number decides when compaction fires, so a wrong one
 * either compacts a conversation that had room or lets a turn overflow. Set it
 * from the model's own documented window, and change it when the model changes.
 *
 * `SPEC_AGENT_CONTEXT_TOKENS` overrides it for a model with a different window.
 */
const CONTEXT_TOKENS = Number(process.env["SPEC_AGENT_CONTEXT_TOKENS"] ?? 200_000);

/**
 * ⛔ A LIVE PROVIDER MUST BE RETURNED FROM `step.started`, AND NOWHERE ELSE.
 *
 * A static `model:` is SERIALIZED into the compiled manifest, so passing
 * `bedrock(id)` there stores the string `amazon-bedrock/us.anthropic.…` — which
 * is a Vercel AI Gateway model id. The agent then compiles, reports that id in
 * `step.started`, looks entirely correct, and routes every call back through the
 * gateway: the failure is `AI Gateway received no credentials` for a model you
 * believed you were reaching directly. Measured, not guessed.
 *
 * eve's rule is one line of its docs — *"Session/turn selections must be model
 * id strings; return live `LanguageModel` objects only from `step.started`"* —
 * and it is the whole difference between talking to AWS and talking to Vercel.
 *
 * The instance is hoisted so every step returns the SAME object. Rebuilding it
 * per step would be a new model selection each time, and prompt caches are per
 * model — every switch re-ingests the conversation at uncached prices.
 */
const bedrockInstance = bedrockModel ? bedrock(bedrockModel) : null;

const gatewayModel = process.env["SPEC_AGENT_MODEL"]?.trim() ?? "openai/gpt-5.4-mini";

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
/**
 * ⚠ The WHOLE call is branched, not just the `model` value. `defineAgent` takes
 * an exact static-or-dynamic definition — a static agent may set
 * `modelContextWindowTokens`, a dynamic one may not — so a `string | Dynamic`
 * union satisfies neither and `tsc` says so. Two calls, one shared config.
 */
const limits = {
    // ⚠ Both set EXPLICITLY. eve's defaults are generous (40,000,000 input
    // tokens per session), and an unbounded budget on an agent nobody is
    // watching is a cost incident waiting for a slow week. A number that is
    // wrong is fixable; a number nobody chose is not even visible.
    maxInputTokensPerSession: 2_000_000,
    // Long enough for a person to leave an approval overnight and come back —
    // the whole point of durable parking — and short enough that an abandoned
    // session does not sit open for a month.
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export default bedrockInstance
  ? defineAgent({
      model: defineDynamic({
        events: {
          "step.started": () => ({
            model: bedrockInstance,
            // Returned per-selection rather than as a sibling field: a dynamic
            // agent may not set `modelContextWindowTokens` on `defineAgent`.
            modelContextWindowTokens: CONTEXT_TOKENS,
          }),
        },
      }),
      limits,
    })
  : defineAgent({ model: gatewayModel, limits });
