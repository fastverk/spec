package kg.edit.cmd;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.QuerySolution;
import org.apache.jena.query.ResultSet;

import kg.edit.Handles;
import kg.edit.Output;

/**
 * Pretty-print all outgoing triples for one subject. Resolves the handle
 * via {@link Handles}, then emits (predicate, object) rows.
 *
 * Usage:
 *   kg_edit show RFC-0036
 *   kg_edit show "Subgraph"
 *   kg_edit show M36010
 */
public final class Show {

    private Show() {}

    public static Output.Result run(Dataset ds, String handle) {
        String bind = Handles.bindPattern(handle, "?subject");
        String q = """
            SELECT ?predicate ?object WHERE {
              %s
              ?subject ?predicate ?object .
            }
            ORDER BY ?predicate ?object
            """.formatted(bind);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("predicate", shortIri(s.getResource("predicate").getURI()));
                row.put("object",    String.valueOf(s.get("object")));
                rows.add(row);
            }
        }

        List<String> messages = new ArrayList<>();
        if (rows.isEmpty()) {
            messages.add("(no triples found for " + handle + " — " + Handles.classify(handle) + ")");
        }
        return new Output.Result(
            "show",
            Map.of("handle", handle, "kind", Handles.classify(handle).name()),
            rows,
            messages,
            rows.isEmpty() ? 1 : 0
        );
    }

    private static String shortIri(String iri) {
        int hash = iri.lastIndexOf('#');
        if (hash >= 0) return iri.substring(hash + 1);
        int slash = iri.lastIndexOf('/');
        return slash >= 0 ? iri.substring(slash + 1) : iri;
    }
}
