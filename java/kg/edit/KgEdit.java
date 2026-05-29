package kg.edit;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import org.apache.jena.query.Dataset;

import kg.Loader;
import kg.edit.cmd.AddEdge;
import kg.edit.cmd.Query;
import kg.edit.cmd.RemoveTerm;
import kg.edit.cmd.ScaffoldDiagnostic;
import kg.edit.cmd.ScaffoldRule;
import kg.edit.cmd.ScaffoldTerm;
import kg.edit.cmd.Search;
import kg.edit.cmd.Show;
import kg.edit.cmd.WhoReferences;

/**
 * Single CLI entry point for KG authoring operations.
 *
 *   kg_edit <subcommand> [flags] [args...]
 *
 * Read subcommands (v1):    search, who-references, show, query
 * Write subcommands (v1.1): add-edge, scaffold-diagnostic,
 *                           scaffold-term, scaffold-rule
 *
 * Common flags:
 *   --json       emit machine-readable Result JSON instead of human table
 *   --kg-root P  override kg/ location (otherwise resolved via Loader)
 *   --apply      enable writes for non-additive operations (additive
 *                ops also accept --apply but default to writing)
 *   --dry-run    suppress writes even for additive ops (preview only)
 *
 * Run via Bazel:
 *   bazel run //kg/java/edit:kg_edit -- search "Subgraph"
 *   bazel run //kg/java/edit:kg_edit -- add-edge --from RFC-A --predicate dependsOn --to RFC-B --apply
 *   bazel run //kg/java/edit:kg_edit -- scaffold-rule --rfc RFC-0036 --section 4 --modality MUST --predicate "..." --emits M36010 --apply
 */
public final class KgEdit {

    public static void main(String[] args) throws Exception {
        Output.Mode mode = Output.Mode.HUMAN;
        Path kgRootOverride = null;
        boolean apply = false;
        boolean dryRun = false;
        List<String> rest = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--json"     -> mode = Output.Mode.JSON;
                case "--kg-root"  -> kgRootOverride = Paths.get(args[++i]);
                case "--apply"    -> apply = true;
                case "--dry-run"  -> dryRun = true;
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

        // Read commands need a Dataset directly. Write commands resolve
        // their own (against the live state) inside WriteOps.
        Dataset ds = isReadCommand(subcommand) ? Loader.loadDataset(kgRoot) : null;
        boolean wantWrite = apply && !dryRun;

        Output.Result result = switch (subcommand) {
            case "search"               -> doSearch(ds, sargs);
            case "who-references"       -> doWhoReferences(ds, sargs);
            case "show"                 -> doShow(ds, sargs);
            case "query"                -> doQuery(ds, sargs);
            case "add-edge"             -> doAddEdge(kgRoot, sargs, wantWrite);
            case "scaffold-diagnostic"  -> doScaffoldDiagnostic(kgRoot, sargs, wantWrite);
            case "scaffold-term"        -> doScaffoldTerm(kgRoot, sargs, wantWrite);
            case "scaffold-rule"        -> doScaffoldRule(kgRoot, sargs, wantWrite);
            case "remove-term"          -> doRemoveTerm(kgRoot, sargs, wantWrite);
            case "help", "--help"       -> { usage(); yield ok("help"); }
            default -> {
                System.err.println("unknown subcommand: " + subcommand);
                usage();
                System.exit(2);
                yield null;
            }
        };

        Output.write(result, mode, System.out);
        System.exit(result.exitCode());
    }

    private static boolean isReadCommand(String c) {
        return List.of("search", "who-references", "show", "query").contains(c);
    }

    // -----------------------------------------------------------------------
    // Read dispatchers (unchanged from v1)
    // -----------------------------------------------------------------------

    private static Output.Result doSearch(Dataset ds, List<String> args) {
        if (args.size() != 1) throw new IllegalArgumentException("usage: search \"<text>\"");
        return Search.run(ds, args.get(0));
    }

    private static Output.Result doWhoReferences(Dataset ds, List<String> args) {
        if (args.size() != 1) throw new IllegalArgumentException("usage: who-references <handle>");
        return WhoReferences.run(ds, args.get(0));
    }

    private static Output.Result doShow(Dataset ds, List<String> args) {
        if (args.size() != 1) throw new IllegalArgumentException("usage: show <handle>");
        return Show.run(ds, args.get(0));
    }

    private static Output.Result doQuery(Dataset ds, List<String> args) throws IOException {
        if (args.size() == 2 && args.get(0).equals("--file")) {
            Path p = Paths.get(args.get(1));
            return Query.run(ds, Query.readFromFile(p), p.toString());
        }
        if (args.size() == 2 && args.get(0).equals("-e")) {
            return Query.run(ds, args.get(1), "<inline>");
        }
        throw new IllegalArgumentException("usage: query --file <file.rq> | query -e \"<sparql>\"");
    }

