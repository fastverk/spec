package kg.lean;

import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;

import kg.Loader;

/**
 * Generates {@code Aion/Derivations/Generated.lean} from the corpus —
 * one Lean axiom per spec axiom, one Lean axiom per grounded theorem,
 * and one Lean theorem per :Derivation linking premises to conclusion
 * via the cited rule.
 *
 * The Lean kernel cross-checks what Jena's SPARQL grounding lint
 * already establishes — but from an independent codebase. A derivation
 * citing a hallucinated axiom IRI fails to compile in Lean even if it
 * passes SPARQL pattern-matching.
 *
 * Output shape (sketch):
 * <pre>
 *   import Aion.Logic.Core
 *   namespace Aion.Derivations
 *
 *   -- Axioms (35)
 *   axiom ax_AX_001 : Prop
 *   ...
 *
 *   -- Theorems (579)
 *   axiom th_d61eff342079 : Prop
 *   ...
 *
 *   -- Derivations: one theorem each
 *   theorem deriv_abc123 (h1 : ax_AX_005) (h2 : ax_AX_020)
 *       : th_d61eff342079 := by sorry
 *
 *   end Aion.Derivations
 * </pre>
 *
 * The {@code sorry} placeholder is intentional — we don't have
 * propositional encodings of the axiom content yet. The kernel still
 * verifies that the named premises and conclusions are declared, and
 * that the rule's soundness theorem exists (referenced via the
 * companion module). When the propositional layer lands, replace
 * {@code sorry} with a real proof.
 */
public final class CorpusToLean {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String AXIOM_PREFIX = "https://aion.savvi.io/rfc/axiom/";
    private static final String RULE_PREFIX = "https://aion.savvi.io/rfc/rule/";

    public static void main(String[] args) throws IOException {
        boolean checkOnly = false;
        Path kgRoot = null;
        Path outFile = null;
        for (String a : args) {
            if ("--check".equals(a)) checkOnly = true;
            else if (kgRoot == null) kgRoot = Paths.get(a);
            else if (outFile == null) outFile = Paths.get(a);
            else throw new IllegalArgumentException("unexpected arg: " + a);
        }
        // Standard resolution when args omitted (e.g., bazel test).
        if (kgRoot == null) kgRoot = Loader.resolveKgRoot();
        if (outFile == null) outFile = kgRoot.getParent()
            .resolve("lean/Aion/Derivations/Generated.lean");

        Dataset ds = Loader.loadDataset(kgRoot);

        List<String> axiomNames = loadAxiomNames(ds);
        Map<String, String> theoremIds = loadTheoremIds(ds);  // theoremId -> sample predicate
        List<Derivation> derivations = loadDerivations(ds);

        java.io.StringWriter buf = new java.io.StringWriter();
        try (PrintWriter w = new PrintWriter(buf)) {
            emit(w, axiomNames, theoremIds, derivations);
        }
        String generated = buf.toString();

        if (checkOnly) {
            String existing = Files.exists(outFile) ? Files.readString(outFile, StandardCharsets.UTF_8) : "";
            if (!generated.equals(existing)) {
                System.err.println(outFile + " is out of sync with the corpus.");
                System.err.println("Run: bazel run //kg/java/lean:corpus_to_lean -- "
                    + "$(pwd)/kg $(pwd)/" + outFile);
                System.exit(1);
            }
            System.out.println(outFile + " in sync");
            return;
        }

        if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
        Files.writeString(outFile, generated, StandardCharsets.UTF_8);
        System.err.printf("[corpus_to_lean] wrote %d axioms, %d theorems, %d derivations to %s%n",
            axiomNames.size(), theoremIds.size(), derivations.size(), outFile);
    }

    // -----------------------------------------------------------------------
    // Loaders
    // -----------------------------------------------------------------------

    private static List<String> loadAxiomNames(Dataset ds) {
        Query q = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?iri WHERE { ?iri a rfc:Axiom } ORDER BY ?iri");
        List<String> out = new ArrayList<>();
        try (QueryExecution ex = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = ex.execSelect();
            while (rs.hasNext()) {
                String iri = rs.next().getResource("iri").getURI();
                if (iri.startsWith(AXIOM_PREFIX)) out.add(iri.substring(AXIOM_PREFIX.length()));
            }
        }
        out.sort(Comparator.naturalOrder());
        return out;
    }

