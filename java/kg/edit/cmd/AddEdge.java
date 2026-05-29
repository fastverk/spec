package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;

import kg.GateHarness;
import kg.edit.Output;
import kg.edit.WriteOps;

/**
 * Add one cross-RFC edge between two RFC documents.
 *
 *   kg_edit add-edge --from RFC-A --predicate dependsOn --to RFC-B
 *
 * Writes a single triple to the source RFC's TTL. For the predicate
 * {@code extendedBy} (which has an inverse {@code extends} that the
 * inverse-edges gate enforces), also adds the corresponding back-edge
 * to the target RFC's TTL — otherwise preflight rejects the change.
 *
 * Idempotent: if the edge already exists, exits 0 with "no change".
 */
public final class AddEdge {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String RFC_INST = "https://aion.savvi.io/rfc/";

    private static final List<String> ALLOWED_PREDICATES = List.of(
        "dependsOn", "extends", "extendedBy", "supersedes", "refines", "closes", "references"
    );

    private AddEdge() {}

    public static Output.Result run(Path kgRoot, String fromRfc, String predicate, String toRfc, boolean apply) throws IOException {
        if (!ALLOWED_PREDICATES.contains(predicate)) {
            return error("predicate must be one of: " + ALLOWED_PREDICATES);
        }
        Path fromFile = WriteOps.turtleFileFor(kgRoot, fromRfc);
        Path toFile   = WriteOps.turtleFileFor(kgRoot, toRfc);
        if (!Files.isRegularFile(fromFile)) return error("source RFC TTL not found: " + fromFile);
        if (!Files.isRegularFile(toFile))   return error("target RFC TTL not found: " + toFile);

        Model fromOrig = WriteOps.loadFile(fromFile);
        Model fromNew  = cloneModel(fromOrig);

        Resource a = fromNew.createResource(RFC_INST + fromRfc);
        Resource b = fromNew.createResource(RFC_INST + toRfc);
        Property p = fromNew.createProperty(RFC_NS + predicate);

        boolean addedFrom = !fromNew.contains(a, p, b);
        if (addedFrom) fromNew.add(a, p, b);

        List<WriteOps.Edit> edits = new ArrayList<>();
        edits.add(new WriteOps.Edit(fromFile, fromOrig, fromNew));

        // extendedBy gets paired with `extends` on the other side so the
        // inverse-edges gate doesn't fail preflight.
        boolean addedInverse = false;
        if (predicate.equals("extendedBy")) {
            Model toOrig = WriteOps.loadFile(toFile);
            Model toNew  = cloneModel(toOrig);
            Resource bRes = toNew.createResource(RFC_INST + toRfc);
            Resource aRes = toNew.createResource(RFC_INST + fromRfc);
            Property extendsP = toNew.createProperty(RFC_NS + "extends");
            if (!toNew.contains(bRes, extendsP, aRes)) {
                toNew.add(bRes, extendsP, aRes);
                addedInverse = true;
            }
            edits.add(new WriteOps.Edit(toFile, toOrig, toNew));
        }

        if (!addedFrom && !addedInverse) {
            return new Output.Result("add-edge",
                Map.of("from", fromRfc, "predicate", predicate, "to", toRfc, "applied", false),
                List.of(),
                List.of("(no change — edge already present)"),
                0);
        }

        WriteOps.Result wr = WriteOps.applyAndCheck(edits, kgRoot, apply);

        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> op : wr.ops()) {
            @SuppressWarnings("unchecked")
            List<Map<String, String>> added = (List<Map<String, String>>) op.get("added");
            for (Map<String, String> t : added) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("file", op.get("file"));
                r.put("op", "add");
                r.put("triple", t.get("s") + " " + shortPred(t.get("p")) + " " + t.get("o"));
                rows.add(r);
            }
        }

        List<String> messages = new ArrayList<>();
        if (!wr.gatesPassed()) {
            messages.add("preflight gates FAILED — refusing to write:");
            messages.add(GateHarness.renderHuman(wr.gates()));
        } else if (apply && wr.wrote()) {
            messages.add("write applied to " + edits.size() + " file(s); all 7 gates pass.");
        } else {
            messages.add("dry-run: all 7 gates pass.");
            messages.add("re-run with --apply to write.");
        }

        return new Output.Result(
            "add-edge",
            Map.of("from", fromRfc, "predicate", predicate, "to", toRfc, "applied", wr.wrote()),
            rows,
            messages,
            wr.gatesPassed() ? 0 : 1
        );
    }

    private static Model cloneModel(Model m) {
        Model copy = org.apache.jena.rdf.model.ModelFactory.createDefaultModel();
        copy.setNsPrefixes(m.getNsPrefixMap());
        copy.add(m);
        return copy;
    }

    private static String shortPred(String p) {
        int i = Math.max(p.lastIndexOf('#'), p.lastIndexOf('/'));
        return i >= 0 ? p.substring(i + 1) : p;
    }

    private static Output.Result error(String msg) {
        return new Output.Result("add-edge", Map.of(), List.of(), List.of(msg), 2);
    }
}