    // -----------------------------------------------------------------------
    // Write dispatchers (v1.1)
    // -----------------------------------------------------------------------

    private static Output.Result doAddEdge(Path kgRoot, List<String> args, boolean apply) throws IOException {
        Map flags = parseFlags(args, List.of("--from", "--predicate", "--to"), List.of());
        return AddEdge.run(kgRoot,
            flags.req("--from"), flags.req("--predicate"), flags.req("--to"), apply);
    }

    private static Output.Result doScaffoldDiagnostic(Path kgRoot, List<String> args, boolean apply) throws IOException {
        Map flags = parseFlags(args, List.of("--rfc", "--code", "--severity", "--description"), List.of());
        return ScaffoldDiagnostic.run(kgRoot,
            flags.req("--rfc"), flags.req("--code"), flags.req("--severity"),
            flags.req("--description"), apply);
    }

    private static Output.Result doScaffoldTerm(Path kgRoot, List<String> args, boolean apply) throws IOException {
        Map flags = parseFlags(args, List.of("--rfc", "--name", "--definition"), List.of());
        return ScaffoldTerm.run(kgRoot,
            flags.req("--rfc"), flags.req("--name"), flags.req("--definition"), apply);
    }

    private static Output.Result doScaffoldRule(Path kgRoot, List<String> args, boolean apply) throws IOException {
        Map flags = parseFlags(args,
            List.of("--rfc", "--section", "--modality", "--predicate"),
            List.of("--rationale", "--emits"));
        return ScaffoldRule.run(kgRoot,
            flags.req("--rfc"), flags.req("--section"), flags.req("--modality"),
            flags.req("--predicate"), flags.opt("--rationale"), flags.opt("--emits"),
            apply);
    }

    private static Output.Result doRemoveTerm(Path kgRoot, List<String> args, boolean apply) throws IOException {
        Map flags = parseFlags(args, List.of("--rfc", "--name"), List.of());
        return RemoveTerm.run(kgRoot, flags.req("--rfc"), flags.req("--name"), apply);
    }

    // -----------------------------------------------------------------------
    // Flag parser
    // -----------------------------------------------------------------------

    private static Map parseFlags(List<String> args, List<String> required, List<String> optional) {
        Map m = new Map();
        for (int i = 0; i < args.size(); i++) {
            String a = args.get(i);
            if (required.contains(a) || optional.contains(a)) {
                if (i + 1 >= args.size()) throw new IllegalArgumentException("flag missing value: " + a);
                m.put(a, args.get(++i));
            } else {
                throw new IllegalArgumentException("unknown flag: " + a);
            }
        }
        for (String r : required) {
            if (!m.has(r)) throw new IllegalArgumentException("required flag missing: " + r);
        }
        return m;
    }

    static final class Map {
        private final java.util.Map<String, String> m = new java.util.HashMap<>();
        void put(String k, String v) { m.put(k, v); }
        boolean has(String k) { return m.containsKey(k); }
        String req(String k) { return m.get(k); }
        String opt(String k) { return m.get(k); }
    }

    private static Output.Result ok(String name) {
        return new Output.Result(name, java.util.Map.of(), List.of(), List.of(), 0);
    }

    private static void usage() {
        System.err.println("""
            kg_edit — Aion KG authoring CLI

            usage: kg_edit [--json] [--kg-root PATH] [--apply|--dry-run] <subcommand> [args...]

            read subcommands:
              search "<text>"
              who-references <handle>
              show <handle>
              query --file <file.rq> | query -e "<sparql>"

            write subcommands (require --apply to commit; otherwise dry-run):
              add-edge --from RFC-A --predicate <p> --to RFC-B
              scaffold-diagnostic --rfc RFC-NNNN --code MNNxxx --severity Error --description "..."
              scaffold-term --rfc RFC-NNNN --name "..." --definition "..."
              scaffold-rule --rfc RFC-NNNN --section <N> --modality MUST --predicate "..."
                            [--rationale "..."] [--emits MNNxxx]

            handles:
              RFC-NNNN, MNNxxx (diagnostic code), KP-NNN, "<term name>", or <full IRI>

            flags:
              --json        emit machine-readable JSON instead of a human table
              --kg-root P   override kg/ location (otherwise auto-resolved)
              --apply       commit writes for write subcommands (otherwise dry-run)
              --dry-run     force dry-run even with --apply
            """);
    }
}
