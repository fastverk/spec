package kg.edit.cmd;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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
import org.apache.jena.rdf.model.RDFNode;

import kg.edit.Output;

/**
 * Run an arbitrary SPARQL SELECT/ASK against the corpus.
 *
 * Usage:
 *   kg_edit query --file kg/queries/structure/dependency-graph.rq
 *   kg_edit query -e "SELECT ?s WHERE { ?s a rfc:Document } LIMIT 5"
 */
public final class Query {

    private Query() {}

    public static Output.Result run(Dataset ds, String sparql, String origin) {
        List<Map<String, Object>> rows = new ArrayList<>();
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
            ResultSet rs = exec.execSelect();
            List<String> vars = rs.getResultVars();
            while (rs.hasNext()) {
                QuerySolution s = rs.next();
                Map<String, Object> row = new LinkedHashMap<>();
                for (String v : vars) {
                    RDFNode node = s.get(v);
                    row.put(v, node == null ? "" : String.valueOf(node));
                }
                rows.add(row);
            }
        }
        return new Output.Result(
            "query",
            Map.of("origin", origin),
            rows,
            List.of(),
            0
        );
    }

    public static String readFromFile(Path file) throws IOException {
        return Files.readString(file);
    }
}
