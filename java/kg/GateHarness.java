package kg;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.apache.jena.graph.Graph;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ValidationReport;

/**
 * Runs the 7 graph-content PR gates against an arbitrary in-memory
 * Dataset and returns a structured report.
 *
 * Used as preflight + postflight by every {@code kg_edit} write
 * subcommand: load the live Dataset, apply the proposed delta to a
 * clone, call {@link #runAll(Dataset, Path)}, refuse the write if any
 * gate fails. Author sees the violating rows.
 *
 * The 7 gates wrapped here:
 *   - 5 zero-row queries: contradictions, dangling, cycles, collisions,
 *     inverse-edges (under kg/queries/...)
 *   - query-smoke: every kg/queries/&#42;&#42;/*.rq parses + executes
 *   - SHACL: kg/ontology/shapes.ttl validates against the data
 *
 * Out of scope: the file-level sync gates (summary, rfc_card,
 * index_pages, per-RFC spec.md diff tests) — those compare derived
 * markdown to source, not graph properties.
 */
public final class GateHarness {

    /** The 4 generic RFC-corpus consistency gates — SPARQL bundled as
     *  classpath resources with spec (not under the consumer kg-root).
     *  Resource path layout mirrors the source under rdf/queries/. */
    private static final Map<String, String> CONSISTENCY_RESOURCES = Map.of(
        "dangling",        "/queries/consistency/dangling-references.rq",
        "cycles",          "/queries/consistency/circular-deps.rq",
        "collisions",      "/queries/consistency/diagnostic-collisions.rq",
        "inverse_edges",   "/queries/consistency/inverse-edges.rq"
    );

    /** Domain zero-row gate(s) — SPARQL under the consumer's kg-root (the
     *  claims layer is domain-specific, not part of the generic framework). */
    private static final Map<String, String> DOMAIN_ZERO_ROW = Map.of(
        "contradictions",  "queries/claims/contradictions.rq"
    );

    /** Classpath resource of the framework SHACL shapes (ships with spec). */
    private static final String SHAPES_RESOURCE = "/ontology/shapes.ttl";

    private GateHarness() {}

    /** Run every gate against the given Dataset. Returns one
     *  {@link Result} per gate in stable order. */
    public static List<Result> runAll(Dataset ds, Path kgRoot) {
        List<Result> out = new ArrayList<>();
        // contradictions (domain, kg-root) then the 4 framework consistency
        // gates (resources) — preserves the original declared order.
        out.add(runZeroRow(ds, kgRoot, "contradictions", DOMAIN_ZERO_ROW.get("contradictions")));
        for (String name : List.of("dangling", "cycles", "collisions", "inverse_edges")) {
            out.add(runZeroRowResource(ds, name, CONSISTENCY_RESOURCES.get(name)));
        }
        out.add(runQuerySmoke(ds, kgRoot));
        out.add(runShacl(ds, kgRoot));
        return out;
    }

    /** Zero-row gate whose SPARQL is a classpath resource (framework gate). */
    static Result runZeroRowResource(Dataset ds, String name, String resourcePath) {
        try {
            return runZeroRowSparql(ds, name, Gates.readSparqlResource(resourcePath));
        } catch (Exception e) {
            return new Result(name, false, -1,
                "query failed to execute: " + e.getClass().getSimpleName() + ": " + e.getMessage(),
                List.of());
        }
    }

    // -----------------------------------------------------------------------
    // Individual gate runners
    // -----------------------------------------------------------------------

    static Result runZeroRow(Dataset ds, Path kgRoot, String name, String relPath) {
        try {
            return runZeroRowSparql(ds, name, Gates.readSparql(kgRoot.resolve(relPath)));
        } catch (Exception e) {
            return new Result(name, false, -1,
                "query failed to execute: " + e.getClass().getSimpleName() + ": " + e.getMessage(),
                List.of());
        }
    }

