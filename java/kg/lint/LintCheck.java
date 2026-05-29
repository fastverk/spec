package kg.lint;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;

/**
 * One semantic-quality check, defined by a SPARQL .rq file under kg/lint/.
 *
 * Frontmatter (between {@code # ---} markers, lines prefixed with {@code # })
 * carries metadata:
 *   title:        short label
 *   description:  one-line failure description
 *   severity:     "warning" or "error"
 *   tier:         T1/T2/T3/T4 (informational; not enforced)
 *   rationale:    why this check exists and how to fix
 *
 * The check fails if the SELECT query returns ≥1 row. Each row is a
 * structured violation, returned to {@link KgLint} for rendering.
 *
 * The promotion path: a check enters at {@code severity: warning}
 * (visible in `kg_lint run` but does not fail PR gates). Authors fix
 * existing violations one PR at a time. Once `kg_lint run --severity error`
 * shows zero rows for a check, the check's frontmatter is updated to
 * {@code severity: error} and it gets added to //ci:pr_gates.
 */
public final class LintCheck {

    public final String name;        // file stem, e.g. "modality-conflict"
    public final Path queryFile;
    public final String title;
    public final String description;
    public final Severity severity;
    public final String rationale;
    /** When true, KgLint runs this check against authored + reasoner-
     *  inferred triples. Default false: checks see only authored content
     *  so e.g. transitive dependsOn closures don't count as authored deps. */
    public final boolean inferred;
    public final String sparql;       // body, with frontmatter stripped

    public enum Severity { WARNING, ERROR }

    public LintCheck(String name, Path queryFile, String title, String description,
                     Severity severity, String rationale, boolean inferred, String sparql) {
        this.name = name;
        this.queryFile = queryFile;
        this.title = title;
        this.description = description;
        this.severity = severity;
        this.rationale = rationale;
        this.inferred = inferred;
        this.sparql = sparql;
    }

    /** Parse one .rq file into a LintCheck. */
    public static LintCheck load(Path file) throws IOException {
        String text = Files.readString(file);
        Map<String, String> meta = parseFrontmatter(text);
        String body = stripFrontmatter(text);
        String stem = file.getFileName().toString().replaceFirst("\\.rq$", "");
        return new LintCheck(
            stem,
            file,
            meta.getOrDefault("title", stem),
            meta.getOrDefault("description", ""),
            "error".equalsIgnoreCase(meta.get("severity")) ? Severity.ERROR : Severity.WARNING,
            meta.getOrDefault("rationale", ""),
            "true".equalsIgnoreCase(meta.get("inferred")),
            body
        );
    }

    /** Execute against a Dataset. Returns the violating rows (capped at 100
     *  for display); use {@link #runWithTotal} when the uncapped count
     *  matters for metrics. */
    public List<Map<String, String>> run(Dataset ds) {
        return runWithTotal(ds).rows;
    }

    /** Execute against a Dataset; return both (a) up to 100 rows for
     *  display, and (b) the uncapped total count. The uncapped count
     *  flows through to kg_metrics's heartbeat panel so progress is
     *  visible even when displays are capped. */
    public Result runWithTotal(Dataset ds) {
        List<Map<String, String>> rows = new ArrayList<>();
        int total = 0;
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
            ResultSet rs = exec.execSelect();
            List<String> vars = rs.getResultVars();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                total++;
                if (rows.size() < 100) {
                    Map<String, String> row = new LinkedHashMap<>();
                    for (String v : vars) {
                        row.put(v, s.contains(v) ? String.valueOf(s.get(v)) : "");
                    }
                    rows.add(row);
                }
            }
        }
        return new Result(rows, total);
    }

    public static final class Result {
        public final List<Map<String, String>> rows;  // capped at 100
        public final int total;                        // uncapped
        public Result(List<Map<String, String>> rows, int total) {
            this.rows = rows;
            this.total = total;
        }
    }

    // -----------------------------------------------------------------------
    // Frontmatter parsing
    // -----------------------------------------------------------------------

    private static final Pattern FRONTMATTER = Pattern.compile(
        "^# ---\\s*\\n((?:#[^\\n]*\\n)*?)# ---\\s*\\n",
        Pattern.MULTILINE);

    private static final Pattern KV = Pattern.compile(
        "^#\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s*(.*?)\\s*$");

    static Map<String, String> parseFrontmatter(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        Matcher m = FRONTMATTER.matcher(text);
        if (!m.find() || m.start() != 0) return out;
        for (String line : m.group(1).split("\n")) {
            Matcher kv = KV.matcher(line);
            if (kv.matches()) {
                out.put(kv.group(1).toLowerCase(), unquote(kv.group(2)));
            }
        }
        return out;
    }

    static String stripFrontmatter(String text) {
        Matcher m = FRONTMATTER.matcher(text);
        return (m.find() && m.start() == 0) ? text.substring(m.end()) : text;
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
