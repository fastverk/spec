package kg.reasoner;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.apache.jena.rdf.model.InfModel;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;
import org.apache.jena.reasoner.Reasoner;
import org.apache.jena.reasoner.ReasonerRegistry;
import org.apache.jena.reasoner.rulesys.BuiltinRegistry;
import org.apache.jena.reasoner.rulesys.GenericRuleReasoner;
import org.apache.jena.reasoner.rulesys.Rule;
import org.apache.jena.riot.RDFDataMgr;

import kg.Loader;
import kg.Writer;
import kg.reasoner.builtins.StrContains;
import kg.reasoner.llm.EmitsClassifierRule;
import kg.reasoner.llm.LlmAdapter;
import kg.reasoner.llm.LlmProviders;
import kg.reasoner.llm.LlmRule;

/**
 * v2.0 of the iterative-quality stack: deterministic inference layer.
 *
 * Loads the authored corpus (kg/turtle/, kg/turtle-domain/, kg/turtle-claims/),
 * wraps it with Jena's OWL-MICRO reasoner, materializes the *new* triples
 * (closure - authored), and writes them to {@code kg/inferred/aion-inferred.ttl}
 * with provenance markers ({@code rfc:inferredBy "OWL-MICRO"}).
 *
 * The Loader unions inferred + authored graphs so kg_lint, kg_metrics,
 * kg_edit, etc. all see the closure transparently.
 *
 * Modes:
 *   bazel run //kg/java/reasoner:kg_reasoner             # write
 *   bazel run //kg/java/reasoner:kg_reasoner -- --check  # exit 1 on drift
 *
 * Idempotent: re-running produces byte-stable output. Gated by
 * {@code reasoner_sync_test} in //ci:pr_gates.
 */
public final class KgReasoner {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String OWL_MICRO_TAG = "OWL-MICRO";

    static {
        // Custom Jena rule builtins, registered once at class-load time so
        // any GenericRuleReasoner can invoke them from .rule files.
        BuiltinRegistry.theRegistry.register(new StrContains());
    }

    public static void main(String[] args) throws Exception {
        boolean checkOnly = false;
        boolean enableLlm = false;
        for (String a : args) {
            if ("--check".equals(a)) checkOnly = true;
            else if ("--enable-llm".equals(a)) enableLlm = true;
            else throw new IllegalArgumentException("unknown arg: " + a);
        }

        Path kgRoot = Loader.resolveKgRoot();
        Path inferredDir = kgRoot.resolve("inferred");
        Path target = inferredDir.resolve("aion-inferred.ttl");

        ComputeResult cr = computeInferredWithContext(kgRoot, enableLlm);
        byte[] bytes = Writer.writeStable(cr.inferred, cr.context);

        if (checkOnly) {
            byte[] existing = Files.exists(target) ? Files.readAllBytes(target) : new byte[0];
            if (!java.util.Arrays.equals(existing, bytes)) {
                System.err.println("kg/inferred/aion-inferred.ttl is out of sync with the reasoner.");
                System.err.println("Run: bazel run //kg/java/reasoner:kg_reasoner");
                System.exit(1);
            }
            System.out.println("inferred graph in sync ("
                + countTriples(cr.inferred) + " triples)");
            return;
        }
        Files.createDirectories(inferredDir);
        Files.write(target, bytes);
        System.out.println("wrote " + target + " ("
            + countTriples(cr.inferred) + " inferred triples, "
            + bytes.length + " bytes)");
    }

    /** Combined inferred-only model + context (full closure) for the
     *  Writer's stable-bnode-labelling step. */
    static final class ComputeResult {
        final Model inferred;
        final Model context;
        ComputeResult(Model inferred, Model context) { this.inferred = inferred; this.context = context; }
    }

