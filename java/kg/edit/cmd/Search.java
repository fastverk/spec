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

import kg.edit.Output;

/**
 * Substring search across the corpus's textual properties (label, title,
 * description, definition, summary, name, predicate). Returns each
 * matched subject with its class and owning RFC.
 *
 * Usage:
 *   kg_edit search "Subgraph"
 *   kg_edit search --json "Resource"
 */
public final class Search {

    private Search() {}

    public static Output.Result run(Dataset ds, String text) {
        String escaped = text.replace("\\", "\\\\").replace("\"", "\\\"");
        String q = """
            PREFIX rfc: <https://aion.savvi.io/ontology/rfc#>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            SELECT DISTINCT ?subject ?cls ?rfcId ?field ?value WHERE {
              ?subject ?p ?value .
              FILTER(isLiteral(?value))
              FILTER(CONTAINS(LCASE(STR(?value)), LCASE("%s")))
              FILTER(?p IN (
                rdfs:label,
                rfc:title, rfc:name, rfc:description, rfc:definition,
                rfc:summary, rfc:predicate
              ))
              BIND(REPLACE(STR(?p), "^.*[#/]", "") AS ?field)
              OPTIONAL { ?subject a ?cls }
              OPTIONAL {
                ?doc a rfc:Document ; rfc:rfcId ?rfcId .
                { ?doc rfc:hasSection*/rfc:containsRule* ?subject }
                UNION { ?doc rfc:introducesDiagnostic ?subject }
                UNION { ?doc rfc:definesTerm ?subject }
                UNION { FILTER(?doc = ?subject) }
              }
            }
            ORDER BY ?rfcId ?subject
            LIMIT 200
            """.formatted(escaped);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(q), ds)) {
            ResultSet rs = exec.execSelect();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("rfc",     s.contains("rfcId") ? s.getLiteral("rfcId").getString() : "");
                row.put("class",   s.contains("cls")   ? shortClass(s.getResource("cls").getURI()) : "");
                row.put("subject", String.valueOf(s.get("subject")));
                row.put("field",   s.contains("field") ? s.getLiteral("field").getString() : "");
                row.put("value",   s.get("value").asLiteral().getLexicalForm());
                rows.add(row);
            }
        }

        return new Output.Result(
            "search",
            Map.of("query", text),
            rows,
            List.of(),
            0
        );
    }

    private static String shortClass(String iri) {
        int hash = iri.lastIndexOf('#');
        if (hash >= 0) return iri.substring(hash + 1);
        int slash = iri.lastIndexOf('/');
        return slash >= 0 ? iri.substring(slash + 1) : iri;
    }
}
