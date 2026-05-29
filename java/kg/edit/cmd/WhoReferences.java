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
 * Incoming-reference enumeration. For a given handle (RFC, term name,
 * diagnostic code, KP, or full IRI), find every triple that points at it
 * and return (predicate, source-subject, source-RFC) rows.
 *
 * Usage:
 *   kg_edit who-references RFC-0036
 *   kg_edit who-references "Subgraph"
 *   kg_edit who-references M36010
 */
public final class WhoReferences {

    private WhoReferences() {}

    public static Output.Result run(Dataset ds, String handle) {
        String bind = Handles.bindPattern(handle, "?target");
        String q = """
            PREFIX rfc: <https://aion.savvi.io/ontology/rfc#>
            SELECT DISTINCT ?predicate ?source ?sourceRfc WHERE {
              %s
              ?source ?predicate ?target .
              FILTER (?source != ?target)
              OPTIONAL {
                ?doc a rfc:Document ; rfc:rfcId ?sourceRfc .
                { ?doc rfc:hasSection*/rfc:containsRule* ?source }
                UNION { ?doc rfc:introducesDiagnostic ?source }
                UNION { ?doc rfc:definesTerm ?source }
                UNION { FILTER(?doc = ?source) }
              }
            }
            ORDER BY ?predicate ?sourceRfc ?source
            LIMIT 500
            """.formatted(bind);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("predicate",  shortIri(s.getResource("predicate").getURI()));
                row.put("sourceRfc",  s.contains("sourceRfc") ? s.getLiteral("sourceRfc").getString() : "");
                row.put("source",     String.valueOf(s.get("source")));
                rows.add(row);
            }
        }

        return new Output.Result(
            "who-references",
            Map.of("handle", handle, "kind", Handles.classify(handle).name()),
            rows,
            List.of(),
            0
        );
    }

    private static String shortIri(String iri) {
        int hash = iri.lastIndexOf('#');
        if (hash >= 0) return iri.substring(hash + 1);
        int slash = iri.lastIndexOf('/');
        return slash >= 0 ? iri.substring(slash + 1) : iri;
    }
}
