package kg.reasoner.llm;

import java.io.IOException;
import java.util.List;

import org.apache.jena.query.Dataset;
import org.apache.jena.rdf.model.Statement;

/**
 * Pluggable LLM-driven inference. v2.3 of the iterative-quality stack.
 *
 * Each implementation:
 *   1. Selects candidate (subject, ?context...) tuples from the closure.
 *   2. Composes one LlmTask per candidate (or per batch).
 *   3. Calls the adapter; parses the response into Statement objects.
 *   4. Returns the new triples to KgReasoner, which adds them to the
 *      inferred graph with provenance {@code rfc:inferredBy "llm:<rule>"}.
 *
 * Determinism: KgReasoner wraps every adapter in {@link CachedLlmAdapter}
 * with {@code allowMisses=false} at PR/CI time. New LLM inputs require an
 * author to populate the cache locally (with API key) and commit the
 * resulting JSON files to {@code kg/.llm-cache/}.
 */
public interface LlmRule {

    /** Stable name; appears in {@code rfc:inferredBy "llm:<name>"}. */
    String name();

    /** Run the rule against the closure (authored + earlier-layer
     *  inferences) and return the new statements derived. Implementations
     *  must be idempotent w.r.t. the closure: applying the same rule to
     *  the same closure must produce the same set of triples. */
    List<Statement> apply(Dataset closure, LlmAdapter llm) throws IOException;
}