    /**
     * Compute the closure (authored ∪ OWL-MICRO derivations) and return
     * only the *new* triples — the ones the reasoner derived but the
     * authored corpus didn't carry. Each new triple is annotated with a
     * provenance marker so audits stay possible.
     *
     * Skips closure axioms that aren't load-bearing for our queries
     * (e.g., reflexive sameAs, RDF/RDFS housekeeping triples). The
     * filter is conservative — it keeps anything in our own namespaces.
     */
    /** Compatibility shim for callers that don't need the context model. */
    static Model computeInferred(Path kgRoot) throws IOException {
        return computeInferredWithContext(kgRoot, false).inferred;
    }

    static ComputeResult computeInferredWithContext(Path kgRoot, boolean enableLlm) throws IOException {
        // Build the authored model — TBox + all ABox triples — and remember
        // exactly which triples were authored so we can subtract them later.
        Model authored = ModelFactory.createDefaultModel();
        loadAllTbox(kgRoot, authored);
        loadAllAbox(kgRoot, authored);

        // Layer 1 — OWL-MICRO closure (transitive properties, inverseOf,
        // owl:sameAs, basic domain/range inference). Cheapest deterministic
        // reasoner; produces baseline closures.
        Reasoner owl = ReasonerRegistry.getOWLMicroReasoner();
        InfModel owlInf = ModelFactory.createInfModel(owl, authored);
        Model owlClosure = ModelFactory.createDefaultModel();
        owlClosure.add(authored);
        owlClosure.add(owlInf); // materializes closure into a regular Model

        // Layer 2 — custom Jena rules from kg/rules/*.rule, run *over the
        // OWL closure* so rule premises can match closure-derived triples.
        // Track per-rule provenance: each rule file's name becomes the
        // :inferredBy tag for triples it derived. Run rules one file at
        // a time so we know which file produced what (Jena's rule engine
        // doesn't expose rule names in its output otherwise).
        Map<Statement, String> producerTag = new LinkedHashMap<>();
        StmtIterator owlIt = owlInf.listStatements();
        while (owlIt.hasNext()) {
            Statement s = owlIt.nextStatement();
            if (authored.contains(s)) continue;
            if (!isInteresting(s)) continue;
            producerTag.put(s, OWL_MICRO_TAG);
        }

        Path rulesDir = kgRoot.resolve("rules");
        if (Files.isDirectory(rulesDir)) {
            try (Stream<Path> stream = Files.list(rulesDir)
                    .filter(p -> p.toString().endsWith(".rule"))
                    .sorted()) {
                for (Path ruleFile : (Iterable<Path>) stream::iterator) {
                    Map<Statement, Boolean> derivedSet = new HashMap<>();
                    runRuleFile(ruleFile, owlClosure, derivedSet);
                    String tag = "kg/rules/" + ruleFile.getFileName().toString();
                    for (Statement s : derivedSet.keySet()) {
                        if (authored.contains(s)) continue;
                        if (!isInteresting(s)) continue;
                        // First producer wins — if OWL-MICRO already derived
                        // a triple, don't reattribute it to the rule file.
                        producerTag.putIfAbsent(s, tag);
                    }
                }
            }
        }

        // Layer 3 — LLM-gated rules. Strictly opt-in via --enable-llm.
        // Off by default so the committed kg/inferred/aion-inferred.ttl
        // stays purely deterministic (OWL-MICRO + Jena rules only) and
        // CI's reasoner_sync_test always reproduces it byte-for-byte
        // without an LLM cache or API key. With --enable-llm an author
        // gets the LLM contributions in their local Dataset for
        // exploration; promoting a finding to permanent requires a
        // deterministic Jena rule or a kg_edit scaffold-* call.
        if (enableLlm) {
            LlmAdapter adapter = buildLlmAdapter();
            // Apply the closure used so far (OWL-MICRO + Jena rules) so
            // LLM rules see the contributions of earlier layers.
            org.apache.jena.query.Dataset closureDs =
                org.apache.jena.query.DatasetFactory.create(owlClosure);
            // Materialize earlier-layer triples into the closure dataset
            // before running LLM rules.
            for (Statement s : producerTag.keySet()) closureDs.getDefaultModel().add(s);
            for (LlmRule rule : llmRules()) {
                List<Statement> derivedTriples;
                try {
                    derivedTriples = rule.apply(closureDs, adapter);
                } catch (IOException e) {
                    System.err.println("[reasoner] LLM rule " + rule.name()
                        + " failed: " + e.getMessage());
                    System.err.println("[reasoner]   (skip — populate cache via ANTHROPIC_API_KEY-enabled local run)");
                    continue;
                }
                System.err.println("[reasoner] llm:" + rule.name()
                    + " — " + derivedTriples.size() + " derived triples");
                String tag = "llm:" + rule.name();
                for (Statement s : derivedTriples) {
                    if (authored.contains(s)) continue;
                    if (!isInteresting(s)) continue;
                    producerTag.putIfAbsent(s, tag);
                }
            }
        }

        // Build the inferred-only model with reified provenance.
        Model derived = ModelFactory.createDefaultModel();
        copyPrefixes(authored, derived);
        Property inferredBy = derived.createProperty(RFC_NS + "inferredBy");
        Property rdfSubj = derived.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#subject");
        Property rdfPred = derived.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate");
        Property rdfObj  = derived.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#object");
        for (var e : producerTag.entrySet()) {
            Statement s = e.getKey();
            derived.add(s);
            Resource reified = derived.createResource();
            derived.add(reified, rdfSubj, s.getSubject());
            derived.add(reified, rdfPred, s.getPredicate());
            derived.add(reified, rdfObj, s.getObject());
            derived.add(reified, inferredBy, e.getValue());
        }
        return new ComputeResult(derived, owlClosure);
    }

