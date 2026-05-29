package kg.lean;

import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
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
import kg.reasoner.llm.LlmAdapter;
import kg.reasoner.llm.LlmProviders;
import kg.reasoner.llm.LlmResponse;
import kg.reasoner.llm.LlmTask;

/**
 * For each Derivation in the corpus, ask the LLM to produce a Lean
 * theorem (with a real proof, not sorry) that derives the NS's
 * propositional content from the cited axioms via the cited rule.
 *
 * Output: {@code lean/Aion/Derivations/Proofs.lean} — one
 * {@code theorem} per derivation. Some compile, some don't (degrade
 * to sorry-with-comment). The CI's {@code lean_test} verifies what
 * compiles; coverage % shows in {@code kg_metrics}.
 *
 * Honest scope: this is best-effort. Many NSes are domain-specific
 * (specific diagnostic codes, specific algorithmic behaviors) and
 * don't map cleanly to the universe types/predicates in
 * {@code Aion.Spec.Universe}/{@code Predicates}. Those degrade to
 * sorry. Each successful proof is one more kernel-verified theorem.
 *
 * Cost: ~$0.02 per derivation under Sonnet 4.6 (each prompt ~3k
 * input tokens including the encoded axiom catalog). For 579
 * derivations, ~$10-15 total.
 *
 * Usage:
 *   bazel run //kg/java/lean:generate_proofs              # write
 *   bazel run //kg/java/lean:generate_proofs -- --limit 10  # subset
 */
public final class GenerateProofs {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String AXIOM_PREFIX = "https://aion.savvi.io/rfc/axiom/";
    private static final String RULE_PREFIX = "https://aion.savvi.io/rfc/rule/";

    private static final String SYSTEM_PROMPT = """
        You are a Lean 4 proof engineer for the Aion spec's audit \
        layer. Given:
          - The natural-language statement of a normative rule (NS).
          - A small library of axioms, each a real Lean 4 Prop \
            declaration over an opaque universe.
          - One inference rule from a finite catalog (with its \
            soundness theorem).

        Produce a Lean 4 theorem with a real proof body that derives \
        a Prop encoding of the NS from the cited axioms via the \
        cited rule.

        Critical constraints:

        1. Use ONLY the universe types and predicates declared in the \
           reference snippet — NO new opaque types or predicates.
        2. Use ONLY the encoded axioms cited in the derivation — no \
           appeal to other axioms even if they would help.
        3. The proof MUST type-check. If it can't type-check using \
           only the cited resources, return JSON with "kind":"defer" \
           explaining why.
        4. Output Lean 4 syntax — `theorem` declarations, `by` blocks, \
           tactic proofs (use `exact`, `refine`, `apply`, `intros`, \
           etc.).

        Output strictly one JSON object, no preamble:

          {"kind":"theorem",
           "prop":"<Lean Prop expression for the NS conclusion>",
           "proof":"<Lean tactic body — content after `by`, each line prefixed by 2 spaces>"}

        OR

          {"kind":"defer",
           "reason":"<short explanation of why no real proof is possible>"}

        The Aion namespace is open — refer to predicates and types \
        by short name (e.g. `kindOf`, `Resource`). Refer to axioms \
        by their `ax_AX_NNN` short name.

        Worked example to anchor syntax. NS prose: "Resource kind \
        MUST be present and non-empty." Cited axiom: ax_AX_009 \
        (∀ r, kindOf r ≠ "" ∧ kindIsOpaque r). Cited rule: \
        Type instantiation. Output:

          {"kind":"theorem",
           "prop":"∀ (r : Resource), kindOf r ≠ \\\"\\\"",
           "proof":"  intro r\\n  exact (ax_AX_009 r).left"}

        Note the 2-space indent on each `proof` line — exactly as \
        it would appear under the `by` keyword. Use `\\n` for newlines \
        and `\\\"` for embedded quotes in JSON strings.
        """;

    public static void main(String[] args) throws IOException, InterruptedException {
        int limit = Integer.MAX_VALUE;
        Path outFile = null;
        Path kgRoot = null;
        String validateLeanBin = null;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if ("--limit".equals(a)) limit = Integer.parseInt(args[++i]);
            else if ("--validate".equals(a)) {
                // Auto-validate after generation. Defaults the lean binary
                // to $LEAN_BIN env var, or "lean" on PATH.
                String env = System.getenv("LEAN_BIN");
                validateLeanBin = (env != null && !env.isBlank()) ? env : "lean";
            }
            else if ("--validate-with".equals(a)) validateLeanBin = args[++i];
            else if (kgRoot == null) kgRoot = Paths.get(a);
            else if (outFile == null) outFile = Paths.get(a);
            else throw new IllegalArgumentException("unexpected arg: " + a);
        }
        if (kgRoot == null) kgRoot = Loader.resolveKgRoot();
        if (outFile == null) outFile = kgRoot.getParent().resolve(
            "lean/Aion/Derivations/Proofs.lean");

