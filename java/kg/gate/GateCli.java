package kg.gate;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.apache.jena.query.Query;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;

import fastverk.rules_jena.sparql.ResultEmit;

/**
 * Runs the gate suite over a corpus and reports, per gate, what it found AND how
 * much it looked at.
 *
 * <p>The first {@code java_binary} in {@code java/BUILD.bazel} — the comment at
 * its head has said since the migration that consumers keep the entry points.
 * spec is now a consumer.
 *
 * <h2>Why this does not reimplement the gate</h2>
 *
 * <p>⛔ THE VERDICT IS NOT COMPUTED HERE. It comes from
 * {@link ResultEmit#executeAndEmit}, the exact call {@code JenaSparql} makes to
 * satisfy the rules_rdf sparql_engine contract. That library exists so callers
 * cannot drift — its own comment: "Keeping the formatter calls in one library
 * guarantees the two paths emit byte-identical results."
 *
 * <p>So this binary is not ASSERTED to agree with the {@code sparql_query_test}
 * targets; on the verdict it IS them. That matters more than it sounds: the
 * estate already runs three SPARQL engines over two gate suites on two Jena
 * versions (RFC-005 §1), and a fourth opinion wearing the word "gate" would be
 * worse than no service at all. A conformance fixture would only prove two
 * implementations agree on the cases somebody thought of.
 *
 * <p>⚠ {@code result_emit} landed in rules_jena 0.3.2. This ran against 0.3.0
 * first, where the execution is inline in the {@code jena_sparql} binary and the
 * only way to share it was to exec it — a JVM start per gate, plus a temp file
 * for the engine's stdin. The bump removed both. Worth knowing when reading old
 * revisions of this file, and worth knowing generally: the sibling working copy
 * at {@code fastverk/repos/rules_jena} was ahead of the release the build
 * resolved, and reading it as though it were the release cost a build.
 *
 * <p>⚠ This links {@code @gate_maven}'s Jena (5.2.0, matching the engine) and NOT
 * {@code @spec_maven}'s (5.0.0), so it cannot reuse {@code kg.Loader}. Two Jena
 * versions on one classpath means the answer depends on classpath order.
 *
 * <h2>Usage</h2>
 *
 * <pre>
 *   gate_cli --gate=NAME=path/to/gate.rq [--gate=...] corpus1.ttl corpus2.ttl ...
 * </pre>
 *
 * <p>Writes a GateReport as JSON to stdout. Exits 0 if it ran, whatever the
 * verdicts — a gate FAILING is a result, not a crash, and a runner that exits
 * non-zero on a red gate cannot be asked "what is red?" by anything that treats
 * exit codes as errors.
 */
public final class GateCli {

    /** What a gate can be. Three-valued on purpose — see {@link #derived}. */
    enum Status { PASSED, FAILED, EXAMINED_NOTHING }

    record GateResult(String name, Status status, int rows, int examined,
                      String populationSource, String note, String firstRow) {}

    public static void main(String[] argv) throws Exception {
        List<String> gateSpecs = new ArrayList<>();
        List<Path> corpus = new ArrayList<>();
        for (String a : argv) {
            if (a.startsWith("--gate=")) {
                gateSpecs.add(a.substring("--gate=".length()));
            } else if (a.startsWith("--")) {
                System.err.println("unknown flag: " + a);
                System.exit(2);
            } else {
                corpus.add(Path.of(a));
            }
        }
        if (gateSpecs.isEmpty() || corpus.isEmpty()) {
            System.err.println("usage: gate_cli --gate=NAME=QUERY.rq [...] CORPUS.ttl [...]");
            System.exit(2);
        }

        Model model = load(corpus);
        List<GateResult> results = new ArrayList<>();
        for (String spec : gateSpecs) {
            int eq = spec.indexOf('=');
            if (eq < 0) {
                System.err.println("malformed --gate (expected NAME=PATH): " + spec);
                System.exit(2);
            }
            results.add(run(spec.substring(0, eq), Path.of(spec.substring(eq + 1)), model));
        }
        System.out.println(toJson(results));
    }

    /**
     * One Jena Model from every file.
     *
     * <p>Per-file {@code RDFDataMgr.read} rather than byte-concatenation: blank
     * node labels are file-scoped, and concatenating two files that both use
     * {@code _:b0} silently merges two different nodes. rules_rdf makes the same
     * point about its own merge — "merged blank-node-safely via the serializer
     * toolchain (not byte-concat)".
     */
    static Model load(List<Path> files) {
        Model model = ModelFactory.createDefaultModel();
        for (Path f : files) {
            RDFDataMgr.read(model, f.toUri().toString(), Lang.TURTLE);
        }
        return model;
    }