    /** Execute a zero-row gate query against the dataset (shared by the
     *  file-based and resource-based variants). */
    static Result runZeroRowSparql(Dataset ds, String name, String sparql) {
        List<Map<String, String>> rows = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext() && rows.size() < 50) {
                QuerySolution s = rs.next();
                Map<String, String> row = new LinkedHashMap<>();
                for (var it = s.varNames(); it.hasNext(); ) {
                    String v = it.next();
                    RDFNode node = s.get(v);
                    row.put(v, node == null ? "null" : node.toString());
                }
                rows.add(row);
            }
            int extra = 0;
            while (rs.hasNext()) { rs.next(); extra++; }
            int total = rows.size() + extra;
            return new Result(name, total == 0, total,
                total == 0 ? "0 rows" : total + " row(s)" + (extra > 0 ? " (showing first " + rows.size() + ")" : ""),
                rows);
        }
    }

    static Result runQuerySmoke(Dataset ds, Path kgRoot) {
        Path queriesDir = kgRoot.resolve("queries");
        List<String> failures = new ArrayList<>();
        int ok = 0;
        try {
            for (Path q : collectQueries(queriesDir)) {
                try {
                    String sparql = Gates.readSparql(q);
                    try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
                        ResultSet rs = exec.execSelect();
                        while (rs.hasNext()) rs.next();
                    }
                    ok++;
                } catch (Throwable t) {
                    failures.add(kgRoot.relativize(q).toString()
                        + " — " + t.getClass().getSimpleName() + ": " + t.getMessage());
                }
            }
        } catch (IOException e) {
            return new Result("query_smoke", false, -1,
                "could not walk " + queriesDir + ": " + e.getMessage(), List.of());
        }
        List<Map<String, String>> failureRows = new ArrayList<>();
        for (String f : failures) failureRows.add(Map.of("failure", f));
        return new Result("query_smoke", failures.isEmpty(), failures.size(),
            failures.isEmpty()
                ? ok + " queries parse + execute"
                : failures.size() + " of " + (ok + failures.size()) + " queries failed",
            failureRows);
    }

    static Result runShacl(Dataset ds, Path kgRoot) {
        Model unionModel = ModelFactory.createDefaultModel();
        unionModel.add(ds.getDefaultModel());
        ds.listNames().forEachRemaining(name -> unionModel.add(ds.getNamedModel(name)));

        // SHACL shapes ship with spec as a classpath resource.
        Model shapesModel = ModelFactory.createDefaultModel();
        try (InputStream in = GateHarness.class.getResourceAsStream(SHAPES_RESOURCE)) {
            if (in == null) {
                return new Result("shacl", false, -1,
                    "shapes.ttl resource not on classpath: " + SHAPES_RESOURCE, List.of());
            }
            RDFDataMgr.read(shapesModel, in, Lang.TURTLE);
        } catch (IOException e) {
            return new Result("shacl", false, -1,
                "failed to read shapes resource: " + e.getMessage(), List.of());
        }
        Shapes shapes = Shapes.parse(shapesModel.getGraph());
        Graph data = unionModel.getGraph();
        ValidationReport report = ShaclValidator.get().validate(shapes, data);

        List<Map<String, String>> rows = new ArrayList<>();
        int shown = 0;
        for (var e : report.getEntries()) {
            if (shown++ >= 50) break;
            Map<String, String> row = new LinkedHashMap<>();
            row.put("severity", e.severity().toString());
            row.put("focus", String.valueOf(e.focusNode()));
            row.put("message", String.valueOf(e.message()));
            rows.add(row);
        }
        int total = report.getEntries().size();
        return new Result("shacl", report.conforms(), total,
            report.conforms() ? "shapes.ttl conforms" : total + " violation(s)",
            rows);
    }

    private static List<Path> collectQueries(Path queriesDir) throws IOException {
        List<Path> out = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(queriesDir)) {
            stream
                .filter(p -> p.toString().endsWith(".rq"))
                .filter(p -> !p.getFileName().toString().startsWith("_"))
                .sorted()
                .forEach(out::add);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Result record + brief renderers
    // -----------------------------------------------------------------------

    /** Structured result for one gate. {@code rows} is empty on pass and
     *  the violating bindings (capped) on fail. */
    public static record Result(
        String name,
        boolean passed,
        int violationCount,
        String summary,
        List<Map<String, String>> rows
    ) {
        public boolean failed() { return !passed; }
    }

    /** Pretty-print a list of results to a human-readable string. */
    public static String renderHuman(List<Result> results) {
        StringBuilder out = new StringBuilder();
        for (Result r : results) {
            out.append(r.passed ? "  ✓ " : "  ✗ ")
               .append(String.format("%-16s", r.name))
               .append(r.summary).append('\n');
            if (!r.passed) {
                int shown = Math.min(r.rows.size(), 5);
                for (int i = 0; i < shown; i++) {
                    out.append("      • ");
                    boolean first = true;
                    for (var e : r.rows.get(i).entrySet()) {
                        if (!first) out.append("  ");
                        out.append(e.getKey()).append('=').append(e.getValue());
                        first = false;
                    }
                    out.append('\n');
                }
                if (r.rows.size() > shown) {
                    out.append("      • … (").append(r.rows.size() - shown).append(" more)\n");
                }
            }
        }
        return out.toString();
    }

    public static boolean allPassed(List<Result> results) {
        return results.stream().allMatch(r -> r.passed);
    }
}
