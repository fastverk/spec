package grounding;

import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ResultSet;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;

/**
 * The adversarial control — proof that the gates are real, not decorative.
 *
 * A gate that never rejects anything proves nothing. This plants each of the
 * corpus consistency violations (a dependsOn cycle, a dangling reference, a
 * MUST/MUST_NOT contradiction) into a model and asserts the gate SPARQL detects
 * every one — while a clean model trips none of them. Together with the
 * grounding gate (which rejects fabricated proofs), this is what lets the Spec
 * Score mean something: the fleet can't raise it by adding unsound claims,
 * because the gate would catch them (and a failing gate voids the score).
 *
 * java_test (use_testrunner=False): a non-zero exit fails the test.
 */
public final class AdversarialGateCheck {
  static final String RFC = "https://aion.savvi.io/ontology/rfc#";
  static final String RC = "https://ratio.dev/corpus/";
  static final String RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  static final String PREFIXES = "PREFIX rfc: <" + RFC + ">\nPREFIX rc: <" + RC + ">\n";

  // The three consistency gates (same patterns as //corpus:*_gates_*).
  static final String CYCLES = "SELECT ?x WHERE { ?x (rfc:dependsOn)+ ?x }";
  static final String DANGLING =
      "SELECT ?o WHERE { ?s rfc:dependsOn ?o . FILTER NOT EXISTS { ?o ?p ?z } }";
  static final String CONTRADICTIONS =
      "SELECT ?n WHERE { ?n rfc:modality rfc:MUST . ?n rfc:modality rfc:MUST_NOT }";

  public static void main(String[] args) {
    // Positive control: a clean DAG trips no gate.
    Model clean = ModelFactory.createDefaultModel();
    typed(clean, "A");
    typed(clean, "B");
    typed(clean, "C");
    dep(clean, "A", "B");
    dep(clean, "B", "C");
    check(count(clean, CYCLES) == 0, "clean: no cycle");
    check(count(clean, DANGLING) == 0, "clean: no dangling reference");
    check(count(clean, CONTRADICTIONS) == 0, "clean: no contradiction");

    // Adversarial: plant one of each violation.
    Model bad = ModelFactory.createDefaultModel();
    typed(bad, "X");
    typed(bad, "Y");
    dep(bad, "X", "Y");
    dep(bad, "Y", "X"); // ← cycle
    dep(bad, "X", "Ghost"); // ← dangling: Ghost is never defined (no triples)
    bad.add(res(bad, "claim1"), bad.createProperty(RDF, "type"), res(bad, RFC + "NormativeStatement"));
    bad.add(res(bad, "claim1"), bad.createProperty(RFC, "modality"), bad.createResource(RFC + "MUST"));
    bad.add(res(bad, "claim1"), bad.createProperty(RFC, "modality"), bad.createResource(RFC + "MUST_NOT")); // ← contradiction

    check(count(bad, CYCLES) >= 1, "gate must DETECT the dependsOn cycle");
    check(count(bad, DANGLING) >= 1, "gate must DETECT the dangling reference");
    check(count(bad, CONTRADICTIONS) >= 1, "gate must DETECT the MUST/MUST_NOT contradiction");

    System.out.println(
        "adversarial OK — the gates reject a planted cycle, dangling reference, and "
            + "MUST/MUST_NOT contradiction; the clean DAG trips none.");
  }

  private static void typed(Model m, String local) {
    m.add(res(m, local), m.createProperty(RDF, "type"), m.createResource(RFC + "Document"));
  }

  private static void dep(Model m, String s, String o) {
    m.add(res(m, s), m.createProperty(RFC, "dependsOn"), res(m, o));
  }

  private static org.apache.jena.rdf.model.Resource res(Model m, String local) {
    return m.createResource(local.startsWith("http") ? local : RC + local);
  }

  private static int count(Model m, String body) {
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

  private static void check(boolean cond, String msg) {
    if (!cond) {
      throw new RuntimeException("CHECK FAILED: " + msg);
    }
  }
}
