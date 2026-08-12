package kg.gate;

import java.nio.charset.StandardCharsets;
import java.io.InputStream;
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


/**
 * Runs the gate suite over a corpus and reports, per gate, what it found AND how
 * much it looked at.
 *
 * <p>This is the first {@code java_binary} in {@code java/BUILD.bazel} — the
 * comment at its head has said since the migration that consumers keep the
 * entry points. spec is now a consumer.
 *
 * <h2>Why this does not reimplement the gate</h2>
 *
 * <p>⛔ THE VERDICT IS NOT COMPUTED HERE. It comes from executing the engine
 * binary — {@code @rules_jena//jena/sparql:jena_sparql} — with the same flags
 * {@code sparql_query_test} passes it, and reading its exit code. So this binary
 * is not ASSERTED to agree with the gate targets; on the verdict it IS them.
 *
 * <p>That matters more than it sounds. The estate already runs three SPARQL
 * engines over two gate suites on two Jena versions (RFC-005 §1), and a fourth
 * opinion wearing the word "gate" would be worse than no service at all. A
 * conformance fixture would only prove two implementations agree on the cases
 * somebody thought of.
 *
 * <p>⚠ The obvious refactor — linking the engine's query execution as a library
 * — is NOT available at the pinned version. rules_jena 0.3.0 ships
 * {@code jena_sparql} as a java_binary with the execution inline; the
 * {@code result_emit} library that would make this an in-process call exists
 * only on rules_jena's main branch. When that version is adopted, the subprocess
 * per gate below collapses to a method call, which is the difference between a
 * CLI and something an agent can hit in a loop.
 *
 * <p>⚠ This class links {@code @gate_maven}'s Jena (5.2.0, the engine's version)
 * and NOT {@code @spec_maven}'s (5.0.0), so it cannot reuse {@code kg.Loader}.
 * Two Jena versions on one classpath means the answer depends on classpath
 * order. In-process Jena is used ONLY to merge the corpus and to derive the
 * examined count — never to decide a gate.
 *
 * <h2>Usage</h2>
 *
 * <pre>
 *   gate_cli --engine=path/to/jena_sparql \
            --gate=name=path/to/gate.rq [--gate=...] corpus1.ttl corpus2.ttl ...
 * </pre>
 *
 * <p>Writes a GateReport as JSON to stdout. Exits 0 if it ran, whatever the
 * verdicts — a gate FAILING is a result, not a crash, and a runner that exits
 * non-zero on a red gate cannot be asked "what is red?" by anything that treats
 * exit codes as errors.
 */
public final class GateCli {

    /** What a gate can be. Three-valued on purpose — see {@link #examine}. */
    enum Status { PASSED, FAILED, EXAMINED_NOTHING }

    record GateResult(String name, Status status, int rows, int examined, String firstRow) {}