        Dataset ds = Loader.loadDataset(kgRoot);
        String axiomCatalog = readAxiomsCatalog(kgRoot);
        String universeBlock = readUniverseBlock(kgRoot);
        String predicatesBlock = readPredicatesBlock(kgRoot);
        Map<String, String> ruleSounds = readInferenceRulesCatalog();

        List<Derivation> derivations = loadDerivations(ds);
        if (derivations.size() > limit) derivations = derivations.subList(0, limit);
        System.err.printf("[generate_proofs] %d derivations to process%n", derivations.size());

        LlmAdapter llm = LlmProviders.resolve();
        String model = defaultModel();

        StringBuilder buf = new StringBuilder();
        emitHeader(buf);
        int proved = 0, deferred = 0, errors = 0;

        // Pre-build the cacheable prefix once — it's identical for every
        // derivation. Passing it as the LlmTask's userPromptPrefix lets
        // the Anthropic adapter mark it with cache_control:ephemeral so
        // the API charges ~10% of the normal input price on cache hits.
        String userPromptPrefix = buildUserPromptPrefix(universeBlock, predicatesBlock);

        for (int i = 0; i < derivations.size(); i++) {
            Derivation d = derivations.get(i);
            String dynamic = buildUserPromptDynamic(d, axiomCatalog, ruleSounds);
            LlmTask task = new LlmTask(model, SYSTEM_PROMPT,
                userPromptPrefix, dynamic,
                /*temp*/ 0.0, /*max*/ 800,
                "generate_proofs:" + d.dHash);
            try {
                LlmResponse resp = llm.complete(task);
                Result r = parseResponse(resp.text);
                if (r.kind == ResultKind.THEOREM) {
                    emitTheorem(buf, d, r.prop, r.proof);
                    proved++;
                } else {
                    emitDeferred(buf, d, r.reason);
                    deferred++;
                }
                if ((i + 1) % 25 == 0) {
                    System.err.printf("[%d/%d] proved=%d deferred=%d errors=%d%n",
                        i + 1, derivations.size(), proved, deferred, errors);
                }
            } catch (IOException e) {
                emitDeferred(buf, d, "LLM error: " + e.getMessage());
                errors++;
            }
        }
        emitFooter(buf, proved, deferred, errors);

        if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
        Files.writeString(outFile, buf.toString(), StandardCharsets.UTF_8);
        System.err.printf("[generate_proofs] proved=%d deferred=%d errors=%d → %s%n",
            proved, deferred, errors, outFile);

