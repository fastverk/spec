package kg;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Stream;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;

/**
 * Single source of truth for loading the corpus into an in-memory Jena
 * Dataset, and for resolving the on-disk kg/ root in test/run/dev contexts.
 *
 * Every Java binary that reads the KG (KgReport, CrossCutting, the gate
 * runners, and the kg_edit / kg_lint / kg_metrics packages) goes through
 * these two methods so the load shape stays consistent.
 */
public final class Loader {

    private Loader() {}

    /** Classpath resource path of the framework rfc: vocabulary, bundled in
     *  this rules_spec jar (see java/BUILD.bazel resources). */
    private static final String RFC_VOCAB_RESOURCE = "/ontology/aion-rfc.ttl";

    /**
     * Load the framework rfc: vocabulary (a classpath resource shipped with
     * rules_spec) plus the consumer's domain TBox (aion-domain / aion-claims)
     * and every TTL under turtle/, turtle-domain/, turtle-claims/ from kgRoot,
     * into one in-memory Dataset. Files are read in sorted order so blank-node
     * IDs are deterministic across runs.
     */
    /**
     * Read the framework rfc: vocabulary — a classpath resource shipped with
     * rules_spec — into {@code model}. Tools that build their own corpus model
     * (e.g. KgReasoner) call this instead of path-reading ontology/aion-rfc.ttl.
     */
    public static void loadFrameworkVocab(Model model) throws IOException {
        try (InputStream in = Loader.class.getResourceAsStream(RFC_VOCAB_RESOURCE)) {
            if (in == null) {
                throw new IOException(
                    "rfc: vocabulary resource not on classpath: " + RFC_VOCAB_RESOURCE +
                    " (is the rules_spec loader jar a dep?)");
            }
            RDFDataMgr.read(model, in, Lang.TURTLE);
        }
    }

    public static Dataset loadDataset(Path kgRoot) throws IOException {
        Model model = ModelFactory.createDefaultModel();
        // Framework vocabulary ships with rules_spec (classpath), not under
        // the consumer's kg-root.
        loadFrameworkVocab(model);
        for (Path p : List.of(
                kgRoot.resolve("ontology/aion-domain.ttl"),
                kgRoot.resolve("ontology/aion-claims.ttl"))) {
            if (Files.isRegularFile(p)) RDFDataMgr.read(model, p.toUri().toString());
        }
        for (String dir : List.of("turtle", "turtle-domain", "turtle-claims")) {
            Path d = kgRoot.resolve(dir);
            if (!Files.isDirectory(d)) continue;
            try (Stream<Path> stream = Files.list(d)
                    .filter(p -> p.toString().endsWith(".ttl"))
                    .sorted()) {
                for (Path p : (Iterable<Path>) stream::iterator) {
                    RDFDataMgr.read(model, p.toUri().toString());
                }
            }
        }
        return DatasetFactory.create(model);
    }

    /**
     * Load the authored corpus PLUS the kg_reasoner-derived closure
     * (kg/inferred/*.ttl). Used by tools that benefit from transitive
     * closure or other inferences — kg_lint (semantic checks), the
     * upcoming claim-contradiction analyzer, kg_metrics dashboards.
     *
     * Markdown generators that emit per-RFC views deliberately use
     * {@link #loadDataset(Path)} instead so they see only authored
     * deps; transitive closures are computed downstream by the Lean
     * inference engine (Aion.Logic.Inference).
     */
    public static Dataset loadDatasetWithInferred(Path kgRoot) throws IOException {
        Dataset ds = loadDataset(kgRoot);
        Path inf = kgRoot.resolve("inferred");
        if (!Files.isDirectory(inf)) return ds;
        Model model = ds.getDefaultModel();
        try (Stream<Path> stream = Files.list(inf)
                .filter(p -> p.toString().endsWith(".ttl"))
                .sorted()) {
            for (Path p : (Iterable<Path>) stream::iterator) {
                RDFDataMgr.read(model, p.toUri().toString());
            }
        }
        return ds;
    }

    /**
     * Locate kg/ via, in order: $KG_ROOT, $TEST_SRCDIR + $TEST_WORKSPACE
     * (Bazel test runfiles), $BUILD_WORKSPACE_DIRECTORY (`bazel run`), or
     * fail loudly. Never falls back to cwd silently — that hid bugs in
     * earlier prototypes.
     */
    public static Path resolveKgRoot() {
        String override = System.getenv("KG_ROOT");
        if (override != null && !override.isEmpty()) return Paths.get(override);
        String testSrcDir = System.getenv("TEST_SRCDIR");
        String testWorkspace = System.getenv("TEST_WORKSPACE");
        if (testSrcDir != null && testWorkspace != null) {
            return Paths.get(testSrcDir, testWorkspace, "kg");
        }
        String workspace = System.getenv("BUILD_WORKSPACE_DIRECTORY");
        if (workspace != null) return Paths.get(workspace, "kg");
        throw new IllegalStateException(
            "Could not locate kg/ directory. Set KG_ROOT, or run via bazel.");
    }
}