    static GateResult run(String name, Path queryPath, Model model) throws Exception {
        Query gate = QueryFactory.create(Files.readString(queryPath, StandardCharsets.UTF_8));
        List<String> lines = emit(gate, model).lines().toList();
        int rows = lines.isEmpty() ? 0 : Math.max(0, lines.size() - 1);
        String firstRow = rows > 0 ? lines.get(1) : "";

        // The authored candidate set, per RFC-004 §5: <gate>.population.rq.
        Path popPath = Path.of(queryPath.toString().replaceFirst("\\.rq$", ".population.rq"));
        int examined = -1;
        String source = "none";
        String note = "";
        if (Files.exists(popPath)) {
            Query pop = QueryFactory.create(Files.readString(popPath, StandardCharsets.UTF_8));
            examined = rowsOf(pop, model);
            source = "authored";
            // ⛔ GUARD 1. A population smaller than the violation count is
            // incoherent: the gate found rows the population says cannot exist,
            // so the two describe different candidate sets. This catches the file
            // drifting NARROWER than its gate. It cannot catch OVERcounting —
            // that is the risk RFC-004 names and this convention accepts.
            if (examined < rows) {
                note = "population (" + examined + ") < violations (" + rows
                     + ") — the population query does not cover its own gate";
            }
        }

        // ⛔ GUARD 2. Where the judgement IS in a HAVING, the candidate set is
        // derivable from the parsed query. Derive it anyway and report
        // disagreement: it is the only mechanical check on an authored
        // population that exists, and it applies to a minority of gates.
        int derived = derived(gate, model);
        if (derived >= 0 && examined >= 0 && derived != examined) {
            note = "authored population " + examined + " disagrees with the count "
                 + "derived from the gate's own WHERE (" + derived + ")";
        } else if (derived >= 0 && examined < 0) {
            examined = derived;
            source = "derived";
        }

        // ⛔ Order matters. A gate with violations is FAILED even when `examined`
        // is unknown; only a CLEAN gate can be EXAMINED_NOTHING. And -1 is
        // UNKNOWN, never zero — a gate whose blindness nobody can determine must
        // not be reported as blind, nor as thorough.
        Status status = rows > 0 ? Status.FAILED
                : examined == 0 ? Status.EXAMINED_NOTHING
                : Status.PASSED;
        return new GateResult(name, status, rows, examined, source, note, firstRow);
    }

    /** The engine of record's own execution, as TSV. */
    static String emit(Query q, Model model) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
        try (PrintStream out = new PrintStream(buf, true, StandardCharsets.UTF_8);
             PrintStream err = new PrintStream(errBuf, true, StandardCharsets.UTF_8)) {
            ResultEmit.executeAndEmit(model, q, "tsv", false, out, err);
        }
        return buf.toString(StandardCharsets.UTF_8);
    }

    /** Row count, TSV header excluded. */
    static int rowsOf(Query q, Model model) {
        List<String> lines = emit(q, model).lines().toList();
        return lines.isEmpty() ? 0 : Math.max(0, lines.size() - 1);
    }

    /**
     * The candidate count derived from the gate's own parsed WHERE clause.
     *
     * <p>⛔ SOUND ONLY WHERE THE JUDGEMENT IS IN A HAVING, and the first version
     * of this did not check. Stripping HAVING separates candidates from judgement
     * only when the judgement is there. {@code ladder-integrity.rq} puts its
     * judgement in {@code FILTER NOT EXISTS} inside the pattern, so the WHERE
     * matches violations and nothing else — the derived count read 0 for a gate
     * that had just examined 133 claims, and all four authoring gates reported
     * EXAMINED_NOTHING over a corpus CI calls green. A blind-gate detector that
     * fires on every healthy gate teaches the reader to ignore it.
     *
     * @return the count, or -1 for UNKNOWN — a non-SELECT gate, or one with no
     *     HAVING and therefore no candidate set separable from its verdict.
     */
    static int derived(Query gate, Model model) {
        if (!gate.isSelectType()) return -1;
        if (gate.getHavingExprs().isEmpty()) return -1;
        Query pop = QueryFactory.make();
        pop.setQuerySelectType();
        pop.setQueryResultStar(true);
        pop.setQueryPattern(gate.getQueryPattern());
        pop.setPrefixMapping(gate.getPrefixMapping());
        return rowsOf(pop, model);
    }

    /**
     * The GateReport, as JSON.
     *
     * <p>Field names match the message RFC-004 §4.3 specifies, so adopting
     * {@code derivation.proto} later is a serializer swap and not a rename. Hand
     * written because {@code proto/spec/v1} has no {@code proto_library} at all
     * today — that is its own step.
     */
    static String toJson(List<GateResult> results) {
        StringBuilder sb = new StringBuilder("{\n  \"gates\": [\n");
        for (int i = 0; i < results.size(); i++) {
            GateResult r = results.get(i);
            sb.append("    {\"name\": \"").append(esc(r.name()))
              .append("\", \"status\": \"").append(r.status())
              .append("\", \"rows\": ").append(r.rows())
              .append(", \"examined\": ").append(r.examined())
              .append(", \"population_source\": \"").append(r.populationSource())
              .append("\", \"note\": \"").append(esc(r.note()))
              .append("\", \"first_row\": \"").append(esc(r.firstRow())).append("\"}")
              .append(i < results.size() - 1 ? ",\n" : "\n");
        }
        long failed = results.stream().filter(r -> r.status() == Status.FAILED).count();
        long blind = results.stream().filter(r -> r.status() == Status.EXAMINED_NOTHING).count();
        sb.append("  ],\n  \"failed\": ").append(failed)
          .append(",\n  \"examined_nothing\": ").append(blind)
          // ⛔ Not `failed == 0`. A suite where every gate examined nothing has no
          // failures and has checked nothing, and calling that clean is the
          // vacuous pass this whole system exists to refuse.
          .append(",\n  \"clean\": ").append(failed == 0 && blind == 0)
          .append("\n}");
        return sb.toString();
    }

    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\t", " ").replace("\n", " ");
    }

    private GateCli() {}
}