    /** Resolve the configured LLM adapter via {@link LlmProviders}.
     *  Provider selection (LLM_PROVIDER env, or auto-detect) and cache
     *  location (AionPaths.cacheDir/llm) live in one place there. */
    private static LlmAdapter buildLlmAdapter() {
        return LlmProviders.resolve();
    }

    /** Registered LLM rules in execution order. New rules append here.
     *  Per-rule model defaults respect the active provider — gemma3:4b
     *  is a sensible Ollama default; haiku is the cheap Anthropic option.
     *  Override either via {@code LLM_MODEL} env var. */
    private static List<LlmRule> llmRules() {
        String model = defaultModel();
        return List.of(
            new EmitsClassifierRule(model, /*maxRulesPerCall=*/ 50)
        );
    }

    private static String defaultModel() {
        String override = System.getenv("LLM_MODEL");
        if (override != null && !override.isBlank()) return override;
        return LlmProviders.provider() == LlmProviders.Provider.ANTHROPIC
            ? "claude-haiku-4-5-20251001"
            : "gemma3:4b";
    }

    /** Run one rule file over the closure model and stash the new triples
     *  it derived (excluding ones already present in the closure) into
     *  {@code into}. */
    private static void runRuleFile(Path ruleFile, Model closure, Map<Statement, Boolean> into) throws IOException {
        List<Rule> rules = Rule.parseRules(Files.readString(ruleFile));
        System.err.println("[reasoner] " + ruleFile.getFileName() + " — " + rules.size() + " rule(s)");
        GenericRuleReasoner gr = new GenericRuleReasoner(rules);
        gr.setMode(GenericRuleReasoner.FORWARD);
        InfModel inf = ModelFactory.createInfModel(gr, closure);
        // Force rule firing — Jena's rule engine is lazy. Calling prepare()
        // (or any list/contains call) materializes the deductions.
        inf.prepare();
        StmtIterator it = inf.listStatements();
        int derived = 0;
        while (it.hasNext()) {
            Statement s = it.nextStatement();
            if (closure.contains(s)) continue;
            into.put(s, Boolean.TRUE);
            derived++;
        }
        System.err.println("[reasoner]   → " + derived + " derived triples");
    }