    public static void main(String[] argv) throws Exception {
        List<String> gateSpecs = new ArrayList<>();
        List<Path> corpus = new ArrayList<>();
        Path engine = null;
        for (String a : argv) {
            if (a.startsWith("--gate=")) {
                gateSpecs.add(a.substring("--gate=".length()));
            } else if (a.startsWith("--engine=")) {
                engine = Path.of(a.substring("--engine=".length()));
            } else if (a.startsWith("--")) {
                System.err.println("unknown flag: " + a);
                System.exit(2);
            } else {
                corpus.add(Path.of(a));
            }
        }
        if (gateSpecs.isEmpty() || corpus.isEmpty() || engine == null) {
            System.err.println(
                "usage: gate_cli --engine=JENA_SPARQL --gate=NAME=QUERY.rq [...] CORPUS.ttl [...]");
            System.exit(2);
        }

        Model model = load(corpus);
        // Serialized ONCE and reused. The engine takes its dataset on stdin, so
        // this is the byte stream every gate sees — merging per gate would let
        // two gates disagree about the corpus they judged.
        Path merged = Files.createTempFile("gate-corpus", ".ttl");
        try (var w = Files.newBufferedWriter(merged, StandardCharsets.UTF_8)) {
            model.write(w, "TURTLE");
        }

        List<GateResult> results = new ArrayList<>();
        for (String spec : gateSpecs) {
            int eq = spec.indexOf('=');
            if (eq < 0) {
                System.err.println("malformed --gate (expected NAME=PATH): " + spec);
                System.exit(2);
            }
            results.add(run(spec.substring(0, eq), Path.of(spec.substring(eq + 1)),
                            model, engine, merged));
        }
        Files.deleteIfExists(merged);
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

    static GateResult run(String name, Path queryPath, Model model, Path engine, Path merged)
            throws Exception {
        Query query = QueryFactory.create(Files.readString(queryPath, StandardCharsets.UTF_8));

        // ⛔ The verdict. Same binary, same flags sparql_query_test passes.
        ProcessBuilder pb = new ProcessBuilder(
                engine.toString(),
                "--rule-name=" + name,
                "--in-format=turtle",
                "--query=" + queryPath,
                "--out-format=tsv");
        pb.redirectInput(merged.toFile());
        pb.redirectErrorStream(false);
        Process proc = pb.start();
        String stdout;
        try (InputStream in = proc.getInputStream()) {
            stdout = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        int code = proc.waitFor();
        if (code != 0) {
            // Exit 2 is a usage error and 3 a malformed dataset. Neither is a
            // gate verdict, and reporting either as FAILED would manufacture a
            // violation nobody found.
            throw new IllegalStateException(
                "engine exited " + code + " for gate " + name + " — not a verdict");
        }
        List<String> lines = stdout.lines().toList();
        // TSV carries a header row; a gate with no violations emits the header
        // and nothing else. Guard the empty case rather than subtracting blind.
        int rows = lines.isEmpty() ? 0 : Math.max(0, lines.size() - 1);
        String firstRow = rows > 0 ? lines.get(1) : "";

        int examined = examine(query, model);

        // ⛔ Order matters. A gate with violations is FAILED even if `examined`
        // could not be computed; only a CLEAN gate can be EXAMINED_NOTHING.
        Status status = rows > 0 ? Status.FAILED
                : examined == 0 ? Status.EXAMINED_NOTHING
                : Status.PASSED;
        return new GateResult(name, status, rows, examined, firstRow);
    }

    /**
     * How many candidate solutions the gate's own WHERE clause has.
     *
     * <p>A zero-row gate over an EMPTY candidate set returns zero rows and reads
     * as PASS. {@code envelope_unrecorded}'s candidates are
     * {@code ?quantity a au:Quantity} and Studio's corpus has zero such nodes —
     * so that gate is green today having examined nothing. A person skims past
     * that; a model reports it as validation.
     *
     * <p>⛔ Derived from the PARSED query, never from a hand-written sibling file.
     * RFC-004 §5 proposed a {@code <gate>.population.rq} convention and named its
     * own defect: an independently authored population query can OVERCOUNT,
     * turning a gate that examined nothing into a green gate wearing a large
     * number — strictly worse than today's silence. Taking
     * {@link Query#getQueryPattern} verbatim makes that unrepresentable: the
     * population cannot describe a WHERE clause the gate does not have.
     *
     * <p>⚠ This counts SOLUTIONS, not groups. For a grouped gate the number
     * answers "how many candidate rows did this look at", which is the question
     * EXAMINED_NOTHING exists for. It is not a denominator and nothing should
     * divide by it.
     *
     * @return the solution count, or -1 when the question cannot be answered
     *     soundly — a non-SELECT gate, or one whose judgement is not in a HAVING
     *     and therefore has no candidate set separable from its verdict. -1 is
     *     UNKNOWN and never reads as EXAMINED_NOTHING.
     */
    static int examine(Query gate, Model model) {
        if (!gate.isSelectType()) return -1;
        // ⛔ MEASURED, AND THE FIRST VERSION OF THIS WAS WRONG. Stripping HAVING
        // only separates candidates from judgement when the judgement IS in the
        // HAVING. Most gates here are not written that way: ladder-integrity puts
        // its judgement in FILTER NOT EXISTS *inside* the WHERE, so the pattern
        // matches violations and nothing else — and "examined" came back 0 for a
        // gate that had just read 133 claims, making every passing gate report
        // EXAMINED_NOTHING. A blind-gate detector that fires on every healthy
        // gate is worse than none: it trains the reader to ignore it.
        //
        // So the derivation is claimed ONLY where it is sound. No HAVING means no
        // separable candidate set, and the honest answer is "unknown", not a
        // number. RFC-004 §5's <gate>.population.rq exists for exactly this case
        // and this is the evidence for it — the authored population is not
        // avoidable, only relocatable (see RFC-005 §4, revised).
        if (gate.getHavingExprs().isEmpty()) return -1;
        Query pop = QueryFactory.make();
        pop.setQuerySelectType();
        pop.setQueryResultStar(true);
        pop.setQueryPattern(gate.getQueryPattern());
        pop.setPrefixMapping(gate.getPrefixMapping());
        // GROUP BY / HAVING / LIMIT / OFFSET are all deliberately not carried
        // over. HAVING is the gate's judgement; this is the population it judged.
        try (org.apache.jena.query.QueryExecution qe =
                 org.apache.jena.query.QueryExecutionFactory.create(pop, model)) {
            int n = 0;
            for (org.apache.jena.query.ResultSet rs = qe.execSelect(); rs.hasNext(); rs.next()) {
                n++;
            }
            return n;
        }
    }

    /**
     * The GateReport, as JSON.
     *
     * <p>Field names match the message RFC-004 §4.3 specifies so that adopting
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
              .append(", \"first_row\": \"").append(esc(r.firstRow())).append("\"}")
              .append(i < results.size() - 1 ? ",\n" : "\n");
        }
        long failed = results.stream().filter(r -> r.status() == Status.FAILED).count();
        long blind = results.stream().filter(r -> r.status() == Status.EXAMINED_NOTHING).count();
        sb.append("  ],\n  \"failed\": ").append(failed)
          .append(",\n  \"examined_nothing\": ").append(blind)
          // Not `failed == 0`. A suite where every gate examined nothing has no
          // failures and has checked nothing, and calling that "clean" is the
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
