package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;

import kg.Loader;
import kg.edit.Output;
import kg.edit.WriteOps;

/**
 * Add a defined term to an RFC, promoted to a stable IRI.
 *
 *   kg_edit scaffold-term --rfc RFC-NNNN --name "..." --definition "..."
 *
 * Generates the IRI rfc:RFC-NNNN/term/&lt;slug&gt; (slug derived from the
 * lowercased, hyphenated name) so the term is addressable for later
 * refactors instead of being a blank node.
 *
 * Refuses if the same name is already defined within the RFC.
 */
public final class ScaffoldTerm {

    private static final String RFC_NS = "https://aion.savvi.io/ontology/rfc#";
    private static final String RFC_INST = "https://aion.savvi.io/rfc/";

    private ScaffoldTerm() {}

    public static Output.Result run(Path kgRoot, String rfcId, String name, String definition, boolean apply) throws IOException {
        if (name == null || name.isBlank())       return error("--name is required");
        if (definition == null || definition.isBlank()) return error("--definition is required");
        Path file = WriteOps.turtleFileFor(kgRoot, rfcId);
        if (!Files.isRegularFile(file)) return error("RFC TTL not found: " + file);

        Dataset live = Loader.loadDataset(kgRoot);
        if (termExistsInRfc(live, rfcId, name)) {
            return error("term '" + name + "' is already defined in " + rfcId);
        }

        String slug = slugify(name);
        String termIri = RFC_INST + rfcId + "/term/" + slug;

        Model orig = WriteOps.loadFile(file);
        Model neu  = ScaffoldDiagnostic.cloneModel(orig);
        Resource doc  = neu.createResource(RFC_INST + rfcId);
        Resource term = neu.createResource(termIri);
        Property typeP = neu.createProperty("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
        Resource termType = neu.createResource(RFC_NS + "Term");
        Property nameP = neu.createProperty(RFC_NS + "name");
        Property defP  = neu.createProperty(RFC_NS + "definition");
        Property defines = neu.createProperty(RFC_NS + "definesTerm");

        neu.add(term, typeP, termType);
        neu.add(term, nameP, name);
        neu.add(term, defP, definition);
        neu.add(doc, defines, term);

        WriteOps.Result wr = WriteOps.applyAndCheck(
            List.of(new WriteOps.Edit(file, orig, neu)), kgRoot, apply);
        return ScaffoldDiagnostic.finalize(wr, "scaffold-term",
            Map.of("rfc", rfcId, "name", name, "iri", termIri, "applied", wr.wrote()));
    }

    private static boolean termExistsInRfc(Dataset ds, String rfcId, String name) {
        String q = "PREFIX rfc: <" + RFC_NS + ">\n"
            + "ASK { <" + RFC_INST + rfcId + "> rfc:definesTerm ?t . ?t rfc:name \"" + escape(name) + "\" }";
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            return exec.execAsk();
        }
    }

    private static String slugify(String name) {
        String s = name.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "-")
            .replaceAll("(^-|-$)", "");
        return s.isEmpty() ? "term" : s;
    }

    private static String escape(String s) { return s.replace("\\", "\\\\").replace("\"", "\\\""); }
    private static Output.Result error(String msg) {
        return new Output.Result("scaffold-term", Map.of(), List.of(), List.of(msg), 2);
    }
}
