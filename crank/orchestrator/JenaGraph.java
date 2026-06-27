package dev.fastverk.crank.orchestrator;

import dev.fastverk.crank.v1.Term;
import dev.fastverk.crank.v1.Triple;
import java.util.Collection;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Property;
import org.apache.jena.rdf.model.Resource;

/**
 * Bridges the crank's in-memory proto graph to a Jena model so the real
 * {@code //corpus} ARQ SPARQL can run over it. The orchestrator's prefixed IRIs
 * ({@code rfc:dependsOn}, {@code rc:RFC-0900}) expand to the aion-rfc / ratio
 * namespaces the corpus queries assume, so a query written against the corpus
 * vocabulary evaluates identically here.
 */
public final class JenaGraph {
  /** The aion-rfc ontology namespace — the corpus queries' default {@code :}. */
  public static final String RFC = "https://aion.savvi.io/ontology/rfc#";
  /** The ratio corpus namespace — the corpus queries' {@code rc:}. */
  public static final String RC = "https://ratio.dev/corpus/";
  /** Prefix header prepended to every query body. */
  public static final String PREFIXES = "PREFIX rfc: <" + RFC + ">\nPREFIX rc: <" + RC + ">\n";

  private JenaGraph() {}

  /** Materialize the asserted triples into an in-memory Jena model. */
  public static Model toModel(Collection<Triple> graph) {
    Model m = ModelFactory.createDefaultModel();
    for (Triple t : graph) {
      Resource s = m.createResource(expand(t.getSubject()));
      Property p = m.createProperty(expand(t.getPredicate()));
      Term o = t.getObject();
      if (o.hasLiteral()) {
        m.add(s, p, o.getLiteral());
      } else {
        m.add(s, p, m.createResource(expand(o)));
      }
    }
    return m;
  }

  /** Run a SELECT (with the standard prefixes prepended) and return the row count. */
  public static int count(Model m, String body) {
    try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(PREFIXES + body), m)) {
      ResultSet rs = exec.execSelect();
      int n = 0;
      while (rs.hasNext()) {
        rs.next();
        n++;
      }
      return n;
    }
  }

  /** Run an ASK (with the standard prefixes prepended). */
  public static boolean ask(Model m, String body) {
    try (QueryExecution exec = QueryExecutionFactory.create(QueryFactory.create(PREFIXES + body), m)) {
      return exec.execAsk();
    }
  }

  /** Expand a prefixed term to a full IRI string (rfc:/rc: known; else verbatim). */
  static String expand(Term term) {
    String v =
        term.hasIri() ? term.getIri() : term.hasVariable() ? term.getVariable() : term.getLiteral();
    int c = v.indexOf(':');
    if (c > 0) {
      String prefix = v.substring(0, c);
      String local = v.substring(c + 1);
      if (prefix.equals("rfc")) {
        return RFC + local;
      }
      if (prefix.equals("rc")) {
        return RC + local;
      }
    }
    return v;
  }
}
