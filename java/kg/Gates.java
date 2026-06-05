package kg;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.apache.jena.query.Dataset;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;

/**
 * Shared helpers for the Phase-4 PR-time KG consistency gates.
 *
 * Each gate is a tiny java_test wrapping one of the public methods here.
 * The Dataset loader is reused from {@link Loader}; query files live under
 * kg/queries/<category>/*.rq and may carry a YAML frontmatter block that
 * the gate runner strips before parsing.
 *
 * The optional frontmatter format is:
 *
 *   # ---
 *   # title: ...
 *   # description: ...
 *   # ---
 *   PREFIX rfc: <...>
 *   SELECT ... WHERE { ... }
 */
public final class Gates {

    private Gates() {}

    private static final Pattern FRONTMATTER = Pattern.compile(
        "^# ---\\s*\\n(?:#.*\\n)*?# ---\\s*\\n",
        Pattern.MULTILINE);

    /** Read a .rq file and strip the optional YAML frontmatter block. */
    public static String readSparql(Path queryFile) throws IOException {
        return stripFrontmatter(Files.readString(queryFile));
    }

    /** Read a .rq query bundled as a classpath resource (the framework
     *  consistency gates ship with spec) and strip its frontmatter. */
    public static String readSparqlResource(String resourcePath) throws IOException {
        try (InputStream in = Gates.class.getResourceAsStream(resourcePath)) {
            if (in == null) {
                throw new IOException("sparql gate resource not on classpath: " + resourcePath);
            }
            return stripFrontmatter(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static String stripFrontmatter(String text) {
        Matcher m = FRONTMATTER.matcher(text);
        if (m.find() && m.start() == 0) {
            return text.substring(m.end());
        }
        return text;
    }

    /** Execute a SELECT query and return the row count. */
    public static int countRows(Dataset ds, String sparql) {
        try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(sparql), ds)) {
            ResultSet rs = exec.execSelect();
            int n = 0;
            while (rs.hasNext()) {
                rs.next();
                n++;
            }
            return n;
        }
    }
}