        // Auto-validate: post-process to patch failing proofs to sorry so
        // the file compiles cleanly. Eliminates the manual validate_proofs
        // step in the generator pipeline.
        if (validateLeanBin != null) {
            System.err.printf("[generate_proofs] running validate with lean=%s%n", validateLeanBin);
            // kgRoot's parent is the workspace root (kg lives at <ws>/kg).
            ValidateProofs.Result vr = ValidateProofs.run(
                outFile, validateLeanBin, 100, kgRoot.getParent());
            if (!vr.ok()) {
                System.err.println("[generate_proofs] validate failed; see diagnostics above");
                System.exit(1);
            }
            System.err.printf("[generate_proofs] validated: %d theorem(s) patched in %d iter(s)%n",
                vr.patched(), vr.iterations());
        }
    }

    // -----------------------------------------------------------------------
    // Prompt building
    // -----------------------------------------------------------------------

    private static String buildUserPrompt(Derivation d, String axiomCatalog,
                                          String universeBlock, String predicatesBlock,
                                          Map<String, String> ruleSounds) {
        return buildUserPromptPrefix(universeBlock, predicatesBlock)
            + buildUserPromptDynamic(d, axiomCatalog, ruleSounds);
    }

    /** The static prefix of the user prompt — universe + predicates,
     *  identical across every derivation. Marked as cacheable in the
     *  Anthropic API so 600+ calls in a generator run share one cache
     *  read instead of paying full input price each time. */
    private static String buildUserPromptPrefix(String universeBlock, String predicatesBlock) {
        StringBuilder sb = new StringBuilder();
        sb.append("# Universe types & predicates available\n\n");
        sb.append("All identifiers below are open under `namespace Aion.Spec`.\n\n");
        sb.append("```lean\n");
        sb.append(universeBlock);
        sb.append("\n-- Predicates / functions over those types:\n");
        sb.append(predicatesBlock);
        sb.append("```\n\n");
        return sb.toString();
    }

    /** The dynamic suffix — cited axioms (per-derivation) and the NS. */
    private static String buildUserPromptDynamic(Derivation d, String axiomCatalog,
                                                  Map<String, String> ruleSounds) {
        StringBuilder sb = new StringBuilder();
        sb.append("# Cited axioms (use these in your proof)\n\n");
        sb.append("```lean\n");
        for (String premIRI : d.premiseAxioms) {
            String name = "ax_" + premIRI.substring(AXIOM_PREFIX.length()).replace("-", "_");
            String snippet = axiomCatalogLookup(axiomCatalog, name);
            sb.append(snippet).append("\n\n");
        }
        sb.append("```\n\n");

        sb.append("# Inference rule cited\n\n");
        sb.append("```lean\n");
        sb.append(ruleSounds.getOrDefault(d.ruleName, "-- (rule sound theorem unknown)"));
        sb.append("\n```\n\n");

        sb.append("# Normative statement to formalize\n\n");
        sb.append("RFC: ").append(d.rfcId).append("\n");
        sb.append("Section: ").append(d.sectionTitle).append("\n");
        sb.append("Modality: ").append(d.modality).append("\n");
        sb.append("Statement: ").append(d.predicate).append("\n\n");

        sb.append("# Task\n\n");
        sb.append("Produce a Lean 4 theorem (with a real proof, not sorry) that ");
        sb.append("derives a propositional encoding of the NS from the cited axioms ");
        sb.append("via `").append(d.ruleName).append("`. Output JSON only.\n");
        return sb.toString();
    }

    /** Extract the encoded axiom snippet (with its TTL description as
     *  doc-comment) from the cached Spec.Axioms.lean text. Returns just
     *  the relevant `axiom ax_AX_NNN : <type>` block. */
    private static String axiomCatalogLookup(String catalog, String name) {
        int idx = catalog.indexOf("axiom " + name + " ");
        if (idx < 0) return "-- (not found in catalog: " + name + ")";
        int colonIdx = catalog.indexOf(":", idx);
        // Find the end of the axiom declaration (next blank line or next "axiom ")
        int end = catalog.indexOf("\n\n", colonIdx);
        int nextAxiom = catalog.indexOf("axiom ", idx + 1);
        if (nextAxiom > 0 && (end < 0 || nextAxiom < end)) end = nextAxiom;
        return catalog.substring(idx, end > 0 ? end : Math.min(idx + 500, catalog.length())).trim();
    }

    // -----------------------------------------------------------------------
    // Loaders
    // -----------------------------------------------------------------------

    private static List<Derivation> loadDerivations(Dataset ds) {
        Query q = QueryFactory.create(""
            + "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?rfcId ?sectionTitle ?predicate ?modIri ?d ?rule "
            + "       (GROUP_CONCAT(?prem; separator=\"|\") AS ?premises) "
            + "WHERE {\n"
            + "  ?doc a rfc:Document ; rfc:rfcId ?rfcId ; rfc:hasSection ?sec .\n"
            + "  ?sec rfc:title ?sectionTitle ; rfc:containsRule ?ns .\n"
            + "  ?ns a rfc:NormativeStatement ; rfc:predicate ?predicate ;\n"
            + "      rfc:modality ?modIri ; rfc:derivedVia ?d .\n"
            + "  ?d rfc:appliesRule ?rule ; rfc:premise ?prem .\n"
            + "} GROUP BY ?rfcId ?sectionTitle ?predicate ?modIri ?d ?rule "
            + "ORDER BY ?rfcId ?sectionTitle ?predicate");

        List<Derivation> out = new ArrayList<>();
        try (QueryExecution ex = QueryExecutionFactory.create(q, ds)) {
            ResultSet rs = ex.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                String rfcId = s.getLiteral("rfcId").getString();
                String sec = s.getLiteral("sectionTitle").getString();
                String pred = s.getLiteral("predicate").getString();
                String modIri = s.getResource("modIri").getURI();
                String mod = modIri.substring(modIri.lastIndexOf('#') + 1);
                String ruleIri = s.getResource("rule").getURI();
                String ruleName = ruleIri.substring(RULE_PREFIX.length());
                String[] premIris = s.getLiteral("premises").getString().split("\\|");
                List<String> premises = new ArrayList<>();
                for (String p : premIris) {
                    if (p.startsWith(AXIOM_PREFIX)) premises.add(p);
                }
                if (premises.isEmpty()) continue;
                String tid = sha12(rfcId + "|" + sec + "|" + pred);
                String dHash = sha12(tid + "|" + ruleName + "|" + String.join(",",
                    premises.stream().map(p -> p.substring(AXIOM_PREFIX.length())).toList()));
                out.add(new Derivation(dHash, tid, rfcId, sec, mod, pred, ruleName, premises));
            }
        }
        return out;
    }

    private static String readAxiomsCatalog(Path kgRoot) throws IOException {
        Path p = kgRoot.getParent().resolve("lean/Aion/Spec/Axioms.lean");
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    /** Extract every {@code opaque <Name> : Type} declaration from
     *  Universe.lean as a one-per-line block. Drift-free: adding a new
     *  type to Universe.lean automatically appears in the LLM prompt
     *  without code changes here. */
    private static String readUniverseBlock(Path kgRoot) throws IOException {
        Path p = kgRoot.getParent().resolve("lean/Aion/Spec/Universe.lean");
        StringBuilder sb = new StringBuilder();
        for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
            String t = line.trim();
            if (t.startsWith("opaque ") && t.endsWith(": Type")) {
                sb.append(t).append('\n');
            }
        }
        return sb.toString();
    }

    /** Extract every {@code axiom <name> : <signature>} declaration from
     *  Predicates.lean. Signatures are kept; comments are skipped. */
    private static String readPredicatesBlock(Path kgRoot) throws IOException {
        Path p = kgRoot.getParent().resolve("lean/Aion/Spec/Predicates.lean");
        StringBuilder sb = new StringBuilder();
        for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
            String t = line.trim();
            if (t.startsWith("axiom ")) {
                sb.append(t).append('\n');
            }
        }
        return sb.toString();
    }

    private static Map<String, String> readInferenceRulesCatalog() {
        // Hard-coded summaries of the 5 rule soundness theorems (matches
        // lean/Aion/Logic/InferenceRulesProofs.lean signatures).
        Map<String, String> m = new TreeMap<>();
        m.put("typeInstantiation",
            "theorem typeInstantiation_sound :\n" +
            "    ∀ (T : Sort u) (P : T → Prop) (a : T), (∀ x : T, P x) → P a");
        m.put("subclassInheritance",
            "theorem subclassInheritance_sound :\n" +
            "    ∀ (C D : α → Prop) (x : α), (∀ y, C y → D y) → C x → D x");
        m.put("modusPonens",
            "theorem modusPonens_sound :\n" +
            "    ∀ (P Q : Prop), (P → Q) → P → Q");
        m.put("definitionalSubstitution",
            "theorem definitionalSubstitution_sound :\n" +
            "    ∀ {α : Sort u} (φ : α → Prop) (T D : α), T = D → φ T → φ D");
        m.put("dependsOnImport",
            "theorem dependsOnImport_sound :\n" +
            "    ∀ (A B Y : Prop), (B → Y) → (A → B) → (A → Y)");
        return m;
    }

    // -----------------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------------

    private static void emitHeader(StringBuilder buf) {
        buf.append("/-\n");
        buf.append("Aion.Derivations.Proofs — DO NOT EDIT.\n\n");
        buf.append("Generated by kg.lean.GenerateProofs from the live corpus.\n");
        buf.append("For each :Derivation, the LLM proposed a Lean theorem with a\n");
        buf.append("real proof composing the cited axioms via the cited rule. Some\n");
        buf.append("compile (real proofs); some are deferred (sorry placeholder + reason).\n\n");
        buf.append("Compile coverage = real-proof coverage. The lean_test target\n");
        buf.append("//kg/lean:proofs_compiled_test type-checks every theorem here\n");
        buf.append("(deferreds keep the file compiling because they're sorry).\n");
        buf.append("-/\n\n");
        buf.append("import Aion.Spec.Axioms\n");
        buf.append("import Aion.Logic.InferenceRulesProofs\n\n");
        buf.append("set_option linter.unusedVariables false\n");
        buf.append("set_option linter.unusedSectionVars false\n\n");
        buf.append("open Aion.Spec\n");
        buf.append("open Aion\n\n");
        buf.append("namespace Aion.Derivations.Proofs\n\n");
    }

    private static void emitTheorem(StringBuilder buf, Derivation d, String prop, String proof) {
        buf.append("-- ").append(d.rfcId).append(" — ").append(d.modality).append(" — ");
        buf.append(escape(d.predicate)).append("\n");
        buf.append("-- Section: ").append(escape(d.sectionTitle)).append("\n");
        buf.append("-- Cited rule: ").append(d.ruleName).append("\n");
        for (String premIri : d.premiseAxioms) {
            String name = premIri.substring(AXIOM_PREFIX.length());
            buf.append("-- Cited axiom: ").append(name).append("\n");
        }
        // Pass proof body through as-is; LLM is asked to emit
        // ready-to-paste tactic content. We don't reindent because
        // reindentation breaks Lean's bullet/case syntax.
        buf.append("theorem deriv_").append(d.dHash).append(" :\n");
        buf.append("    ").append(prop).append(" := by\n");
        buf.append(proof.stripTrailing());
        buf.append("\n\n");
    }

    private static void emitDeferred(StringBuilder buf, Derivation d, String reason) {
        buf.append("-- ").append(d.rfcId).append(" — ").append(d.modality).append(" — ");
        buf.append(escape(d.predicate)).append("\n");
        buf.append("-- Section: ").append(escape(d.sectionTitle)).append("\n");
        buf.append("-- Cited rule: ").append(d.ruleName).append("\n");
        buf.append("-- Deferred: ").append(escape(reason)).append("\n");
        buf.append("opaque th_").append(d.dHash).append(" : Prop\n");
        buf.append("theorem deriv_").append(d.dHash).append(" : th_").append(d.dHash);
        buf.append(" := by sorry\n\n");
    }

    private static void emitFooter(StringBuilder buf, int proved, int deferred, int errors) {
        buf.append("end Aion.Derivations.Proofs\n\n");
        buf.append("-- Generated summary:\n");
        buf.append("--   Proved   : ").append(proved).append("\n");
        buf.append("--   Deferred : ").append(deferred).append("\n");
        buf.append("--   Errors   : ").append(errors).append("\n");
    }

    // -----------------------------------------------------------------------
    // Response parsing
    // -----------------------------------------------------------------------

    enum ResultKind { THEOREM, DEFER }

    record Result(ResultKind kind, String prop, String proof, String reason) {}

    static Result parseResponse(String text) {
        if (text == null) return new Result(ResultKind.DEFER, null, null, "empty response");
        String t = text.trim();
        if (t.startsWith("```")) {
            int nl = t.indexOf('\n');
            if (nl > 0) t = t.substring(nl + 1);
            if (t.endsWith("```")) t = t.substring(0, t.length() - 3).trim();
        }
        int start = t.indexOf('{');
        int end = t.lastIndexOf('}');
        if (start < 0 || end < start) return new Result(ResultKind.DEFER, null, null, "no JSON");
        String json = t.substring(start, end + 1);
        Map<String, String> kv = parseJsonObject(json);
        String kind = kv.getOrDefault("kind", "");
        if ("theorem".equalsIgnoreCase(kind)) {
            String prop = kv.getOrDefault("prop", "");
            String proof = kv.getOrDefault("proof", "");
            if (prop.isBlank() || proof.isBlank()) {
                return new Result(ResultKind.DEFER, null, null, "missing prop or proof");
            }
            return new Result(ResultKind.THEOREM, prop, proof, null);
        }
        return new Result(ResultKind.DEFER, null, null, kv.getOrDefault("reason", "deferred"));
    }

    static Map<String, String> parseJsonObject(String json) {
        Map<String, String> kv = new LinkedHashMap<>();
        java.util.regex.Pattern field = java.util.regex.Pattern.compile(
            "\"(\\w+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", java.util.regex.Pattern.DOTALL);
        java.util.regex.Matcher m = field.matcher(json);
        while (m.find()) {
            kv.put(m.group(1), unescape(m.group(2)));
        }
        return kv;
    }

    static String unescape(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                switch (n) {
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    default -> out.append(n);
                }
            } else out.append(c);
        }
        return out.toString();
    }

    private static String defaultModel() {
        String override = System.getenv("LLM_MODEL");
        if (override != null && !override.isBlank()) return override;
        return LlmProviders.provider() == LlmProviders.Provider.ANTHROPIC
            ? "claude-sonnet-4-6"
            : "gemma3:4b";
    }

    static String escape(String s) {
        if (s == null) return "";
        return s.replace("\n", " ").replace("\r", "");
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

    record Derivation(String dHash, String theoremId, String rfcId, String sectionTitle,
                      String modality, String predicate, String ruleName, List<String> premiseAxioms) {}
}
