package kg.edit;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;
import org.apache.jena.riot.RDFDataMgr;

import kg.GateHarness;
import kg.Loader;
import kg.Writer;

/**
 * Common machinery for kg_edit write subcommands.
 *
 * Each write proceeds in three phases:
 *   1. {@link #loadFile} the target TTL into a separate Model.
 *   2. The subcommand mutates that Model.
 *   3. {@link #applyAndCheck} clones the live Dataset, swaps the original
 *      file's triples for the mutated ones, runs all 7 graph-content gates
 *      against the proposed clone. If clean and {@code apply} is set, the
 *      mutated Model is serialized back to TTL via {@link Writer#writeStable}.
 *
 * The dry-run default for destructive ops (and explicit --apply) is enforced
 * by the subcommand, not here. This class is the apply mechanism only.
 */
public final class WriteOps {

    private WriteOps() {}

    /** Map an RFC ID to its Phase-1 TTL file. */
    public static Path turtleFileFor(Path kgRoot, String rfcId) {
        return kgRoot.resolve("turtle").resolve(rfcId + ".ttl");
    }

    /** Load a single TTL file as a standalone Model. */
    public static Model loadFile(Path file) throws IOException {
        Model m = ModelFactory.createDefaultModel();
        RDFDataMgr.read(m, file.toUri().toString());
        return m;
    }

    /** A staged write: which file to update and what its new contents are.
     *  Multiple stages can be applied atomically. */
    public static record Edit(Path file, Model originalContent, Model newContent) {}

    /**
     * Build the proposed Dataset (live - originals + new), run all 7
     * graph-content gates, and if clean (and apply == true), serialize each
     * Edit's newContent back to its file via the deterministic Writer.
     */
    public static Result applyAndCheck(List<Edit> edits, Path kgRoot, boolean apply) throws IOException {
        Dataset live = Loader.loadDataset(kgRoot);
        Model union = ModelFactory.createDefaultModel();
        union.add(live.getDefaultModel());
        live.listNames().forEachRemaining(n -> union.add(live.getNamedModel(n)));
        for (Edit e : edits) {
            union.remove(e.originalContent);
            union.add(e.newContent);
        }
        Dataset proposed = DatasetFactory.create(union);
        List<GateHarness.Result> gates = GateHarness.runAll(proposed, kgRoot);
        boolean clean = GateHarness.allPassed(gates);

        List<Map<String, Object>> ops = new ArrayList<>();
        for (Edit e : edits) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("file", e.file.toString());
            entry.put("added", diff(e.newContent, e.originalContent));
            entry.put("removed", diff(e.originalContent, e.newContent));
            ops.add(entry);
        }

        boolean wrote = false;
        if (clean && apply) {
            for (Edit e : edits) Writer.writeStableTo(e.newContent, e.file);
            wrote = true;
        }
        return new Result(ops, gates, clean, wrote);
    }

    /** Triples in {@code a} not in {@code b} (as a list of "s p o" strings). */
    private static List<Map<String, String>> diff(Model a, Model b) {
        List<Map<String, String>> out = new ArrayList<>();
        StmtIterator it = a.listStatements();
        while (it.hasNext()) {
            Statement s = it.nextStatement();
            if (b.contains(s)) continue;
            Map<String, String> row = new LinkedHashMap<>();
            row.put("s", String.valueOf(s.getSubject()));
            row.put("p", String.valueOf(s.getPredicate()));
            row.put("o", String.valueOf(s.getObject()));
            out.add(row);
            if (out.size() >= 50) break;
        }
        return out;
    }

    /** Bundled result of a write attempt. */
    public static record Result(
        List<Map<String, Object>> ops,
        List<GateHarness.Result> gates,
        boolean gatesPassed,
        boolean wrote
    ) {}
}