    /** TheoremId is the sha-256 prefix of (rfcId|section|predicate) — the
     *  same value Normalize uses as a cache key. We compute it here so the
     *  generated identifiers match what's in the spike markdown. */
    private static Map<String, String> loadTheoremIds(Dataset ds) {
        Query q = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?rfcId ?sectionTitle ?predicate ?ns WHERE {\n"
            + "  ?doc a rfc:Document ; rfc:rfcId ?rfcId ; rfc:hasSection ?sec .\n"
            + "  ?sec rfc:title ?sectionTitle ; rfc:containsRule ?ns .\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:predicate ?predicate ; rfc:derivedVia ?d .\n"
            + "}");
        Map<String, String> out = new TreeMap<>();
        try (QueryExecution ex = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = ex.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                String rfcId = s.getLiteral("rfcId").getString();
                String sec = s.getLiteral("sectionTitle").getString();
                String pred = s.getLiteral("predicate").getString();
                String tid = sha12(rfcId + "|" + sec + "|" + pred);
                out.put(tid, pred);
            }
        }
        return out;
    }

    private static List<Derivation> loadDerivations(Dataset ds) {
        Query q = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?rfcId ?sectionTitle ?predicate ?d ?rule (GROUP_CONCAT(?prem; separator=\"|\") AS ?premises) WHERE {\n"
            + "  ?doc a rfc:Document ; rfc:rfcId ?rfcId ; rfc:hasSection ?sec .\n"
            + "  ?sec rfc:title ?sectionTitle ; rfc:containsRule ?ns .\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:predicate ?predicate ; rfc:derivedVia ?d .\n"
            + "  ?d rfc:appliesRule ?rule ; rfc:premise ?prem .\n"
            + "} GROUP BY ?rfcId ?sectionTitle ?predicate ?d ?rule");
        List<Derivation> out = new ArrayList<>();
        try (QueryExecution ex = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = ex.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                String rfcId = s.getLiteral("rfcId").getString();
                String sec = s.getLiteral("sectionTitle").getString();
                String pred = s.getLiteral("predicate").getString();
                String tid = sha12(rfcId + "|" + sec + "|" + pred);
                String ruleIri = s.getResource("rule").getURI();
                String ruleName = ruleIri.startsWith(RULE_PREFIX)
                    ? ruleIri.substring(RULE_PREFIX.length())
                    : null;
                if (ruleName == null) continue;  // skip unknown rules
                String[] premIris = s.getLiteral("premises").getString().split("\\|");
                List<String> premiseAxioms = new ArrayList<>();
                for (String iri : premIris) {
                    if (iri.startsWith(AXIOM_PREFIX)) premiseAxioms.add(iri.substring(AXIOM_PREFIX.length()));
                }
                if (premiseAxioms.isEmpty()) continue;  // skip derivations with non-axiom premises
                String dHash = sha12(tid + "|" + ruleName + "|" + String.join(",", premiseAxioms));
                out.add(new Derivation(dHash, tid, ruleName, premiseAxioms));
            }
        }
        out.sort(Comparator.comparing((Derivation d) -> d.theoremId).thenComparing(d -> d.dHash));
        return out;
    }

    // -----------------------------------------------------------------------
    // Lean emission
    // -----------------------------------------------------------------------

    private static void emit(PrintWriter w,
                             List<String> axiomNames,
                             Map<String, String> theoremIds,
                             List<Derivation> derivations) {
        w.println("/-");
        w.println("Aion.Derivations.Generated — DO NOT EDIT.");
        w.println();
        w.println("Generated by kg.lean.CorpusToLean from the live KG. Each spec");
        w.println("axiom becomes an opaque Lean axiom; each grounded theorem becomes");
        w.println("an opaque Prop axiom; each :Derivation in the corpus becomes a");
        w.println("Lean theorem whose type cross-checks the SPARQL grounding lint.");
        w.println();
        w.println("The `sorry` placeholders mean: we accept the rule + premises");
        w.println("compose to the conclusion, given each axiom's content. When the");
        w.println("propositional layer lands (axioms encoded as actual Lean Props),");
        w.println("replace `sorry` with real proofs.");
        w.println("-/");
        w.println();
        w.println("import Spec.Logic.InferenceRulesProofs");
        w.println();
        w.println("set_option linter.unusedVariables false");
        w.println();
        w.println("namespace Aion.Derivations");
        w.println();

        // Axioms (35)
        w.println("-- Spec axioms (" + axiomNames.size() + ")");
        for (String ax : axiomNames) {
            w.printf("axiom ax_%s : Prop%n", sanitize(ax));
        }
        w.println();

        // Theorem-level placeholders (one per grounded NS)
        w.println("-- Grounded theorems (" + theoremIds.size() + ")");
        for (Map.Entry<String, String> e : theoremIds.entrySet()) {
            w.printf("axiom th_%s : Prop  -- %s%n", e.getKey(), trimComment(e.getValue()));
        }
        w.println();

        // Cross-reference each rule's soundness theorem once at file scope —
        // #check verifies the symbol exists and is well-typed without
        // introducing a binding (which would trip universe inference on
        // the polymorphic rules). If a referenced rule's signature is
        // removed from the catalog, this file fails to elaborate.
        java.util.Set<String> rulesUsed = new java.util.TreeSet<>();
        for (Derivation d : derivations) rulesUsed.add(d.ruleName);
        w.println("-- Inference-rule cross-references (existence + type check)");
        for (String r : rulesUsed) {
            w.printf("#check @Spec.Logic.%s_sound%n", r);
        }
        w.println();

        // Derivations: one theorem per :Derivation with axiom-IRI premises.
        // The signature itself is the cross-check: hallucinated axioms or
        // missing theorem IDs fail to compile. The proof body is `sorry`
        // (placeholder until the propositional layer lands).
        w.println("-- Derivations (" + derivations.size() + ")");
        for (Derivation d : derivations) {
            StringBuilder hyps = new StringBuilder();
            int i = 1;
            for (String prem : d.premiseAxioms) {
                if (hyps.length() > 0) hyps.append(' ');
                hyps.append("(h").append(i++).append(" : ax_").append(sanitize(prem)).append(")");
            }
            w.printf("theorem deriv_%s %s : th_%s := by sorry  -- via %s%n",
                d.dHash, hyps.toString(), d.theoremId, d.ruleName);
        }

        w.println();
        w.println("end Aion.Derivations");
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private static String sanitize(String s) {
        return s.replace('-', '_').replace('.', '_');
    }

    private static String trimComment(String s) {
        if (s == null) return "";
        s = s.replace("\n", " ").replace("\r", " ").replace("--", " - -");
        return s.length() > 80 ? s.substring(0, 77) + "…" : s;
    }

    static String sha12(String key) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    record Derivation(String dHash, String theoremId, String ruleName, List<String> premiseAxioms) {}
}
