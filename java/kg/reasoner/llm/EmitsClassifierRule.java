package kg.reasoner.llm;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;

/**
 * LLM-gated rule that proposes {@code :emits} triples for orphan
 * diagnostics — diagnostics that no NormativeStatement explicitly
 * emits via the regex rule {@code emits-from-text.rule}.
 *
 * Per-RFC strategy:
 *   1. For each RFC, find its orphan diagnostics (no incoming :emits).
 *   2. Find every NormativeStatement defined in the same RFC.
 *   3. For each orphan diagnostic, compose ONE LLM call:
 *      "Given these N rules in {RFC}, which trigger diagnostic {Mxxxxx}?"
 *   4. Parse the response (JSON array of 1-indexed rule numbers).
 *   5. Emit a :emits triple for each match.
 *
 * Cost discipline: one call per orphan diagnostic, not N×M. With ~600
 * orphans after the regex rule, a full pass is ~600 calls.
 */
public final class EmitsClassifierRule implements LlmRule {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";

    private final String model;
    private final int maxRulesPerCall;

    public EmitsClassifierRule(String model, int maxRulesPerCall) {
        this.model = model;
        this.maxRulesPerCall = maxRulesPerCall;
    }

    @Override
    public String name() { return "emits-classifier"; }

    @Override
    public List<Statement> apply(Dataset closure, LlmAdapter llm) throws IOException {
        Model model = closure.getDefaultModel();
        Map<String, OrphanContext> contexts = collectOrphans(closure);

        List<Statement> derived = new ArrayList<>();
        Property emits = model.createProperty(RFC_NS + "emits");

        int hits = 0, misses = 0;
        for (var entry : contexts.entrySet()) {
            OrphanContext ctx = entry.getValue();
            for (Diag orphan : ctx.orphans) {
                List<Rule> rules = ctx.rules;
                if (rules.size() > maxRulesPerCall) {
                    rules = rules.subList(0, maxRulesPerCall);
                }
                String prompt = composePrompt(ctx.rfcId, orphan, rules);
                LlmTask task = new LlmTask(
                    this.model,
                    SYSTEM_PROMPT,
                    prompt,
                    /*temp*/ 0.0,
                    /*max*/ 200,
                    "emits-classifier:" + orphan.code
                );
                LlmResponse resp;
                try {
                    resp = llm.complete(task);
                } catch (IOException e) {
                    // Cache miss in CI mode (no API key, no cached entry):
                    // skip this orphan silently and continue. Author runs
                    // locally with ANTHROPIC_API_KEY to populate the cache;
                    // committed cache then drives this branch on subsequent
                    // CI runs.
                    misses++;
                    continue;
                }
                hits++;
                List<Integer> picks = parsePicks(resp.text);
                for (int idx : picks) {
                    if (idx < 1 || idx > rules.size()) continue;
                    Rule r = rules.get(idx - 1);
                    derived.add(model.createStatement(r.iri, emits, orphan.iri));
                }
            }
        }
        if (hits + misses > 0) {
            System.err.println("[emits-classifier] cache: " + hits + " hit(s), "
                + misses + " miss(es), " + derived.size() + " new :emits links");
        }
        return derived;
    }

    // -----------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------

