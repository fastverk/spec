package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;

import kg.Loader;
import kg.edit.Output;
import kg.edit.WriteOps;

/**
 * Remove a defined term from an RFC.
 *
 *   kg_edit remove-term --rfc RFC-NNNN --name "..."
 *
 * Drops the {@code :definesTerm} edge from the Document and every triple
 * whose subject is the term itself (handling both blank-node and named
 * IRI terms). Destructive: dry-run by default, requires {@code --apply}.
 */
public final class RemoveTerm {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String RFC_INST = "https://aion.savvi.io/rfc/";

    private RemoveTerm() {}

    public static Output.Result run(Path kgRoot, String rfcId, String name, boolean apply) throws IOException {
        if (name == null || name.isBlank()) return error("--name is required");
        Path file = WriteOps.turtleFileFor(kgRoot, rfcId);
        if (!Files.isRegularFile(file)) return error("RFC TTL not found: " + file);

        Dataset live = Loader.loadDataset(kgRoot);
        List<String> termIris = lookupTerms(live, rfcId, name);
        if (termIris.isEmpty()) return error("no term named '" + name + "' defined in " + rfcId);

        Model orig = WriteOps.loadFile(file);
        Model neu  = ScaffoldDiagnostic.cloneModel(orig);

        Resource doc = neu.createResource(RFC_INST + rfcId);
        Property defines = neu.createProperty(RFC_NS + "definesTerm");

        // Two flavors to cover: stable IRI terms and blank-node terms.
        // Stable IRIs were collected via SPARQL above (they have the same
        // string IRI in `neu`). Blank nodes have unstable labels across
        // loads, so they're matched in `neu` by name (the field that
        // identifies the duplicate within this file).
        Property nameP = neu.createProperty(RFC_NS + "name");
        List<Resource> toRemove = new ArrayList<>();
        StmtIterator nameIt = neu.listStatements(null, nameP, name);
        while (nameIt.hasNext()) {
            Resource s = nameIt.nextStatement().getSubject();
            // Verify it's actually defined by this doc.
            if (neu.contains(doc, defines, s)) toRemove.add(s);
        }
        if (toRemove.isEmpty()) {
            return error("term '" + name + "' not present in " + file
                + " (live KG saw " + termIris.size() + " match(es) but file did not)");
        }

        for (Resource term : toRemove) {
            neu.removeAll(term, null, null);
            neu.remove(doc, defines, term);
        }

        WriteOps.Result wr = WriteOps.applyAndCheck(
            List.of(new WriteOps.Edit(file, orig, neu)), kgRoot, apply);
        return ScaffoldDiagnostic.finalize(wr, "remove-term",
            Map.of("rfc", rfcId, "name", name, "removed_count", toRemove.size(),
                   "applied", wr.wrote()));
    }

    private static List<String> lookupTerms(Dataset ds, String rfcId, String name) {
        String q = "PREFIX rfc: <" + RFC_NS + ">\n"
            + "SELECT ?t WHERE { <" + RFC_INST + rfcId + "> rfc:definesTerm ?t . "
            + "?t rfc:name \"" + name.replace("\\","\\\\").replace("\"","\\\"") + "\" }";
        List<String> out = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            var rs = exec.execSelect();
            while (rs.hasNext()) out.add(String.valueOf(rs.next().get("t")));
        }
        return out;
    }

    private static Output.Result error(String msg) {
        return new Output.Result("remove-term", Map.of(), List.of(), List.of(msg), 2);
    }
}
