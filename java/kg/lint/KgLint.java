package kg.lint;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.apache.jena.query.Dataset;

import kg.Loader;

/**
 * Aion KG semantic linter.
 *
 *   kg_lint run [--check c1,c2,...] [--severity error|warning|all] [--json]
 *   kg_lint list [--json]
 *   kg_lint explain <check>
 *
 * Each check is a single .rq file under {@code kg/lint/<topic>/<name>.rq}
 * with YAML frontmatter declaring severity, title, description, and
 * rationale (see {@link LintCheck}).
 *
 * Promotion path: a check enters at {@code severity: warning} (visible
 * in run output but doesn't fail). Authors fix violations one PR at a
 * time. Once a check returns zero rows, it gets promoted to
 * {@code severity: error} in its frontmatter and added to //ci:pr_gates.
 *
 * This is the ratchet that lets the corpus's logical resolution grow
 * monotonically over time.
 */
public final class KgLint {

    public static void main(String[] args) throws Exception {
        boolean json = false;
        Path kgRootOverride = null;
        List<String> rest = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--json"     -> json = true;
                case "--kg-root"  -> kgRootOverride = Path.of(args[++i]);
                default           -> rest.add(args[i]);
            }
        }
        if (rest.isEmpty()) {
            usage();
            System.exit(2);
        }
        String subcommand = rest.get(0);
        List<String> sargs = rest.subList(1, rest.size());

        Path kgRoot = kgRootOverride != null ? kgRootOverride : Loader.resolveKgRoot();
        Path lintDir = kgRoot.resolve("lint");
        List<LintCheck> all = loadChecks(lintDir);

        switch (subcommand) {
            case "run"     -> doRun(kgRoot, all, sargs, json);
            case "list"    -> doList(all, json);
            case "explain" -> doExplain(all, sargs);
            case "help", "--help" -> { usage(); System.exit(0); }
            default -> {
                System.err.println("unknown subcommand: " + subcommand);
                usage();
                System.exit(2);
            }
        }
    }

    // -----------------------------------------------------------------------
    // run
    // -----------------------------------------------------------------------

    private static void doRun(Path kgRoot, List<LintCheck> all, List<String> args, boolean json) throws IOException {
        String severityFilter = "all";
        List<String> nameFilter = null;
        for (int i = 0; i < args.size(); i++) {
            switch (args.get(i)) {
                case "--severity" -> severityFilter = args.get(++i);
                case "--check"    -> nameFilter = List.of(args.get(++i).split(","));
                default -> throw new IllegalArgumentException("unknown flag: " + args.get(i));
            }
        }

        List<LintCheck> selected = new ArrayList<>();
        for (LintCheck c : all) {
            if (nameFilter != null && !nameFilter.contains(c.name)) continue;
            if ("error".equals(severityFilter) && c.severity != LintCheck.Severity.ERROR) continue;
            if ("warning".equals(severityFilter) && c.severity != LintCheck.Severity.WARNING) continue;
            selected.add(c);
        }

        // Each check chooses its dataset via its `inferred:` frontmatter
        // flag. Default: authored only (so transitive deps, OWL-MICRO
        // closures don't count as authored content). Opt-in:
        // `inferred: true` (used by orphan-diagnostic so rule-derived
        // :emits triples reduce its count).
        Dataset dsAuthored = Loader.loadDataset(kgRoot);
        Dataset dsInferred = Loader.loadDatasetWithInferred(kgRoot);

        List<Map<String, Object>> reports = new ArrayList<>();
        int errorRows = 0;
        for (LintCheck c : selected) {
            Dataset ds = c.inferred ? dsInferred : dsAuthored;
            LintCheck.Result result = c.runWithTotal(ds);
            Map<String, Object> rep = new LinkedHashMap<>();
            rep.put("name", c.name);
            rep.put("severity", c.severity.name().toLowerCase());
            rep.put("title", c.title);
            rep.put("violations", result.total);
            rep.put("rows", result.rows);
            reports.add(rep);
            if (c.severity == LintCheck.Severity.ERROR) errorRows += result.total;
        }

        if (json) {
            System.out.println(jsonRunReport(reports));
        } else {
            renderRunHuman(reports, System.out);
        }
        // Exit non-zero only if an ERROR check has violations; warnings never fail.
        System.exit(errorRows == 0 ? 0 : 1);
    }

    private static void renderRunHuman(List<Map<String, Object>> reports, PrintStream out) {
        if (reports.isEmpty()) { out.println("(no checks selected)"); return; }
        for (Map<String, Object> r : reports) {
            int violations = (Integer) r.get("violations");
            String marker = switch (((String) r.get("severity"))) {
                case "error"   -> violations == 0 ? "  ✓ " : "  ✗ ";
                case "warning" -> violations == 0 ? "  ✓ " : "  ! ";
                default -> "  ? ";
            };
            out.printf("%s%-26s %s — %d row%s%n",
                marker,
                (String) r.get("name"),
                "[" + r.get("severity") + "]",
                violations,
                violations == 1 ? "" : "s");
            @SuppressWarnings("unchecked")
            List<Map<String, String>> rows = (List<Map<String, String>>) r.get("rows");
            int shown = Math.min(rows.size(), 5);
            for (int i = 0; i < shown; i++) {
                out.print("       • ");
                boolean first = true;
                for (var e : rows.get(i).entrySet()) {
                    if (!first) out.print("  ");
                    first = false;
                    out.print(e.getKey() + "=" + truncate(e.getValue(), 60));
                }
                out.println();
            }
            if (rows.size() > shown) out.println("       • … (" + (rows.size() - shown) + " more)");
        }
        out.println();
        long warnTotal = reports.stream()
            .filter(r -> "warning".equals(r.get("severity")))
            .mapToLong(r -> (Integer) r.get("violations"))
            .sum();
        long errTotal = reports.stream()
            .filter(r -> "error".equals(r.get("severity")))
            .mapToLong(r -> (Integer) r.get("violations"))
            .sum();
        out.printf("%d check%s · %d warning row%s · %d error row%s%n",
            reports.size(), reports.size() == 1 ? "" : "s",
            warnTotal, warnTotal == 1 ? "" : "s",
            errTotal, errTotal == 1 ? "" : "s");
    }

    private static String jsonRunReport(List<Map<String, Object>> reports) {
        // Minimal JSON encoder — matches kg.edit.Output.toJson shape but
        // we don't want a cross-package dep, so a tiny inline serializer.
        return "{\"subcommand\":\"run\",\"reports\":" + jsonArr(reports) + "}";
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    private static void doList(List<LintCheck> all, boolean json) {
        if (json) {
            List<Map<String, Object>> rows = new ArrayList<>();
            for (LintCheck c : all) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("name", c.name);
                r.put("severity", c.severity.name().toLowerCase());
                r.put("title", c.title);
                r.put("description", c.description);
                rows.add(r);
            }
            System.out.println("{\"subcommand\":\"list\",\"checks\":" + jsonArr(rows) + "}");
            return;
        }
        for (LintCheck c : all) {
            System.out.printf("  %-26s [%s] %s%n", c.name, c.severity.name().toLowerCase(), c.title);
        }
        System.out.println();
        System.out.println(all.size() + " check(s) registered.");
    }

    // -----------------------------------------------------------------------
    // explain
    // -----------------------------------------------------------------------

    private static void doExplain(List<LintCheck> all, List<String> args) {
        if (args.size() != 1) {
            System.err.println("usage: explain <check-name>");
            System.exit(2);
        }
        LintCheck c = all.stream().filter(x -> x.name.equals(args.get(0))).findFirst().orElse(null);
        if (c == null) {
            System.err.println("unknown check: " + args.get(0));
            System.err.println("known: " + all.stream().map(x -> x.name).toList());
            System.exit(2);
        }
        System.out.println("# " + c.title);
        System.out.println("severity: " + c.severity.name().toLowerCase());
        if (!c.description.isEmpty()) System.out.println();
        if (!c.description.isEmpty()) System.out.println(c.description);
        if (!c.rationale.isEmpty()) {
            System.out.println();
            System.out.println("Rationale:");
            System.out.println("  " + c.rationale);
        }
        System.out.println();
        System.out.println("Query (" + c.queryFile + "):");
        System.out.println();
        for (String line : c.sparql.split("\n")) System.out.println("  " + line);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    public static List<LintCheck> loadChecks(Path lintDir) throws IOException {
        if (!Files.isDirectory(lintDir)) return List.of();
        List<LintCheck> out = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(lintDir)) {
            for (Path p : (Iterable<Path>) walk
                    .filter(p -> p.toString().endsWith(".rq"))
                    .filter(p -> !p.getFileName().toString().startsWith("_"))
                    .sorted()::iterator) {
                out.add(LintCheck.load(p));
            }
        }
        return out;
    }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    @SuppressWarnings("unchecked")
    private static String jsonArr(List<?> list) {
        StringBuilder b = new StringBuilder("[");
        boolean first = true;
        for (Object o : list) {
            if (!first) b.append(',');
            first = false;
            if (o instanceof Map) b.append(jsonObj((Map<String, Object>) o));
            else if (o instanceof List) b.append(jsonArr((List<?>) o));
            else b.append(jsonStr(String.valueOf(o)));
        }
        return b.append(']').toString();
    }

    @SuppressWarnings("unchecked")
    private static String jsonObj(Map<String, Object> m) {
        StringBuilder b = new StringBuilder("{");
        boolean first = true;
        for (var e : m.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(jsonStr(e.getKey())).append(':');
            Object v = e.getValue();
            if (v instanceof Map) b.append(jsonObj((Map<String, Object>) v));
            else if (v instanceof List) b.append(jsonArr((List<?>) v));
            else if (v instanceof Number || v instanceof Boolean) b.append(v);
            else if (v == null) b.append("null");
            else b.append(jsonStr(String.valueOf(v)));
        }
        return b.append('}').toString();
    }

    private static String jsonStr(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    private static void usage() {
        System.err.println("""
            kg_lint — Aion KG semantic linter

            usage: kg_lint [--json] [--kg-root PATH] <subcommand> [args...]

            subcommands:
              run [--check c1,c2,...] [--severity error|warning|all]
                  Execute checks. Exits non-zero only if an ERROR check has violations.
              list
                  Show every registered check with its severity.
              explain <name>
                  Show one check's title, description, rationale, and query body.

            checks live under kg/lint/<topic>/<name>.rq with YAML frontmatter
            (title, description, severity, tier, rationale).
            """);
    }
}