    /** Triples worth keeping in the inferred graph: those whose
     *  predicate is in Aion namespaces and whose subject and object
     *  (when a Resource) are either Aion-namespaced or blank nodes
     *  defined within the corpus. This drops RDFS/OWL housekeeping
     *  (every Document being inferred to be an owl:Thing) but keeps
     *  rule-derived triples like {@code _:rule_b1 :emits rfc:M36010}
     *  even when the rule itself is a blank node — the deterministic
     *  Writer assigns content-hash labels so byte-stability survives. */
    private static boolean isInteresting(Statement s) {
        if (!isAionPredicate(s.getPredicate())) return false;
        if (!isAionOrBlank(s.getSubject())) return false;
        if (s.getObject().isResource() && !isAionOrBlank(s.getObject().asResource())) return false;
        // Skip self-edges (e.g., owl:sameAs reflexive triples).
        if (s.getObject().isResource() && s.getSubject().equals(s.getObject().asResource())) return false;
        return true;
    }

    private static boolean isAionPredicate(Resource r) {
        if (r == null || r.isAnon()) return false;
        String iri = r.getURI();
        return iri.startsWith("https://aion.savvi.io/");
    }

    private static boolean isAionOrBlank(RDFNode node) {
        if (node == null || !node.isResource()) return false;
        Resource r = node.asResource();
        if (r.isAnon()) return true;
        String iri = r.getURI();
        return iri.startsWith("https://aion.savvi.io/");
    }

    // -----------------------------------------------------------------------
    // I/O — same load shape as kg.Loader, repeated here to keep the
    // reasoner's input deterministic and explicit.
    // -----------------------------------------------------------------------

    private static void loadAllTbox(Path kgRoot, Model into) throws IOException {
        // The framework rfc: vocabulary ships as a rules_spec classpath
        // resource (via the //kg/java:loader dep); domain TBox is kg-root.
        Loader.loadFrameworkVocab(into);
        for (Path p : List.of(
                kgRoot.resolve("ontology/aion-domain.ttl"),
                kgRoot.resolve("ontology/aion-claims.ttl"))) {
            if (Files.isRegularFile(p)) RDFDataMgr.read(into, p.toUri().toString());
        }
    }

    private static void loadAllAbox(Path kgRoot, Model into) throws IOException {
        for (String dir : List.of("turtle", "turtle-domain", "turtle-claims")) {
            Path d = kgRoot.resolve(dir);
            if (!Files.isDirectory(d)) continue;
            try (Stream<Path> stream = Files.list(d)
                    .filter(p -> p.toString().endsWith(".ttl"))
                    .sorted()) {
                for (Path p : (Iterable<Path>) stream::iterator) {
                    RDFDataMgr.read(into, p.toUri().toString());
                }
            }
        }
    }

    private static int countTriples(Model m) {
        // Count the *derived* triples, not their reifications.
        Property inferredBy = m.createProperty(RFC_NS + "inferredBy");
        return (int) m.listStatements(null, inferredBy, (RDFNode) null).toList().size();
    }

    private static void copyPrefixes(Model from, Model to) {
        for (var e : from.getNsPrefixMap().entrySet()) {
            to.setNsPrefix(e.getKey(), e.getValue());
        }
        // The authored corpus has prefix collisions (the empty `:` prefix
        // is claimed by aion-claims, but aion-rfc.ttl uses it too). Force
        // explicit prefixes for the three ontology namespaces so the
        // inferred output is unambiguous.
        to.setNsPrefix("rfco",   "https://aion.savvi.io/ontology/rfc#");
        to.setNsPrefix("dom",    "https://aion.savvi.io/ontology/domain#");
        to.setNsPrefix("claim",  "https://aion.savvi.io/ontology/claims#");
        if (!to.getNsPrefixMap().containsKey("rdf")) {
            to.setNsPrefix("rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#");
        }
    }
}