    private static Map<String, OrphanContext> collectOrphans(Dataset ds) {
        // Per-RFC: orphan diagnostics + all rules in that RFC.
        Map<String, OrphanContext> out = new TreeMap<>();
        Model m = ds.getDefaultModel();

        // (rfcId, diag IRI, code, description) for orphan diagnostics.
        String orphanQuery = """
            PREFIX rfc: <%s>
            SELECT ?rfcId ?diag ?code ?description WHERE {
              ?doc a rfc:Document ; rfc:rfcId ?rfcId ; rfc:introducesDiagnostic ?diag .
              ?diag rfc:code ?code ; rfc:description ?description .
              FILTER NOT EXISTS { ?rule rfc:emits ?diag }
            }
            ORDER BY ?rfcId ?code
            """.formatted(RFC_NS);
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(orphanQuery), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                String rfcId = s.getLiteral("rfcId").getString();
                Resource diagIri = s.getResource("diag");
                String code = s.getLiteral("code").getString();
                String desc = s.getLiteral("description").getString();
                out.computeIfAbsent(rfcId, OrphanContext::new).orphans.add(new Diag(diagIri, code, desc));
            }
        }

        // (rfcId, rule IRI, modality, predicate text) for every rule.
        String ruleQuery = """
            PREFIX rfc: <%s>
            SELECT ?rfcId ?rule ?modality ?text WHERE {
              ?doc a rfc:Document ; rfc:rfcId ?rfcId ;
                   rfc:hasSection ?sec .
              ?sec rfc:containsRule ?rule .
              ?rule a rfc:NormativeStatement ;
                    rfc:modality ?mod ;
                    rfc:predicate ?text .
              ?mod rfc:label ?modLabel .
              BIND(STR(?modLabel) AS ?modality)
            }
            ORDER BY ?rfcId ?rule
            """.formatted(RFC_NS);
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(ruleQuery), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                String rfcId = s.getLiteral("rfcId").getString();
                if (!out.containsKey(rfcId)) continue;  // no orphans here
                RDFNode rule = s.get("rule");
                String mod = s.contains("modality") ? s.getLiteral("modality").getString() : "?";
                String text = s.getLiteral("text").getString();
                out.get(rfcId).rules.add(new Rule(rule.asResource(), mod, text));
            }
        }

        return out;
    }

    // -----------------------------------------------------------------------
    // Prompting
    // -----------------------------------------------------------------------

    private static final String SYSTEM_PROMPT = """
        You are an expert in software specifications. Given a diagnostic \
        and a list of normative rules from the same specification document, \
        identify which rule(s) trigger the emission of this diagnostic when \
        the rule is violated.

        Respond with a single JSON array of 1-indexed rule numbers, e.g. [3] \
        or [2, 7] or [] if none clearly emit it. Output ONLY the array, \
        nothing else.""";

    static String composePrompt(String rfcId, Diag orphan, List<Rule> rules) {
        StringBuilder b = new StringBuilder();
        b.append("Diagnostic code: ").append(orphan.code).append('\n');
        b.append("Diagnostic description: ").append(orphan.description).append("\n\n");
        b.append("Rules in ").append(rfcId).append(":\n");
        for (int i = 0; i < rules.size(); i++) {
            b.append(i + 1).append(". [").append(rules.get(i).modality).append("] ")
             .append(rules.get(i).predicate).append('\n');
        }
        b.append("\nWhich rule(s) emit ").append(orphan.code).append("? JSON array only.");
        return b.toString();
    }

    /** Parse the first JSON-array literal in the response and extract
     *  integer rule indices. Tolerant of leading/trailing whitespace,
     *  prose around the array, and bracket whitespace. */
    static List<Integer> parsePicks(String text) {
        int open = text.indexOf('[');
        int close = open >= 0 ? text.indexOf(']', open) : -1;
        if (open < 0 || close < 0) return List.of();
        String inner = text.substring(open + 1, close);
        List<Integer> out = new ArrayList<>();
        for (String tok : inner.split(",")) {
            String t = tok.trim();
            if (t.isEmpty()) continue;
            try {
                out.add(Integer.parseInt(t));
            } catch (NumberFormatException ignore) { /* skip */ }
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Records
    // -----------------------------------------------------------------------

    static final class OrphanContext {
        final String rfcId;
        final List<Diag> orphans = new ArrayList<>();
        final List<Rule> rules = new ArrayList<>();
        OrphanContext(String rfcId) { this.rfcId = rfcId; }
    }
    static final class Diag {
        final Resource iri;
        final String code;
        final String description;
        Diag(Resource iri, String code, String description) {
            this.iri = iri; this.code = code; this.description = description;
        }
    }
    static final class Rule {
        final Resource iri;
        final String modality;
        final String predicate;
        Rule(Resource iri, String modality, String predicate) {
            this.iri = iri; this.modality = modality; this.predicate = predicate;
        }
    }
}
